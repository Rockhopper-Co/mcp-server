import type { ApiClient } from '../api-client.js';
import { classifyEnrollmentFailure } from '../enrollment.js';
import {
  conversionDetail,
  conversionFieldsOf,
  conversionSentence,
  outcomeForState,
  type EnrollmentConversionFields,
} from '../enrollment-conversion.js';
import {
  classifySmartsheetEnrollment,
  enrolledSheetIds,
} from '../smartsheet-discovery.js';
import type { EnrollmentInfo, EnrollmentState, FileProvider } from '../types.js';
import type { EnrollAnswer } from './enroll-file.contract.js';

/**
 * ENG-9660 — the half of `enroll_file` that runs before any write: which file
 * was named, what Rockhopper already holds for it, and the answers that need
 * no write. Split out of `enroll-file.ts` so neither file crosses 300 lines.
 */

/**
 * One resolved file plus what Rockhopper already knows about it.
 *
 * ENG-4958 — `provider` is carried, never assumed. `fileId` is whichever id
 * that provider uses: a Graph driveItem id, or a Drive file id. It is what the
 * enroll SENDS, and for an Office file in Drive it names the original.
 */
export interface Target extends EnrollmentConversionFields {
  provider: FileProvider;
  fileId: string;
  /** Microsoft only. Empty for a Google file, which has no drive id. */
  driveMsId: string;
  name: string;
  state: EnrollmentState;
  /**
   * ENG-9660 — the RECORD's own id and name, when the backend named them. For
   * an original Rockhopper converted these are the converted Google record's
   * (W6), and the record's id is the one that survives the conversion: the
   * conversion re-points `platformId` and keeps `msId`.
   */
  recordMsId: string | null;
  recordName: string | null;
}

export function classify(error: unknown, provider: 'smartsheet' | undefined) {
  const sheet =
    provider === 'smartsheet' ? classifySmartsheetEnrollment(error) : null;
  return sheet ?? classifyEnrollmentFailure(error);
}

function fromInfo(info: EnrollmentInfo | undefined) {
  return {
    recordMsId: info?.enrolledFileMsId ?? null,
    recordName: info?.name ?? null,
    ...conversionFieldsOf(info),
  };
}

const NO_RECORD = {
  recordMsId: null,
  recordName: null,
  conversion: null,
  convertedFile: null,
} as const;

/**
 * Turn whichever input arrived into `(identity, current state)`.
 *
 * Every branch learns the state BEFORE writing anything, because `enrolled`,
 * `hidden` and `not_enrolled`, and now the conversion states, lead to
 * different conversations.
 */
export async function resolveTarget(
  api: ApiClient,
  args: {
    url?: string;
    driveMsId?: string;
    msId?: string;
    provider?: 'smartsheet';
  },
): Promise<Target> {
  if (args.provider === 'smartsheet') {
    // A sheet is named by its id alone. For a sheet not yet added the backend
    // stamps the real name from Smartsheet during the enroll, so the empty
    // name here is a placeholder that never reaches a user.
    const sheetId = (args.msId as string).trim();
    const enrolled = await enrolledSheetIds(api);
    return {
      provider: 'smartsheet',
      fileId: sheetId,
      driveMsId: '',
      name: enrolled.get(sheetId) ?? '',
      state: enrolled.has(sheetId) ? 'enrolled' : 'not_enrolled',
      ...NO_RECORD,
    };
  }
  if (args.url) {
    const resolved = await api.resolveEnrollmentUrl(args.url);
    // ENG-4958: taken from the ANSWER, not guessed from the link shape. A
    // backend older than the Google lane sends no `provider` and only ever
    // resolves Microsoft files, so the fallback is the truth there.
    const provider = resolved.provider ?? 'microsoft';
    // ENG-9660 — only `info/bulk` carries the conversion (W6), and only a
    // Google file has one, so a Microsoft link costs no second request.
    const [info] =
      provider === 'google'
        ? await api.getEnrollmentInfo([resolved.msId], 'google')
        : [undefined];
    return {
      provider,
      fileId: resolved.msId,
      driveMsId: resolved.driveMsId ?? '',
      name: resolved.name,
      state: resolved.enrollmentState,
      ...fromInfo(info),
    };
  }

  const msId = args.msId as string;
  const driveMsId = args.driveMsId as string;
  // The id pair is Microsoft's by construction — `search_drive_files` is the
  // one honest source of it, and a Google candidate carries no drive id.
  const [info] = await api.getEnrollmentInfo([msId], 'microsoft');
  return {
    provider: 'microsoft',
    fileId: msId,
    driveMsId,
    // The bulk read withholds `name` for a hidden or stub row, and an id
    // enroll has no other source for it. The backend fills the real name from
    // Graph during the enroll, so an empty string here is a placeholder that
    // never reaches a user, not a guess at what the file is called.
    name: info?.name ?? '',
    state: info?.enrollmentState ?? 'not_enrolled',
    ...fromInfo(info),
  };
}

/**
 * The id an answer hands back: the record's own, never the original's.
 *
 * Before ENG-9660 this was `fileId`, the Drive id the user's link named. For an
 * Office file in Drive that is the ORIGINAL, which no tool resolves once the
 * conversion re-points the record; the record's `msId` resolves before and
 * after (`FileUserAccessGuard` matches `msId` or `platformId`).
 */
export function answerId(target: Target): string {
  return (
    target.recordMsId ?? target.convertedFile?.platformId ?? target.fileId
  );
}

/** The name an answer uses: the converted file's, when there is one. */
export function answerName(target: Target): string {
  return target.convertedFile?.name ?? target.recordName ?? target.name;
}

function withConversion(text: string, target: Target): string {
  const sentence = conversionSentence(target);
  return sentence ? `${text} ${sentence}` : text;
}

/**
 * The answer that needs no write, or `'write'` when one must run (a restore
 * the user confirmed included, reported as `'restore'`).
 */
export function answerBeforeWrite(
  target: Target,
  confirmRestore: boolean | undefined,
): EnrollAnswer | 'write' | 'restore' {
  const name = answerName(target);
  const detail = {
    fileMsId: answerId(target),
    name: name || null,
    ...conversionDetail(target),
  };
  const known = outcomeForState(target.state, target.conversion);
  switch (known) {
    case null:
      return 'write';
    case 'already_enrolled':
      return {
        outcome: 'already_enrolled',
        text: withConversion(
          `"${name}" is already in Rockhopper — nothing to do. Its ` +
            'versions and history are available through `get_file_versions` ' +
            'and `get_cell_history`.',
          target,
        ),
        detail: { ...detail, name },
      };
    case 'restore_confirmation_required':
      if (confirmRestore) return 'restore';
      return {
        outcome: 'restore_confirmation_required',
        text: withConversion(
          `"${name || 'That workbook'}" was previously removed from ` +
            "Rockhopper's file lists. Its versions, comments and history were " +
            'kept. Ask the user whether they want it restored, and if they do, ' +
            'call `enroll_file` again with the same arguments plus ' +
            'confirm_restore: true. Nothing has been changed.',
          target,
        ),
        detail,
      };
    case 'conversion_pending':
      return {
        outcome: 'conversion_pending',
        text: withConversion(`"${name || 'That file'}" is not tracked yet.`, target),
        detail,
      };
    case 'conversion_refused':
      return {
        outcome: 'conversion_refused',
        isError: true,
        text: withConversion(`"${name || 'That file'}" was not added.`, target),
        detail,
      };
    default: {
      const exhaustive: never = known;
      return exhaustive;
    }
  }
}
