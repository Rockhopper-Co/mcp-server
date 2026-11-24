/**
 * ENG-9660 (plan 121 SP31) — what `enroll_file` SAYS about an Office file in
 * Google Drive. Every state names the next step, or says there is none: no
 * answer ends without one (ENG-1647). The vocabulary is in
 * `enrollment-conversion.ts`.
 */

import type { EnrollmentConversionFields } from './enrollment-conversion.js';

/** Who the sentence is for, because the next step depends on it. */
export interface SentenceContext {
  /**
   * The Drive id the user named. W6 reads the link row by EITHER id, so the
   * converted Google file's own id answers `converted` too, and that file is
   * not an Office file: it gets no "converted this Office file" sentence.
   */
  namedId: string;
  /**
   * Whether this user holds the file: tracked or hidden for them, or a write
   * just ran for them. `search_files` lists only the caller's own files
   * (`search.ts`), so it is a next step only for a user who holds it.
   */
  callerHasFile: boolean;
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
 * there is nothing to say about one.
 */
export function conversionSentence(
  fields: EnrollmentConversionFields,
  context: SentenceContext,
): string {
  const { conversion, convertedFile } = fields;
  if (!conversion) return '';
  switch (conversion.state) {
    case 'converted':
      if (convertedFile?.platformId === context.namedId) return '';
      return (
        'Rockhopper converted this Office file to ' +
        (convertedFile
          ? `${TRACKED_AS[convertedFile.fileType] ?? 'a Google file'}, ` +
            `"${convertedFile.name}" (id ${convertedFile.platformId}), `
          : 'Google format ') +
        'and tracks that Google file. The original in Google Drive is ' +
        'unchanged and is not tracked; use the `fileMsId` in this answer ' +
        'with every other tool.'
      );
    case 'kept_as_office':
      return (
        'Google could not convert it, so Rockhopper tracks it as the Office ' +
        'file it is.'
      );
    case 'pending':
      return context.callerHasFile
        ? 'Rockhopper is converting it to Google format, and until that ' +
            'finishes it still opens as the Office file. There is nothing to ' +
            'do: check again with `search_files` shortly.'
        : 'Rockhopper is converting it to Google format, and it is not added ' +
            'for this user yet. Nothing was changed: call `enroll_file` again ' +
            'with the same arguments in a few minutes, once the conversion ' +
            'finishes, to add it.';
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

/**
 * The note for an answer whose `fileMsId` is an Office original's Drive id
 * because no other id exists yet: the conversion re-points the record at a
 * new Google file, so the id changes (plan 121 W10 keeps `msId`, re-points
 * `platformId`).
 */
export const ID_CHANGES_NOTE =
  'Rockhopper converts an Excel, Word or PowerPoint file in Google Drive to ' +
  'Google format and then tracks the Google file under a new id. Until then ' +
  "this answer's `fileMsId` is the original's; afterwards take the Google " +
  "file's id from `search_files` or `list_files`.";
