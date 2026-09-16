/**
 * ENG-5397 — the CHANGE MODEL a file has, and the refusal for every case where
 * this server cannot answer about one.
 *
 * ## The defect this closes
 *
 * `get_unattributed_changes` read `/unattributed-changes`, which is a
 * SPREADSHEET-ONLY lane: the `unattributed_change` row requires a `sheetName`
 * and the sheet route additionally filters `changeType = 'cell'`, so a Word
 * document or a PowerPoint deck returned `[]` from it by construction — not
 * because nothing changed, but because no document row can exist in that table.
 * The tool rendered that as "No unattributed changes found for this file." and
 * an assistant told the customer their contract was clean.
 *
 * A plausible zero is the most dangerous thing a tool can return, because
 * unlike a refusal it does not look like a non-answer. Same sentence as
 * `cell-history-unavailable.ts`, same reason, one lane over.
 *
 * ## Deliberately NOT part of `not-ready.ts`
 *
 * That vocabulary is "come back later", and every field of its payload
 * (`retryAfterSeconds`) is wrong for most of what is refused here. Retrying
 * cannot give a Google Doc a capture lane. Where a retry IS the right advice —
 * an enrolment still landing — `not-ready.ts` is still what answers, and this
 * module never shadows it.
 */

import type { DocumentChangeRow, DocumentChangesResponse } from './types.js';

/** The three change models Rockhopper tracks, mirroring the backend's
 * `DocumentType` (`enrolled-file.entity.ts`). */
export type ChangeModel = 'spreadsheet' | 'text' | 'presentation';

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
  | 'google_slides';

const KNOWN_FILE_TYPES: ReadonlySet<string> = new Set<KnownFileType>([
  'microsoft_xlsx',
  'microsoft_xlsm',
  'gdrive_xlsx',
  'gsheet_native',
  'microsoft_pptx',
  'microsoft_docx',
  'google_doc',
  'google_slides',
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
  }
  // Compile-time exhaustiveness: a new `KnownFileType` with no arm above
  // narrows to `never` here and fails the build.
  const unmapped: never = known;
  return unmapped;
}

/**
 * File types that have NO capture lane, so their change log holds zero rows
 * permanently.
 *
 * There is no Apps Script add-on for Google Docs or Google Slides, so neither
 * has a capture route, and a document's ledger rows come only from capture.
 * The backend asserts this mechanically rather than describing it —
 * `backend/src/resources/enrolled-files/google-document-lane.capability.spec.ts`,
 * ENG-4951: *"Their change log holds zero rows, permanently. That is not a bug
 * and it is not a gap waiting on a ticket."*
 *
 * WHICH IS EXACTLY WHY IT MUST BE A REFUSAL HERE. A permanent, structural zero
 * rendered as "no changes found" is the same wrong answer as the spreadsheet
 * reader's — worse, because it will never stop being wrong.
 */
const FILE_TYPES_WITHOUT_CAPTURE_LANE: ReadonlySet<string> = new Set<
  KnownFileType
>(['google_doc', 'google_slides']);

export function hasCaptureLane(fileType: string): boolean {
  return !FILE_TYPES_WITHOUT_CAPTURE_LANE.has(fileType);
}

/** Why a document-change answer is being refused. */
export type DocumentChangesUnavailableReason =
  /** The file type is not one this build knows, so its change model is unknown. */
  | 'unknown_file_type'
  /** Google Docs and Slides: no capture lane exists, so no row can ever exist. */
  | 'no_capture_lane'
  /** A worksheet filter was passed for a file that has no worksheets. */
  | 'sheet_filter_not_applicable'
  /** The backend withheld the window rather than serving it. */
  | 'window_withheld';

/** Grep marker; also the first token of every refusal an assistant sees. */
export const DOCUMENT_CHANGES_UNAVAILABLE_MARKER = 'DOCUMENT_CHANGES_UNAVAILABLE';

export interface DocumentChangesUnavailableResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * What the caller can DO, per reason.
 *
 * Customer-facing copy rule: say what the caller can do next, never how our
 * pipeline works and never whose platform is responsible. "PowerPoint gives
 * add-ins no way to…" is banned; so is naming a poller, a cadence or a table.
 */
const NEXT_STEP: Record<DocumentChangesUnavailableReason, string> = {
  unknown_file_type:
    'Ask the user what kind of file this is. Rockhopper tracks changes for ' +
    'workbooks, Word documents and PowerPoint decks; this file is none of ' +
    'those as far as this connection can tell.',
  no_capture_lane:
    'Rockhopper tracks versions and comments for this file, and can compare ' +
    'two of its versions. Offer the user a version comparison instead, or ' +
    'ask them to keep the file in Word or PowerPoint if they need a ' +
    'change-by-change log.',
  sheet_filter_not_applicable:
    'Call this tool again without `sheetName` to get the whole file.',
  window_withheld:
    'Tell the user the change list for this file is not available right now ' +
    'and offer to compare two versions instead.',
};

/**
 * The tool answer for a document-change read this server cannot make.
 *
 * Three defences, the same three `notReadyToolResult` and
 * `cellHistoryUnavailableToolResult` use, because one is not enough against a
 * model that wants to be helpful: `isError`, prose that names the wrong
 * inference explicitly, and a JSON object to branch on.
 */
export function documentChangesUnavailableToolResult(ctx: {
  reason: DocumentChangesUnavailableReason;
  fileMsId: string;
  fileName?: string | null;
  /** The backend's own decline code, when it supplied one. */
  declineReason?: string | null;
}): DocumentChangesUnavailableResult {
  const payload = {
    status: 'unavailable',
    reason: ctx.reason,
    fileMsId: ctx.fileMsId,
    declineReason: ctx.declineReason ?? null,
  };
  const subject = ctx.fileName ? `"${ctx.fileName}"` : 'this file';
  return {
    content: [
      {
        type: 'text',
        text:
          `${DOCUMENT_CHANGES_UNAVAILABLE_MARKER} — this is NOT a result and ` +
          `NOT an empty result.\n` +
          `Rockhopper cannot report the change list for ${subject}.\n` +
          `Do NOT say the file has no changes, that nothing changed, that it ` +
          `is unchanged, or that the change log is empty — none of that is ` +
          `known.\n` +
          `${NEXT_STEP[ctx.reason]}\n` +
          JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}

/** The readable side of a stored facet. Both sides are stored (ENG-4511). */
function facetText(facet: { v?: unknown; f?: unknown } | null): string {
  if (!facet) return '(not recorded)';
  const value = facet.v ?? facet.f;
  return value === undefined || value === null
    ? '(empty)'
    : JSON.stringify(value);
}

/**
 * One rendered row.
 *
 * Named by `anchorProviderId` — the identity of the THING that changed, stable
 * across edits — never by an ordinal. A shape also names its slide by
 * `containerProviderId`, which is an OPAQUE id and is deliberately NOT rendered
 * as "Slide N": it carries no position, and `containerOrdinal` is null on every
 * row either lane writes, so a slide NUMBER is not a fact this server holds.
 */
function formatDocumentRow(row: DocumentChangeRow): string {
  const unit = row.anchorLabel
    ? `${row.anchorLabel} (${row.anchorProviderId ?? 'unidentified'})`
    : (row.anchorProviderId ?? 'unidentified');
  const where =
    row.containerProviderId !== null
      ? `slide ${row.containerProviderId} / ${unit}`
      : unit;
  const editor = row.editorPlatformId ? ` — by ${row.editorPlatformId}` : '';
  const when = row.occurredAt ?? row.firstObservedAt;
  const capped = row.truncated ? ' [text shortened]' : '';
  return (
    `- **${where}** (${row.changeKind}): ` +
    `${facetText(row.fromValue)} → ${facetText(row.toValue)}` +
    `${editor} — ${when}${capped}`
  );
}

/**
 * The served answer, rendered.
 *
 * ONLY CALLED ON A SERVED WINDOW. A withheld one (`declineReason` non-null) is
 * a REFUSAL and goes through {@link documentChangesUnavailableToolResult}
 * instead — routing both through one renderer is how a withheld window comes to
 * be described as an empty one.
 */
export function formatDocumentChanges(
  response: DocumentChangesResponse,
  fileName: string,
): string {
  const scope =
    `Changes to "${fileName}" since the last saved version ` +
    `(${response.windowStart}).`;
  if (response.rows.length === 0) {
    // An honest zero: the window WAS served, and it was empty. The window is
    // named so the caller can see what the answer covers — which a reader that
    // could not see the rows at all was never able to say.
    return `${scope}\nNo changes recorded in this window.`;
  }
  const lines = [
    `${response.rows.length} change(s). ${scope}`,
    '',
    response.rows.map(formatDocumentRow).join('\n'),
  ];
  if (response.truncated) {
    lines.push('');
    // No cursor exists on this read, so say the list was cut rather than
    // offering a next page that cannot be asked for.
    lines.push(
      'More changes exist than are shown here. Ask the user to save a ' +
        'version to start a smaller list, or open the file in Rockhopper to ' +
        'see all of them.',
    );
  }
  return lines.join('\n');
}
