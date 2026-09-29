import type { ApiClient } from './api-client.js';
import {
  assertChangeHistoryComplete,
  assertEnrollmentComplete,
} from './not-ready.js';
import {
  changeModelForFileType,
  documentChangesUnavailableToolResult,
  type DocumentChangesUnavailableReason,
} from './document-changes.js';
import { assertSheetExists } from './sheet-catalogue.js';
import type {
  DocumentChangesResponse,
  EnrolledFile,
  PaginatedUnattributedResponse,
  UnattributedChange,
} from './types.js';

/**
 * ENG-6431 — THE change read, returned as DATA, for every surface that reports
 * a file's changes since its last saved version.
 *
 * ENG-5397 wrote this dispatch inline in `get_unattributed_changes`, and the
 * `…/changes` resource and the `summarize-file-changes` / `file-overview`
 * prompts kept calling the spreadsheet-only lane for every file type — so a
 * `.docx`, `.pptx`, Google Doc or Google Slides file read `totalCount: 0` there
 * by construction. Every surface now calls this one function and does only its
 * own formatting.
 *
 * EVERY EXIT IS REAL ROWS OR A NAMED REFUSAL. A withheld document window is
 * `unavailable`, never a served empty one — the backend's DTO says a client
 * MUST render the two differently. Not-ready states still THROW
 * (`ChangeHistoryNotReadyError`), exactly as before.
 */
export type FileChangesRead =
  | { kind: 'spreadsheet'; file: EnrolledFile; page: PaginatedUnattributedResponse }
  | {
      kind: 'spreadsheet_sheet';
      file: EnrolledFile;
      sheetName: string;
      changes: UnattributedChange[];
    }
  | { kind: 'document'; file: EnrolledFile; response: DocumentChangesResponse }
  | {
      kind: 'unavailable';
      file: EnrolledFile;
      fileMsId: string;
      reason: DocumentChangesUnavailableReason;
      declineReason: string | null;
    };

export async function readFileChanges(
  api: ApiClient,
  fileMsId: string,
  opts: { sheetName?: string; cursor?: string } = {},
): Promise<FileChangesRead> {
  const file = await api.getEnrolledFile(fileMsId);
  const model = changeModelForFileType(file.fileType);

  if (model === null) {
    return {
      kind: 'unavailable',
      file,
      fileMsId,
      reason: 'unknown_file_type',
      declineReason: null,
    };
  }

  if (model !== 'spreadsheet') {
    // A worksheet filter over a file with no worksheets. Refusing beats
    // quietly dropping it: the caller would otherwise be handed the WHOLE
    // file's changes believing they were one sheet's.
    if (opts.sheetName) {
      return {
        kind: 'unavailable',
        file,
        fileMsId,
        reason: 'sheet_filter_not_applicable',
        declineReason: null,
      };
    }
    // ENG-2824 — a file whose first read has not landed has no versions, and
    // an empty window over it is a premature absence.
    assertEnrollmentComplete(fileMsId, await api.getFileVersions(fileMsId));
    const response = await api.getDocumentChanges(fileMsId);
    if (response.declineReason !== null) {
      return {
        kind: 'unavailable',
        file,
        fileMsId,
        reason: 'window_withheld',
        declineReason: response.declineReason,
      };
    }
    return { kind: 'document', file, response };
  }

  // Plan 02 ruling 5 (STRICT): gate BOTH spreadsheet modes. The commit-diff
  // fold retracts and rewrites the uncommitted window, so a pending fold means
  // this list is mid-rewrite in either shape.
  await assertChangeHistoryComplete(api, fileMsId);

  if (opts.sheetName) {
    const changes = await api.getUnattributedChangesBySheet(fileMsId, opts.sheetName);
    // ENG-2824 / ENG-4347 — only an empty answer is ambiguous, so only it pays
    // for the version read and then the sheet-existence check, in that order.
    if (changes.length === 0) {
      assertEnrollmentComplete(fileMsId, await api.getFileVersions(fileMsId));
      await assertSheetExists(api, file, opts.sheetName);
    }
    return { kind: 'spreadsheet_sheet', file, sheetName: opts.sheetName, changes };
  }

  // ENG-4346 — `totalCount` is a FILE total only when no cursor is passed.
  // Pass `cursor` through only when the caller supplied the key (the tool
  // does, possibly as undefined); the resource and prompts never page.
  const page =
    'cursor' in opts
      ? await api.getUnattributedChangesPaginated(fileMsId, opts.cursor)
      : await api.getUnattributedChangesPaginated(fileMsId);
  if (page.changes.length === 0 && page.totalCount === 0) {
    assertEnrollmentComplete(fileMsId, await api.getFileVersions(fileMsId));
  }
  return { kind: 'spreadsheet', file, page };
}

/**
 * The refusal as the text every surface shows. A tool returns it as an
 * `isError` result; a prompt embeds it; a resource, which has no `isError`
 * channel, throws it.
 */
export function fileChangesUnavailableText(
  read: Extract<FileChangesRead, { kind: 'unavailable' }>,
): string {
  return documentChangesUnavailableToolResult({
    reason: read.reason,
    fileMsId: read.fileMsId,
    fileName: read.file.name,
    declineReason: read.declineReason,
  }).content[0].text;
}
