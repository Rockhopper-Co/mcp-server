/**
 * ENG-9660 (plan 121 SP31) — what `enroll_file` knows and says about an Office
 * file in Google Drive.
 *
 * Rockhopper converts an Excel, Word or PowerPoint file enrolled from Google
 * Drive to Google Sheets, Docs or Slides and tracks the converted Google file.
 * The original is left untouched in Drive and is not tracked. So the file a
 * user names by its link is often NOT the record Rockhopper holds, and an
 * answer that hands back the original's id hands the model an id that no
 * other tool resolves once the conversion lands.
 *
 * Mirrored, not imported, for the reason `types.ts` gives: this package ships
 * over npm and cannot depend on the backend tree. The wire shape is the
 * backend's `POST /enrolled-files/info/bulk` answer for a Drive id that has a
 * conversion link row (plan 121 contract W6).
 */

import type { EnrollOutcome } from './enrollment.js';
import type { EnrollmentInfo, EnrollmentState } from './types.js';

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

const TRACKED_AS: Readonly<Record<string, string>> = {
  gsheet_native: 'a Google Sheet',
  google_doc: 'a Google Doc',
  google_slides: 'a Google Slides deck',
};

/** What a waiting conversion needs, and from whom (SP04's waiting reasons). */
const WAITING_FOR: Readonly<Record<string, string>> = {
  no_write_grant:
    'nobody who can open it has let Rockhopper create files in their Google ' +
    'Drive. Ask the user, or a colleague who can open the file, to run ' +
    '`connect_google` and allow full Drive access',
  no_member_can_add_to_folder:
    'nobody linked to Rockhopper can add files to the Drive folder it is in. ' +
    'Someone who can add files to that folder needs to run `connect_google`',
  no_owner_domain_member:
    'nobody from the organisation that owns the file has linked a Google ' +
    'account to Rockhopper. Someone from that organisation needs to run ' +
    '`connect_google`',
};

/** Why a conversion was refused (SP03's `ConversionRefusal`). */
const REFUSED_BECAUSE: Readonly<Record<string, string>> = {
  over_size_limit: 'it is larger than Google will convert',
  over_cell_limit: 'it has more cells than a Google Sheet can hold',
  encrypted: 'it is password-protected or encrypted, so Google cannot open it',
  import_format_unsupported: 'Google cannot convert this kind of file',
  restriction_not_carried:
    "Google would not carry the original's sharing limits onto a converted " +
    'copy, and Rockhopper never makes a copy more open than the original',
};

/** A reason the table knows, in words; one it does not, said verbatim. */
function said(
  table: Readonly<Record<string, string>>,
  reason: string | null | undefined,
  unheard: (verbatim: string) => string,
): string {
  if (reason && table[reason]) return table[reason];
  return unheard(`"${reason ?? 'none given'}"`);
}

/**
 * The sentence that says what happened to the file's conversion, or `''` when
 * there is no conversion to speak of. Every state names the next step, or says
 * there is none: no answer ends without one (ENG-1647).
 */
export function conversionSentence(
  fields: EnrollmentConversionFields,
): string {
  const { conversion, convertedFile } = fields;
  if (!conversion) return '';
  switch (conversion.state) {
    case 'converted':
      return (
        'Rockhopper converted this Office file to ' +
        (convertedFile
          ? `${TRACKED_AS[convertedFile.fileType] ?? 'a Google file'}, ` +
            `"${convertedFile.name}" (id ${convertedFile.platformId}), `
          : 'Google format ') +
        'and tracks that Google file. The original in Google Drive is ' +
        "unchanged and is not tracked; use the Google file's id with every " +
        'other tool.'
      );
    case 'kept_as_office':
      return (
        'Google could not convert it, so Rockhopper tracks it as the Office ' +
        'file it is.'
      );
    case 'pending':
      return (
        'Rockhopper is converting it to Google format, and until that ' +
        'finishes it still opens as the Office file. There is nothing to do: ' +
        'check again with `search_files` shortly.'
      );
    case 'waiting_for_member':
      return (
        'Rockhopper converts Office files in Google Drive to Google format, ' +
        'and this one is waiting: ' +
        said(
          WAITING_FOR,
          conversion.reason,
          (verbatim) => `the reason Rockhopper gives is ${verbatim}`,
        ) +
        '. ' +
        'Rockhopper converts it as soon as that is done.'
      );
    case 'refused':
      return (
        'Rockhopper cannot track it, because ' +
        said(
          REFUSED_BECAUSE,
          conversion.reason,
          (verbatim) => `Google cannot convert it (reason ${verbatim})`,
        ) +
        '. Nothing was ' +
        'created and the original in Google Drive is unchanged. Retrying will ' +
        'not change the answer.'
      );
    default: {
      const unheard: never = conversion.state;
      return `Rockhopper reports this file's conversion as "${String(unheard)}".`;
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
