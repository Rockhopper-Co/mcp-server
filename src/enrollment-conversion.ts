/**
 * ENG-9660 (plan 121 SP31) — what `enroll_file` knows about an Office file in
 * Google Drive. The sentences it says about it live in
 * `enrollment-conversion.text.ts`.
 *
 * Rockhopper converts an Excel, Word or PowerPoint file enrolled from Google
 * Drive to Google Sheets, Docs or Slides and tracks the converted Google file.
 * The original is left untouched in Drive and is not tracked. So the file a
 * user names by its link is often NOT the record Rockhopper holds, and an
 * answer that hands back the original's id hands the model an id that no
 * other tool resolves once the conversion lands.
 *
 * Mirrored, not imported, for the reason `types.ts` gives: this package ships
 * over npm and cannot depend on the backend tree. Two wire shapes:
 * - `POST /enrolled-files/info/bulk`'s answer for a Drive id that has a
 *   conversion link row (plan 121 contract W6), read BEFORE any write;
 * - the DOOR's answer on the 201 of `POST /enrolled-files` and `batch` (plan
 *   121 D8): each per-file outcome carries `conversion: { state, reason }`
 *   beside the unchanged outcome word, as backend ENG-9399 (every enrollment
 *   door converts) produces it (`QueuedEnrollmentFileOutcome extends
 *   ConversionAnswerFields`, `dto/enrolled-file-conversion-state.dto.ts`).
 */

import type { EnrollOutcome } from './enrollment.js';
import type {
  EnrollmentInfo,
  EnrollmentState,
  QueuedEnrollmentFile,
} from './types.js';

/**
 * The five states a conversion is SERVED as (W6, W7). The backend stores two
 * more and serves neither: `moved` is served as `converted`, and `superseded`
 * (a converted file that was deleted and converted again) is never served.
 */
export type ConversionState =
  | 'pending'
  | 'converted'
  | 'waiting_for_member'
  | 'refused'
  | 'kept_as_office';

export interface EnrollmentConversion {
  state: ConversionState;
  /**
   * Why it waits or was refused; null or absent for every other state. A bare
   * string, like `patScope`: the vocabulary grows on the server first, and a
   * reason this package has never heard of is still said, never dropped.
   */
  reason?: string | null;
}

/** The Google file an original became (W6 `convertedFile`). */
export interface ConvertedFile {
  platformId: string;
  fileType: string;
  name: string;
  editorUrl: string | null;
}

/**
 * The two fields `info/bulk` adds (W6). Optional: a backend that predates the
 * conversion sends neither, and that reads exactly as "no conversion".
 */
export interface EnrollmentConversionFields {
  conversion: EnrollmentConversion | null;
  convertedFile: ConvertedFile | null;
}

/** Read the W6 fields off one `info/bulk` entry, or nulls when none came. */
export function conversionFieldsOf(
  info: EnrollmentInfo | undefined,
): EnrollmentConversionFields {
  const served = info as
    | (EnrollmentInfo & Partial<EnrollmentConversionFields>)
    | undefined;
  return {
    conversion: served?.conversion ?? null,
    convertedFile: served?.convertedFile ?? null,
  };
}

/** One per-file outcome of an enroll 201, with the door's conversion (D8). */
export type ServedEnrollmentFile = QueuedEnrollmentFile & {
  conversion?: EnrollmentConversion | null;
};

/**
 * The door's conversion answer, or `undefined` when the door said nothing (a
 * backend before plan 121, or no per-file outcome at all). `null` is a door
 * that said "no conversion"; the two are kept apart so that silence falls
 * back to the lookup taken before the write, as every ENG-2536 field does.
 */
export function serverConversionOf(
  file: QueuedEnrollmentFile | null,
): EnrollmentConversion | null | undefined {
  if (!file || !('conversion' in file)) return undefined;
  return (file as ServedEnrollmentFile).conversion ?? null;
}

/** What `enroll_file` can answer before it writes anything. */
export type KnownOutcome = Extract<
  EnrollOutcome,
  | 'already_enrolled'
  | 'restore_confirmation_required'
  | 'conversion_pending'
  | 'conversion_refused'
>;

/**
 * The outcome an already-known enrollment state implies, before any write.
 *
 * The conversion is read FIRST and by name, in a switch with a `never` arm, so
 * a sixth state cannot be added to {@link ConversionState} without this failing
 * to compile (the ENG-2580 shape `describeServerOutcome` also guards against):
 * - `converted`, `kept_as_office`: nothing changes here. The backend already
 *   answered `state` for the record it tracks (the converted Google file, or
 *   the Office file it kept), so today's rule applies to that record.
 * - `waiting_for_member`: nothing changes either. Enrolling again is what asks
 *   the backend to try the conversion again (plan 121 D8), so the write runs.
 * - `pending`, `refused`, while nothing is tracked: answered with no write. The
 *   backend answers pending, or the stored reason, at every door (D8), so a
 *   write would only say it again. A file that IS tracked stays tracked, so for
 *   `enrolled` and `hidden` today's rule still decides.
 */
export function outcomeForState(
  state: EnrollmentState,
  conversion: EnrollmentConversion | null = null,
): KnownOutcome | null {
  const conversionState = conversion?.state;
  switch (conversionState) {
    case undefined:
    case 'converted':
    case 'kept_as_office':
    case 'waiting_for_member':
      break;
    case 'pending':
      if (state === 'not_enrolled') return 'conversion_pending';
      break;
    case 'refused':
      if (state === 'not_enrolled') return 'conversion_refused';
      break;
    default: {
      // Compile-time exhaustiveness only. At runtime a newer backend can send a
      // state this release has never heard of, and today's rule is the answer.
      const unheard: never = conversionState;
      void unheard;
    }
  }
  if (state === 'enrolled') return 'already_enrolled';
  if (state === 'hidden') return 'restore_confirmation_required';
  return null;
}

/**
 * The outcome the DOOR's conversion answer implies after a write, or null when
 * the server's outcome word decides. Needed because the door keeps the word
 * (`enrolled` for an original it refused or found pending, ENG-9399
 * `enrolled-files.service.ts:1208-1215`) and says the conversion beside it: the
 * race where B's lookup saw no link row and the door then found A's claim.
 * A file the door answered `already_enrolled` or `restored` for IS a record,
 * so it stays that, exactly as {@link outcomeForState} keeps a tracked file.
 */
export function outcomeAfterWrite(
  serverOutcome: QueuedEnrollmentFile['outcome'] | undefined,
  conversion: EnrollmentConversion | null | undefined,
): Extract<EnrollOutcome, 'conversion_pending' | 'conversion_refused'> | null {
  if (serverOutcome === 'already_enrolled' || serverOutcome === 'restored') {
    return null;
  }
  const conversionState = conversion?.state;
  switch (conversionState) {
    case 'pending':
      return 'conversion_pending';
    case 'refused':
      return 'conversion_refused';
    case undefined:
    case 'converted':
    case 'kept_as_office':
    case 'waiting_for_member':
      return null;
    default: {
      const unheard: never = conversionState;
      void unheard;
      return null;
    }
  }
}

/** The machine-readable half, for the JSON line every answer ends with. */
export function conversionDetail(
  fields: EnrollmentConversionFields,
): Record<string, unknown> {
  const { conversion, convertedFile } = fields;
  if (!conversion) return {};
  return {
    conversion: { state: conversion.state, reason: conversion.reason ?? null },
    ...(convertedFile ? { convertedFile } : {}),
  };
}
