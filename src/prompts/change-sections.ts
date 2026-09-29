import { formatDocumentChanges } from '../document-changes.js';
import {
  fileChangesUnavailableText,
  type FileChangesRead,
} from '../file-changes.js';

/**
 * ENG-6431 — the prompts' own formatting of the shared change read. Documents
 * reuse `formatDocumentChanges` (no second summariser); a refusal reuses the
 * tool's refusal text, so a withheld window is NAMED and never rendered as 0.
 */

/** The `## Unattributed Changes …` section of `summarize-file-changes`. */
export function changeSummarySection(read: FileChangesRead): string {
  switch (read.kind) {
    case 'unavailable':
      return `## Unattributed Changes: unavailable\n${fileChangesUnavailableText(read)}`;
    case 'document':
      return `## Unattributed Changes\n${formatDocumentChanges(read.response, read.file.name)}`;
    case 'spreadsheet_sheet':
    case 'spreadsheet': {
      // KI-097 / ENG-4346 — the prompt reads the UNSCOPED first page, so
      // `totalCount` is a file total; the preview uses up to 20 rows of it.
      const rows = read.kind === 'spreadsheet' ? read.page.changes : read.changes;
      const total = read.kind === 'spreadsheet' ? read.page.totalCount : rows.length;
      const body = rows.length
        ? rows
            .slice(0, 20)
            .map(
              (c) =>
                `- ${c.sheetName}!${c.cellAddress}: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`,
            )
            .join('\n')
        : 'None';
      return `## Unattributed Changes (${total} total)\n${body}`;
    }
  }
}

/** The single-line change count of `file-overview`. */
export function changeCountLine(read: FileChangesRead): string {
  switch (read.kind) {
    case 'unavailable':
      return `## Unattributed Changes: unavailable\n${fileChangesUnavailableText(read)}`;
    case 'document':
      // A truncated window is a LOWER bound, and says so.
      return read.response.truncated
        ? `## Unattributed Changes: more than ${read.response.rows.length}`
        : `## Unattributed Changes: ${read.response.rows.length}`;
    case 'spreadsheet':
      return `## Unattributed Changes: ${read.page.totalCount}`;
    case 'spreadsheet_sheet':
      return `## Unattributed Changes: ${read.changes.length}`;
  }
}
