/**
 * ENG-8069 — the CHANGE MODEL each file type has, split out of
 * `document-changes.ts` (ENG-5397) so neither file passes the 300-line cap as
 * the union grows. `document-changes.ts` re-exports everything here, so every
 * existing import keeps working.
 */

/** The change models Rockhopper tracks, mirroring the backend's
 * `DocumentType` (`enrolled-file.entity.ts`). `text` is Word; `plain_text` is
 * Markdown and plain text; `structured_data` is JSON and XML (ENG-8069). */
export type ChangeModel =
  | 'spreadsheet'
  | 'text'
  | 'presentation'
  | 'plain_text'
  | 'structured_data'
  | 'pdf';

/**
 * Every `fileType` the backend can put on the wire.
 *
 * A LOCAL UNION, deliberately, and it is what makes the switch below TOTAL: add
 * a member here without an arm in {@link changeModelForFileType} and the build
 * fails. The backend's own `documentTypeFromFileType` is exhaustive for exactly
 * this reason and ENG-3251 deleted its `default:` arm after a deck was silently
 * recorded as a spreadsheet by one.
 *
 * Mirrors `EnrolledFileType` in
 * `backend/src/resources/enrolled-files/entities/enrolled-file.entity.ts`.
 */
export type KnownFileType =
  | 'microsoft_xlsx'
  | 'microsoft_xlsm'
  | 'gdrive_xlsx'
  | 'gsheet_native'
  | 'microsoft_pptx'
  | 'microsoft_docx'
  | 'google_doc'
  | 'google_slides'
  | 'microsoft_pdf'
  | 'microsoft_md'
  | 'microsoft_txt'
  | 'microsoft_json'
  | 'microsoft_xml'
  | 'gdrive_pdf'
  | 'gdrive_md'
  | 'gdrive_txt'
  | 'gdrive_json'
  | 'gdrive_xml';

const KNOWN_FILE_TYPES: ReadonlySet<string> = new Set<KnownFileType>([
  'microsoft_xlsx',
  'microsoft_xlsm',
  'gdrive_xlsx',
  'gsheet_native',
  'microsoft_pptx',
  'microsoft_docx',
  'google_doc',
  'google_slides',
  'microsoft_pdf',
  'microsoft_md',
  'microsoft_txt',
  'microsoft_json',
  'microsoft_xml',
  'gdrive_pdf',
  'gdrive_md',
  'gdrive_txt',
  'gdrive_json',
  'gdrive_xml',
]);

/**
 * The change model a file type has, or `null` for a type this build does not
 * know.
 *
 * NULL IS NOT A DEFAULT, it is a refusal. The backend stores `fileType` in a
 * plain text column with no database enum, and this server ships to customers
 * on npm — so it is routinely OLDER than the backend it is talking to and will
 * meet a type it was compiled before. Guessing "spreadsheet" there is how the
 * defect above was built in the first place; the caller refuses instead.
 */
export function changeModelForFileType(fileType: string): ChangeModel | null {
  if (!KNOWN_FILE_TYPES.has(fileType)) return null;
  const known = fileType as KnownFileType;
  switch (known) {
    case 'microsoft_xlsx':
    case 'microsoft_xlsm':
    case 'gdrive_xlsx':
    case 'gsheet_native':
      return 'spreadsheet';
    case 'microsoft_docx':
    case 'google_doc':
      return 'text';
    case 'microsoft_pptx':
    case 'google_slides':
      return 'presentation';
    case 'microsoft_md':
    case 'microsoft_txt':
    case 'gdrive_md':
    case 'gdrive_txt':
      return 'plain_text';
    case 'microsoft_json':
    case 'microsoft_xml':
    case 'gdrive_json':
    case 'gdrive_xml':
      return 'structured_data';
    case 'microsoft_pdf':
    case 'gdrive_pdf':
      return 'pdf';
  }
  // Compile-time exhaustiveness: a new `KnownFileType` with no arm above
  // narrows to `never` here and fails the build.
  const unmapped: never = known;
  return unmapped;
}
