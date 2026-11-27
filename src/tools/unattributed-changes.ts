import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AI_ATTRIBUTION_SHOWN, aiAttributionSuffix } from '../ai-attribution.js';
import type { ApiClient } from '../api-client.js';
import { isNotReady, notReadyToolResult } from '../not-ready.js';
import { formatDocumentChanges } from '../document-changes.js';
import {
  aiLinksUnavailableSuffix,
  formatSpreadsheetChangeRows,
} from '../change-row-vocabulary.js';
import { fileChangesUnavailableText, readFileChanges } from '../file-changes.js';
import {
  isPlanExcludesFeature,
  planExcludesFeatureToolResult,
} from '../plan-excludes-feature.js';
import { isUnknownSheet, unknownSheetToolResult } from '../sheet-catalogue.js';
import type { ToolAnnotations } from './tool-annotations.js';

/**
 * `get_unattributed_changes`, registered by `search.ts!registerSearchTool`
 * right after `search_files` (its own module for the file cap; the tool
 * order and text are unchanged).
 */
export function registerUnattributedChangesTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_unattributed_changes',
    {
      title: 'Get Unattributed Changes',
      description:
        'Get the changes made since the last saved version. Works on ' +
        'workbooks, Word documents, PowerPoint decks, PDFs, Markdown and ' +
        'text files, and JSON and XML files. ' +
        // ENG-5397 — the shape of the answer differs by file kind, and a
        // caller that assumes cells will mis-describe a document.
        'A workbook answers with cell changes; a Word document answers with ' +
        'paragraph changes; a deck answers with shape changes, each naming ' +
        'the slide it is on; a Markdown or text file answers with paragraph ' +
        'changes; a JSON or XML file answers with field changes. ' +
        'Two modes for a workbook: (1) provide `sheetName` to get ' +
        'every change on a single worksheet (no pagination — bounded by ' +
        'sheet size); (2) omit `sheetName` for the file-wide cursor-paginated ' +
        'view (rows are capped per response with a summary line; pass `cursor` ' +
        'returned by the previous call to fetch the next page). ' +
        '`sheetName` and `cursor` apply to workbooks only. ' +
        // Plan 02 ruling 5 — "No unattributed changes" is a factual claim, and
        // it is only made after completeness is proven.
        'Answers CHANGE_HISTORY_NOT_READY (isError) while Rockhopper is still ' +
        "computing this file's changes. That is NOT \"no changes\" — retry " +
        'after the stated interval instead of reporting an absence. ' +
        // ENG-5397 — the refusal this tool used to answer as an empty list.
        'Answers DOCUMENT_CHANGES_UNAVAILABLE (isError) when a change list ' +
        'cannot be produced for this file at all. That is also NOT "no ' +
        'changes": say the list is unavailable and offer to compare two ' +
        'versions instead. Never report a file as unchanged on either answer. ' +
        // ENG-4347 — the contract belongs in the description, not only in the
        // payload: a model deciding "nothing changed on that sheet" reads the
        // tool doc, not the error envelope.
        'Answers SHEET_NOT_FOUND, SHEET_NAME_NOT_EXACT or ' +
        'SHEET_CATALOGUE_UNAVAILABLE (each isError) when `sheetName` cannot ' +
        'be shown to be a worksheet of this workbook, spelled the way it is ' +
        'stored. None of those is "no changes" either: the first lists the ' +
        'real sheet names, the second gives the exact spelling, and the third ' +
        'means existence could not be checked. Re-send with a name from the ' +
        'answer rather than reporting an absence.',
      inputSchema: z.object({
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        sheetName: z
          .string()
          .optional()
          .describe(
            'Filter to a specific worksheet. When set, ignores `cursor` and ' +
              'returns the unpaginated sheet view.',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'Opaque cursor from a previous response\'s pagination hint. ' +
              'Only valid with no `sheetName` (file-wide paginated mode).',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      } satisfies ToolAnnotations,
    },
    async ({ fileMsId, sheetName, cursor }) => {
      try {
        // ENG-5397 — WHICH CHANGE MODEL, before which reader: the spreadsheet
        // lanes cannot hold a document row, so a `.docx` read `[]` from them by
        // construction. ENG-6431 — that dispatch (plus the fold, enrolment and
        // sheet-existence gates) lives in `readFileChanges`, shared with the
        // `…/changes` resource and the prompts; this tool only formats.
        const read = await readFileChanges(api, fileMsId, { sheetName, cursor });

        if (read.kind === 'unavailable') {
          return {
            content: [{ type: 'text', text: fileChangesUnavailableText(read) }],
            isError: true,
          };
        }

        if (read.kind === 'document') {
          return {
            content: [
              {
                type: 'text',
                text: formatDocumentChanges(read.response, read.file.name),
              },
            ],
          };
        }

        if (read.kind === 'spreadsheet_sheet') {
          // Sheet-filtered mode: bounded by sheet size, no pagination needed.
          const { changes } = read;
          const body = formatSpreadsheetChangeRows(changes);
          // ENG-8332 — one note when the backend could not check AI links.
          const note =
            aiLinksUnavailableSuffix(read.aiLinksAvailable) +
            aiAttributionSuffix(read.aiAttribution);
          return {
            content: [
              {
                type: 'text',
                text:
                  (changes.length
                    ? `${changes.length} unattributed change(s) on sheet "${sheetName}":\n\n${body}`
                    : `No unattributed changes on sheet "${sheetName}".`) + note,
              },
            ],
          };
        }

        // File-wide mode: paginated (`ledger-changes.ts!readLedgerPage`); we
        // cap display at MAX_DISPLAYED to keep MCP responses under the
        // 25k-token client limit (audit measured one file at 12.5 MB / 28k
        // rows on the unpaginated route — KI-097).
        const MAX_DISPLAYED = 200;
        const { page } = read;
        // ENG-8332 — one note when the backend could not check AI links.
        // Absent `aiAttribution` is shown: the reader sets it only when withheld.
        const note =
          aiLinksUnavailableSuffix(page.aiLinksAvailable) +
          aiAttributionSuffix(page.aiAttribution ?? AI_ATTRIBUTION_SHOWN);

        if (page.changes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  (page.totalCount === 0
                    ? 'No unattributed changes found for this file.'
                    : `End of pages reached (${describeRemainingCount(page.totalCount, cursor)}).`) +
                  note,
              },
            ],
          };
        }

        const displayed = page.changes.slice(0, MAX_DISPLAYED);
        const body = formatSpreadsheetChangeRows(displayed);
        const summary = summarizeBySheet(page.changes);
        const hidden = page.changes.length - displayed.length;
        const lines: string[] = [];

        // Header line: this page's slice + total + per-sheet hint
        lines.push(
          `Showing ${displayed.length} of ${page.changes.length} change(s) on this page (${describeRemainingCount(page.totalCount, cursor)}).`,
        );
        if (summary.length > 0) {
          const topSheets = summary
            .slice(0, 5)
            .map((s) => `${s.sheetName} (${s.count})`)
            .join(', ');
          lines.push(`Top sheets on this page: ${topSheets}.`);
        }
        lines.push('');
        lines.push(body);

        // Pagination hints
        const hints: string[] = [];
        if (hidden > 0) {
          hints.push(
            `${hidden} more row(s) on this page not shown (cap is ${MAX_DISPLAYED}). Pass \`sheetName="<name>"\` to drill into a single sheet.`,
          );
        }
        if (page.nextCursor) {
          hints.push(
            `More pages available. Pass \`cursor="${page.nextCursor}"\` to fetch the next page.`,
          );
        }
        if (hints.length > 0) {
          lines.push('');
          lines.push(...hints);
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n') + note,
            },
          ],
        };
      } catch (error) {
        if (isNotReady(error)) return notReadyToolResult(error);
        // ENG-4347 — a sheet that cannot be shown to exist is a refusal naming
        // the sheet, never the empty answer the generic branch below would
        // dress it as.
        if (isUnknownSheet(error)) return unknownSheetToolResult(error);
        // The organization's plan does not include what the read asked for.
        if (isPlanExcludesFeature(error)) return planExcludesFeatureToolResult();
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get changes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * ENG-4346 - assemble the sentence that describes `totalCount` from the
 * predicate that actually scoped the query.
 *
 * `totalCount` is the number of rows remaining in the snapshot FROM THE
 * CURSOR POSITION ONWARD, inclusive of the page being rendered - not a count
 * over the file. It coincides with a file total only on the unscoped read,
 * where the cursor sits at the start of the snapshot. Measured on staging
 * 2026-09-03 over one snapshot: page 1 reported 1647 and page 2 of that same
 * snapshot reported 647, both rendered as "total across the file".
 *
 * Per `docs/conventions/metric-descriptions.md` the fragment is selected by
 * the predicate that fired - the presence of a cursor - and never written
 * freehand, so a file-wide phrase is emitted ONLY where the query computed a
 * file-wide number. The number itself is never dropped: the size of the
 * change set is what a caller most needs.
 *
 * NOT covered: whether `totalCount` is itself correct (ENG-4338; summed from
 * the ledger summary since ENG-6757). This assembler describes the value it is handed, faithfully.
 */
function describeRemainingCount(totalCount: number, cursor?: string): string {
  return cursor
    ? `${totalCount} remaining from this page onward`
    : `${totalCount} in this file`;
}

function summarizeBySheet(
  changes: ReadonlyArray<{ sheetName: string }>,
): Array<{ sheetName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of changes) {
    counts.set(c.sheetName, (counts.get(c.sheetName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([sheetName, count]) => ({ sheetName, count }))
    .sort((a, b) => b.count - a.count);
}
