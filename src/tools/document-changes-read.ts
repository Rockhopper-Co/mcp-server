import type { ApiClient } from '../api-client.js';
import { assertEnrollmentComplete } from '../not-ready.js';
import {
  documentChangesUnavailableToolResult,
  formatDocumentChanges,
  hasCaptureLane,
} from '../document-changes.js';

/**
 * ENG-5397 — the document (Word paragraph / PowerPoint shape) read behind
 * `get_unattributed_changes`.
 *
 * Its own module so `search.ts` keeps the ROUTING and this keeps the document
 * lane's rules; the vocabulary and the renderer live one file over in
 * `document-changes.ts`.
 *
 * EVERY EXIT IS EITHER REAL ROWS OR A NAMED REFUSAL. None is an empty list
 * dressed as a finding, which is the defect this ticket closes.
 */

/** The tool-result shape, mirroring the SDK's open-bag `CallToolResult`. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export async function readDocumentChanges(
  api: ApiClient,
  ctx: {
    fileMsId: string;
    sheetName?: string;
    fileType: string;
    fileName: string;
  },
): Promise<ToolResult> {
  const { fileMsId, fileName } = ctx;

  // A worksheet filter over a file with no worksheets. Refusing beats quietly
  // dropping it: the caller asked to narrow the read and would otherwise be
  // handed the WHOLE file's changes believing they were one sheet's.
  if (ctx.sheetName) {
    return documentChangesUnavailableToolResult({
      reason: 'sheet_filter_not_applicable',
      fileMsId,
      fileName,
    });
  }

  // Google Docs and Slides have no capture lane, so their change log holds
  // zero rows permanently — asserted backend-side in
  // `google-document-lane.capability.spec.ts`. A structural, permanent zero
  // rendered as "no changes" is a wrong answer that never becomes right, so it
  // is refused BEFORE the read rather than after an honest-looking empty one.
  if (!hasCaptureLane(ctx.fileType)) {
    return documentChangesUnavailableToolResult({
      reason: 'no_capture_lane',
      fileMsId,
      fileName,
    });
  }

  // ENG-2824 — the same enrolment gate the spreadsheet lane applies. A file
  // whose first read has not landed has no versions, and an empty window over
  // it is a premature absence rather than a fact about the document.
  assertEnrollmentComplete(fileMsId, await api.getFileVersions(fileMsId));

  const response = await api.getDocumentChanges(fileMsId);

  // The one field that separates a withheld window from an empty one. The
  // backend's own DTO says a client MUST render the two differently.
  if (response.declineReason !== null) {
    return documentChangesUnavailableToolResult({
      reason: 'window_withheld',
      fileMsId,
      fileName,
      declineReason: response.declineReason,
    });
  }

  return {
    content: [{ type: 'text', text: formatDocumentChanges(response, fileName) }],
  };
}
