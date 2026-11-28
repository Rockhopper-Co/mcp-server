import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import { readAnchorHistory } from './anchor-history-read.js';
import { readCellHistory } from './cell-history-read.js';
import { parseCellAddress, sheetNamesAgree } from './cell-address.js';
import { readSmartsheetCellHistory } from './smartsheet-cell-history.js';
import type { ToolAnnotations } from './tool-annotations.js';

/**
 * ENG-6433 — EXACTLY ONE address: a sheet + cell, or an anchorId.
 *
 * A flat object with a refinement rather than a top-level union: the refinement
 * enforces the same rule at call time, and the advertised JSON Schema stays a
 * plain `type: object` with properties, which every MCP host renders — a
 * root-level `anyOf` is refused by some function-calling hosts.
 */
export const getCellHistoryInputSchema = z
  .object({
    fileMsId: z.string().describe('Platform ID of the enrolled file'),
    sheetName: z
      .string()
      .optional()
      .describe('Name of the worksheet. Send with cellAddress, never with anchorId.'),
    cellAddress: z
      .string()
      .optional()
      .describe(
        'Cell address, bare or sheet-qualified (e.g. "A1", "B12", ' +
          '"Sheet1!C3", "\'My Sheet\'!C3"). A sheet prefix must name the ' +
          'same worksheet as sheetName. One cell only — a range such as ' +
          '"A1:B2" is refused. Send with sheetName, never with anchorId.',
      ),
    anchorId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'One paragraph or shape in a document: the `anchorProviderId` from ' +
          'get_unattributed_changes. Send alone, without sheetName or ' +
          'cellAddress.',
      ),
    rowAnchorId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'One Smartsheet cell: the id of its row. Send with columnAnchorId ' +
          'and nothing else.',
      ),
    columnAnchorId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'One Smartsheet cell: the id of its column. Send with rowAnchorId ' +
          'and nothing else.',
      ),
  })
  .superRefine((args, ctx) => {
    const cellParts = [args.sheetName, args.cellAddress].filter(
      (v) => v !== undefined,
    ).length;
    const sheetParts = [args.rowAnchorId, args.columnAnchorId].filter(
      (v) => v !== undefined,
    ).length;
    const byAnchor = args.anchorId !== undefined;
    if (byAnchor) {
      if (cellParts === 0 && sheetParts === 0) return;
    } else if (sheetParts > 0) {
      if (sheetParts === 2 && cellParts === 0) return;
    } else if (cellParts === 2) {
      return;
    }
    ctx.addIssue({
      code: 'custom',
      message: byAnchor
        ? 'Send anchorId alone, without sheetName or cellAddress.'
        : sheetParts > 0
          ? 'Send rowAnchorId and columnAnchorId together, and nothing else.'
          : 'Send sheetName and cellAddress together, or anchorId alone.',
    });
  });

export function registerGetCellHistoryTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_cell_history',
    {
      title: 'Get Cell History',
      description:
        'Get the change history for a specific cell, paragraph or shape in ' +
        'an enrolled file. Shows how its value changed across versions. ' +
        // ENG-7243 — the contract belongs in the description, not only in the
        // payload: a model deciding "nothing changed" reads the tool doc.
        'While Rockhopper is still recording changes to the file, the answer ' +
        'OPENS with "UPDATING — incomplete:" and lists the changes recorded ' +
        'so far. That list is partial: more may appear, so never report it ' +
        'as the complete history, and never read an UPDATING answer with no ' +
        'rows as "no changes"; retry after the stated interval. ' +
        'Answers CHANGE_HISTORY_NOT_READY (isError) when Rockhopper cannot ' +
        'serve rows yet. That is NOT an empty history — nothing is known yet; ' +
        'retry after the stated interval and never report an absence of ' +
        'changes from it. ' +
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
        // ENG-6433 — documents are now addressable, by the element's id.
        'Send EXACTLY ONE address: `sheetName` + `cellAddress` for a cell in ' +
        'a spreadsheet, OR `anchorId` for one paragraph or shape in a text ' +
        'document or slide deck (a Word document, a PowerPoint deck). The ' +
        'anchorId is the `anchorProviderId` a document change carries in ' +
        'get_unattributed_changes (shown in parentheses after each change). ' +
        'A Smartsheet cell takes `sheetName` + `cellAddress` too, as the ' +
        'change list shows it (B5 or Plan!B5). That address is where the ' +
        'cell sits now, so ask a moved row by its new address. ' +
        '`rowAnchorId` + `columnAnchorId` (the ids of its row and its ' +
        'column) also name a Smartsheet cell. ' +
        'A cell address on a document, or an anchorId on a spreadsheet, ' +
        'answers CELL_HISTORY_UNAVAILABLE, never an empty list. For a deck, ' +
        'the answer covers the changes recorded under that one id and says ' +
        'so when it is not the whole history of the shape. ' +
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
        'An empty result WITHOUT one of those answers and without the ' +
        'UPDATING line is a real answer ' +
        'about ONE CELL on a sheet that exists: no change to that cell is ' +
        'recorded. It says nothing about the rest of the file, and it is ' +
        'never grounds for saying the file is unchanged.',
      inputSchema: getCellHistoryInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // An empty answer on a native Google Sheet checks the sheet against
        // the Sheets API (sheet-catalogue.ts!assertSheetExists).
        openWorldHint: true,
      } satisfies ToolAnnotations,
    },
    async ({
      fileMsId,
      sheetName,
      cellAddress,
      anchorId,
      rowAnchorId,
      columnAnchorId,
    }) => {
      // The Smartsheet arm: a cell named by its row and column ids.
      if (rowAnchorId !== undefined && columnAnchorId !== undefined) {
        return readSmartsheetCellHistory(
          api,
          fileMsId,
          rowAnchorId,
          columnAnchorId,
        );
      }
      // ENG-6433 — the document arm. The schema admits exactly one address
      // form, so an anchorId here arrives with no sheet and no cell.
      if (anchorId !== undefined) {
        return readAnchorHistory(api, fileMsId, anchorId);
      }
      if (sheetName === undefined || cellAddress === undefined) {
        // Unreachable behind the schema's refinement; never guess an address.
        throw new Error('get_cell_history needs sheetName + cellAddress or anchorId');
      }
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
      return readCellHistory(api, fileMsId, sheetName, parsed.cell);
    },
  );
}
