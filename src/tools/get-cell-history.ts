import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import {
  assertChangeHistoryComplete,
  isNotReady,
  notReadyToolResult,
} from '../not-ready.js';
import { parseCellAddress, sheetNamesAgree } from './cell-address.js';

export function registerGetCellHistoryTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_cell_history',
    {
      title: 'Get Cell History',
      description:
        'Get the change history for a specific cell in an enrolled file. ' +
        'Shows how the cell value changed across versions. ' +
        // Plan 02 ruling 5 — the contract belongs in the description, not only
        // in the payload: a model deciding "nothing changed" reads the tool
        // doc, not the error envelope.
        'Answers CHANGE_HISTORY_NOT_READY (isError) while Rockhopper is still ' +
        'computing this history. That is NOT an empty history — nothing is ' +
        'known yet; retry after the stated interval and never report an ' +
        'absence of changes from it.',
      inputSchema: z.object({
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        sheetName: z.string().describe('Name of the worksheet'),
        cellAddress: z
          .string()
          .describe(
            'Cell address, bare or sheet-qualified (e.g. "A1", "B12", ' +
              '"Sheet1!C3", "\'My Sheet\'!C3"). A sheet prefix must name the ' +
              'same worksheet as sheetName. One cell only — a range such as ' +
              '"A1:B2" is refused.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileMsId, sheetName, cellAddress }) => {
      // ENG-4340 — parse BEFORE any API call. A malformed or contradictory
      // address is a refusal naming the address; it must never reach the
      // "No history found" branch, which asserts the cell has no recorded
      // changes.
      const parsed = parseCellAddress(cellAddress);
      if (!parsed.ok) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Cannot read "${cellAddress}" as a cell address: ${parsed.reason}. ` +
                `This is a bad address, NOT a cell without changes — nothing was looked up.`,
            },
          ],
          isError: true,
        };
      }
      if (parsed.sheet !== null && !sheetNamesAgree(parsed.sheet, sheetName)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Conflicting worksheets: cellAddress "${cellAddress}" names sheet ` +
                `"${parsed.sheet}" but sheetName is "${sheetName}". Nothing was ` +
                `looked up — re-send with the two in agreement.`,
            },
          ],
          isError: true,
        };
      }
      const cell = parsed.cell;

      try {
        // Plan 02 ruling 5 (STRICT): completeness FIRST. A pending fold means
        // the change-log window is mid-rewrite, so rows served now are a
        // partial view an assistant would summarise as the whole truth.
        await assertChangeHistoryComplete(api, fileMsId);

        const history = await api.getCellHistory(fileMsId, sheetName, cell);

        // ENG-1638 (P3-2): a ledger-served entry carries a backend-rendered
        // `formatted` line — 'vX.Y.Z: <value> — <provenance> (driven by
        // <human>) — <ts>' — print it verbatim. The legacy normalized
        // fallback (not-eligible file / Google / old backend) has only the
        // four core fields; keep the original rendering for it.
        const summary = history
          .map((h) =>
            h.formatted
              ? `- ${h.formatted}`
              : `- Version ${h.versionId}: **${JSON.stringify(h.value)}**` +
                (h.changedBy ? ` — by ${h.changedBy}` : '') +
                ` — ${h.changedAt}`,
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              // Render the normalized cell, so the qualified and bare forms
              // of one address answer identically rather than merely
              // equivalently.
              text: history.length
                ? `Cell ${cell} on "${sheetName}" — ${history.length} change(s):\n\n${summary}`
                : `No history found for ${cell} on "${sheetName}".`,
            },
          ],
        };
      } catch (error) {
        // A not-ready answer is a refusal, never an error string: the generic
        // branch below hands the model prose it may read as "the tool is
        // broken, answer from what I already have".
        if (isNotReady(error)) return notReadyToolResult(error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get cell history: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
