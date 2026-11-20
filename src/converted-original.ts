/**
 * ENG-9660 (plan 121 SP31) — an id an AI client stored before Rockhopper
 * converted an Office file in Google Drive still gets an answer.
 *
 * WHY. `list_files` hands out a file's `platformId`, and for a Google file that
 * is its Drive id. Converting an Excel, Word or PowerPoint file in Drive
 * re-points the record at the new Google file: `platformId` becomes the
 * converted file's id and `msId` is kept. The backend resolves a tool's file id
 * through `FileUserAccessGuard`, which matches `msId` OR `platformId`
 * (backend `src/guards/file-user-access.guard.ts:109-140`,
 * `global.service.ts!findWorkspaceFileByAnyId`), so the original's Drive id
 * matches neither once the conversion lands and the read is refused with the
 * uniform deny (403 "Forbidden resource"; 404 on a handler-side miss). The
 * backend deliberately adds no alias there (plan 121 DESIGN Q20).
 *
 * WHAT THIS DOES. On exactly that refusal, it asks `info/bulk` about the id as
 * a Drive id (W6: an original answers its converted record, and only to a
 * caller who can open that record) and, when the id names an original that
 * was converted, replaces the refusal with one naming the Google file's id. It
 * never retries the call against the new id: the model is told, and the user
 * stays in the loop. Anything else, including a failed lookup, rethrows the
 * original error untouched, so every answer that shipped before is unchanged.
 */

import { RockhopperApiError, type ApiClient } from './api-client.js';
import {
  conversionFieldsOf,
  type ConvertedFile,
} from './enrollment-conversion.js';
import { log } from './logger.js';

/**
 * `ApiClient` methods whose first argument is the file id a tool was given.
 *
 * Scope, said where it is decided: only these and {@link BODY_ID_METHODS} are
 * followed; any other call refused for an original's id answers its bare
 * refusal, as before. The in-app assistant is narrower still: its
 * confirmed write tools (`rename_file`, `discard_changes`, `create_version`,
 * `add_comment`) are checked by the backend's proposal seam BEFORE the tool
 * runs (`proposal-confirmation.seam.ts!fileName`, `findWorkspaceFileByAnyId`),
 * which answers "the file was not found" for an original's id, so this never
 * sees those calls there.
 */
const FILE_ID_METHODS: readonly (keyof ApiClient)[] = [
  'getEnrolledFile',
  'getFileVersions',
  'getFoldStatus',
  'getCellHistory',
  'getAnchorHistory',
  'getFileComments',
  'getReviewsForLatestVersion',
  'getDocumentChanges',
  'discardChanges',
  'updateEnrolledFile',
];

/**
 * `ApiClient` methods whose file id rides in a BODY object, by its key there:
 * `add_comment` sends `{ fileMsId, ... }` (`api-client.ts!createComment`).
 */
const BODY_ID_METHODS: Readonly<Partial<Record<keyof ApiClient, string>>> = {
  createComment: 'fileMsId',
};

/** The file id a followed call was given, or undefined for any other call. */
function fileIdOf(property: PropertyKey, args: unknown[]): string | undefined {
  if (typeof property !== 'string') return undefined;
  const first = args[0];
  if ((FILE_ID_METHODS as readonly string[]).includes(property)) {
    return typeof first === 'string' ? first : undefined;
  }
  const key = BODY_ID_METHODS[property as keyof ApiClient];
  if (!key || typeof first !== 'object' || first === null) return undefined;
  const value: unknown = (first as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

type AnyMethod = (...args: unknown[]) => Promise<unknown>;

/** The refusal an original's id earns once it was converted. */
export class ConvertedOriginalError extends RockhopperApiError {
  readonly convertedFile: ConvertedFile;
  constructor(refused: RockhopperApiError, convertedFile: ConvertedFile) {
    super(
      refused.status,
      'That id names an Office file in Google Drive that Rockhopper ' +
        `converted to Google format. Rockhopper now tracks it as ` +
        `"${convertedFile.name}" (${convertedFile.fileType}), id ` +
        `${convertedFile.platformId}: call again with that id. The original ` +
        'in Google Drive is unchanged and is not tracked. Nothing was changed.',
      refused.code,
      refused.reason,
      refused.serverMessage,
    );
    this.name = 'ConvertedOriginalError';
    this.convertedFile = convertedFile;
  }
}

/** The refusal the resource guard gives an id it cannot resolve, and no other. */
function isUnresolvedId(error: unknown): error is RockhopperApiError {
  return (
    error instanceof RockhopperApiError &&
    error.code === null &&
    (error.status === 403 || error.status === 404)
  );
}

async function convertedFileFor(
  api: ApiClient,
  fileId: string,
): Promise<ConvertedFile | null> {
  try {
    const [info] = await api.getEnrollmentInfo([fileId], 'google');
    const { conversion, convertedFile } = conversionFieldsOf(info);
    if (conversion?.state !== 'converted' || !convertedFile) return null;
    // The converted file's own id can carry `convertedFile` too (W6 reads the
    // link row by either id); that is not an original, and its refusal is real.
    return convertedFile.platformId === fileId ? null : convertedFile;
  } catch (lookupError) {
    // The lookup is advisory: when it cannot run (a backend before plan 121,
    // a refused token), the caller rethrows the ORIGINAL refusal unchanged,
    // and the lookup's own failure is logged rather than lost.
    log.warn(
      {
        event: 'converted_original_lookup_failed',
        message:
          lookupError instanceof Error ? lookupError.message : String(lookupError),
      },
      'converted_original_lookup_failed',
    );
    return null;
  }
}

/**
 * The client the read and write tools are registered with. Every other
 * method, and every success, is the wrapped client's own.
 *
 * A Proxy that binds every method to the REAL client, rather than an object
 * that inherits from it: `ApiClient` keeps mutable state (`authExpiredNotified`
 * set inside `request`), and a method run with `this` on a child object would
 * write that state onto the child, so the one-shot expiry notice could fire
 * twice. Methods are looked up at call time, so a test spy replaced after
 * registration is the one that runs.
 */
export function followConvertedOriginals(api: ApiClient): ApiClient {
  const followed = new Set<PropertyKey>([
    ...FILE_ID_METHODS,
    ...Object.keys(BODY_ID_METHODS),
  ]);
  return new Proxy(api, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as AnyMethod;
      if (!followed.has(property)) return method.bind(target);
      return async (...args: unknown[]) => {
        try {
          return await method.apply(target, args);
        } catch (error) {
          const fileId = fileIdOf(property, args);
          if (!isUnresolvedId(error) || fileId === undefined) throw error;
          const convertedFile = await convertedFileFor(target, fileId);
          throw convertedFile
            ? new ConvertedOriginalError(error, convertedFile)
            : error;
        }
      };
    },
  });
}
