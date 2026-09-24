import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import {
  cellHistoryUnavailableToolResult,
  isCellHistoryUnavailable,
} from '../cell-history-unavailable.js';
import {
  assertChangeHistoryComplete,
  isNotReady,
  notReadyToolResult,
} from '../not-ready.js';
import {
  assertSheetExistsForFile,
  isUnknownSheet,
  unknownSheetToolResult,
} from '../sheet-catalogue.js';
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
        'absence of changes from it. ' +
        // ENG-1748 — same reasoning one case over: a history this tool cannot
        // report is a refusal, and the model must know that before it calls,
        // because the alternative it used to get was a confident zero.
        'Answers CELL_HISTORY_UNAVAILABLE (isError) when Rockhopper cannot ' +
        'report this cell\'s history for this file. That is NOT an empty ' +
        'history either — retrying will not change it, and nothing about ' +
        'whether the cell changed may be inferred from it. ' +
        // ENG-5075 — the sentence that used to close this description told the
        // model an empty result meant the cell has no recorded changes. It
        // reads as a licence to assert the negative, and it was wrong on two
        // counts at once: the tool addresses only cells, and a file with no
        // cells answered `[]` with HTTP 200. State what the tool KNOWS.
        'This tool addresses CELLS in a spreadsheet, and only cells. A file ' +
        'whose changes are not recorded against a sheet and a cell — a Word ' +
        'document, a PowerPoint deck — answers CELL_HISTORY_UNAVAILABLE, ' +
        'never an empty list; that file may hold a long change history this ' +
        'tool has no way to address. ' +
        // ENG-4347 — the third refusal, and the reason the sentence below can
        // now be trusted: an empty answer used to be reachable for a sheet the
        // workbook does not have.
        'Answers SHEET_NOT_FOUND, SHEET_NAME_NOT_EXACT or ' +
        'SHEET_CATALOGUE_UNAVAILABLE (each isError) when `sheetName` cannot ' +
        'be shown to be a worksheet of this workbook, spelled the way it is ' +
        'stored. None of those is an empty history: the first lists the real ' +
        'sheet names, the second gives the exact spelling, and the third ' +
        'means existence could not be checked. Re-send with a name from the ' +
        'answer rather than reporting that the cell never changed. ' +
        'An empty result WITHOUT one of those answers is a real answer ' +
        'about ONE CELL on a sheet that exists: no change to that cell is ' +
        'recorded. It says nothing about the rest of the file, and it is ' +
        'never grounds for saying the file is unchanged.',
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

        // ENG-4347 — ENG-4340 above compares the two ARGUMENTS against each
        // other; neither was ever compared against the workbook. A caller who
        // misspells the sheet the same way in both places passed every check
        // and got "No history found", which this tool's own description
        // establishes as a positive claim about the cell.
        //
        // Only the empty answer pays for the check: a row that came back names
        // the sheet it is on. Two hops here rather than one, because this tool
        // never fetches the file otherwise — still nothing on the path that
        // was never ambiguous.
        if (history.length === 0) {
          await assertSheetExistsForFile(api, fileMsId, sheetName);
        }

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
        // ENG-4347 — a sheet that cannot be shown to exist is a refusal naming
        // the sheet, never the "No history found" branch above.
        if (isUnknownSheet(error)) return unknownSheetToolResult(error);
        // ENG-1748 — the backend refused because it cannot reconstruct this
        // file's history. Rendering it through the generic branch below would
        // hand the model prose it may read as "the tool is broken, answer from
        // what I already have" — the same wrong turn the not-ready branch above
        // exists to prevent.
        if (isCellHistoryUnavailable(error)) {
          return cellHistoryUnavailableToolResult(cell, sheetName);
        }
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
