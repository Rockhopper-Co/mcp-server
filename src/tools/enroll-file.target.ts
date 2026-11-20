import type { ApiClient } from '../api-client.js';
import { classifyEnrollmentFailure } from '../enrollment.js';
import {
  conversionDetail,
  conversionFieldsOf,
  outcomeForState,
  type EnrollmentConversion,
  type EnrollmentConversionFields,
} from '../enrollment-conversion.js';
import {
  conversionSentence,
  ID_CHANGES_NOTE,
  type SentenceContext,
} from '../enrollment-conversion.text.js';
import {
  classifySmartsheetEnrollment,
  enrolledSheetIds,
} from '../smartsheet-discovery.js';
import type { EnrollmentInfo, EnrollmentState, FileProvider } from '../types.js';
import type { EnrollAnswer } from './enroll-file.contract.js';

/**
 * ENG-9660 — the half of `enroll_file` that runs before any write: which file
 * was named, what Rockhopper already holds for it, the id and name an answer
 * hands back, and the answers that need no write. Split out of
 * `enroll-file.ts` so neither file crosses 300 lines.
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
  /** ENG-9660 — the record's own name, when `info/bulk` served it. */
  recordName: string | null;
}

/** What the door said about this file on the 201, when it said anything. */
export interface DoorAnswer {
  msId?: string;
  conversion?: EnrollmentConversion | null;
}

export function classify(error: unknown, provider: 'smartsheet' | undefined) {
  const sheet =
    provider === 'smartsheet' ? classifySmartsheetEnrollment(error) : null;
  return sheet ?? classifyEnrollmentFailure(error);
}

function fromInfo(info: EnrollmentInfo | undefined) {
  return { recordName: info?.name ?? null, ...conversionFieldsOf(info) };
}

const NO_RECORD = {
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
 * The id an answer hands back, by ONE rule: the id `list_files` and
 * `search_files` show (`platformId`), so a model holds one id per file.
 * - W6 named the converted Google file: its id, never the original's.
 * - The door joined a converted record whose Google id this user was not
 *   shown (W6 withholds it until they can open it): the record's `msId`, the
 *   only id the answer has that resolves (`FileUserAccessGuard` matches `msId`
 *   or `platformId`; the conversion keeps `msId`).
 * - Otherwise the provider's own id, as shipped: the record's `platformId`
 *   (Drive or sheet id), or the Graph id that IS a Microsoft record's `msId`.
 */
export function answerId(target: Target, door?: DoorAnswer): string {
  if (target.convertedFile?.platformId) return target.convertedFile.platformId;
  if (door?.conversion?.state === 'converted' && door.msId) return door.msId;
  return target.fileId;
}

/** The name an answer uses: the converted file's, when there is one. */
export function answerName(target: Target): string {
  return target.convertedFile?.name ?? target.recordName ?? target.name;
}

/** An Office type Rockhopper converts when it is in Google Drive (plan 121 E3). */
const OFFICE_ORIGINAL = /\.(xlsx|xlsm|docx|pptx)$/i;

/**
 * Whether the id handed back is an Office original's Drive id that the
 * conversion will replace: a Google file, no other id to give, and a
 * conversion still ahead (in progress, waiting, or not started for a file
 * whose name is an Office type). Said explicitly: otherwise a fresh `.docx`
 * hands the model an id that stops resolving the moment the conversion lands.
 */
export function idChangesOnConversion(
  target: Target,
  conversion: EnrollmentConversion | null | undefined,
  id: string,
): boolean {
  if (target.provider !== 'google' || id !== target.fileId) return false;
  const state = conversion?.state;
  if (state === 'pending' || state === 'waiting_for_member') return true;
  return state === undefined && OFFICE_ORIGINAL.test(target.name);
}

/** The answer for a held conversion, before or after the write. */
export function heldAnswer(
  outcome: 'conversion_pending' | 'conversion_refused',
  fields: EnrollmentConversionFields,
  context: SentenceContext & { lead: string; detail: Record<string, unknown> },
): EnrollAnswer {
  const sentence = conversionSentence(fields, context);
  return {
    outcome,
    ...(outcome === 'conversion_refused' ? { isError: true } : {}),
    text: `${context.lead} ${sentence}`,
    detail: { ...context.detail, ...conversionDetail(fields) },
  };
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
  const id = answerId(target);
  const changes = idChangesOnConversion(target, target.conversion, id);
  const detail = {
    fileMsId: id,
    name: name || null,
    ...conversionDetail(target),
    ...(changes ? { idChangesOnConversion: true } : {}),
  };
  const context: SentenceContext = {
    namedId: target.fileId,
    callerHasFile: target.state !== 'not_enrolled',
  };
  const withConversion = (text: string) =>
    [text, conversionSentence(target, context), changes ? ID_CHANGES_NOTE : '']
      .filter(Boolean)
      .join(' ');
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
        ),
        detail,
      };
    case 'conversion_pending':
    case 'conversion_refused':
      return heldAnswer(known, target, {
        ...context,
        lead:
          known === 'conversion_pending'
            ? `"${name || 'That file'}" is not tracked yet.`
            : `"${name || 'That file'}" was not added.`,
        // Nothing was added, so there is no id to warn about.
        detail: { fileMsId: id, name: name || null },
      });
    default: {
      const exhaustive: never = known;
      return exhaustive;
    }
  }
}
