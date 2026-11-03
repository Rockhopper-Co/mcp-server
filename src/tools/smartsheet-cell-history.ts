import type { ApiClient } from '../api-client.js';
import {
  anchorHistoryUnavailableToolResult,
  isCellHistoryUnavailable,
} from '../cell-history-unavailable.js';
import {
  CURRENT,
  foldFreshness,
  mergeFreshness,
  updatingLine,
} from '../ledger-freshness.js';
import { isNotReady, notReadyToolResult } from '../not-ready.js';
import { SMARTSHEET_FILE_TYPE } from '../smartsheet-discovery.js';
import type {
  SmartsheetCellHistory,
  SmartsheetCellHistoryEntry,
} from '../smartsheet-types.js';

/**
 * The Smartsheet arm of `get_cell_history`: one cell, named by the id of its
 * row and the id of its column.
 *
 * A Smartsheet cell has no A1 address in the change record, and a row that is
 * moved keeps its id, so the row and column ids are its stable name. The
 * sheetName + cellAddress arm asks by the cell's current address instead.
 * Every exit is rows, an empty answer about this one cell, or a named refusal.
 */

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const refusal = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/** A stored cell value as text: its formula when it has one, else its value. */
function valueText(stored: unknown): string {
  if (stored === null || stored === undefined) return '(empty)';
  if (typeof stored !== 'object') return JSON.stringify(stored);
  const cell = stored as { v?: unknown; f?: unknown };
  if (typeof cell.f === 'string' && cell.f) return cell.f;
  return cell.v === undefined ? '(empty)' : JSON.stringify(cell.v);
}

function actorText(entry: SmartsheetCellHistoryEntry): string {
  if (!entry.actorPlatformId) return 'actor not recorded';
  const kind = entry.actorKind ? `${entry.actorKind} ` : '';
  return `by ${kind}${entry.actorPlatformId}`;
}

function entryText(entry: SmartsheetCellHistoryEntry): string {
  const when = entry.changedAt ?? 'time not recorded';
  const coalesced = entry.coalesced
    ? ' [several writes were seen between two reads; only the first and last values are kept]'
    : '';
  return (
    `- ${when}: ${valueText(entry.fromValue)} -> ${valueText(entry.toValue)}` +
    ` — ${entry.provenance}, ${actorText(entry)}` +
    ` (attribution ${entry.attributionConfidence})${coalesced}`
  );
}

export function formatSmartsheetCellHistory(
  response: SmartsheetCellHistory,
  updating: { retryAfterSeconds: number } | null,
): string {
  const n = response.history.length;
  const subject = `Smartsheet cell (row ${response.rowAnchorId}, column ${response.columnAnchorId})`;
  const rows = response.history.map(entryText).join('\n');
  const truncated = response.truncated
    ? ['', 'More changes exist than are shown; the oldest are not listed.']
    : [];
  if (updating) {
    return [
      updatingLine(n, updating.retryAfterSeconds),
      '',
      `${subject} — ${n} change(s) so far, oldest first${n ? ':' : '.'}`,
      ...(n ? ['', rows] : []),
      ...truncated,
    ].join('\n');
  }
  if (n === 0) {
    return (
      `No change is recorded for this ${subject}. This is an answer about ` +
      'that one cell: it says nothing about the rest of the sheet and is ' +
      'never grounds for saying the sheet is unchanged.'
    );
  }
  return [
    `${subject} — ${n} change(s), oldest first:`,
    '',
    rows,
    ...truncated,
  ].join('\n');
}

export async function readSmartsheetCellHistory(
  api: ApiClient,
  fileMsId: string,
  rowAnchorId: string,
  columnAnchorId: string,
): Promise<ToolResult> {
  try {
    const file = await api.getEnrolledFile(fileMsId);
    if (file.fileType !== SMARTSHEET_FILE_TYPE) {
      return refusal(
        'rowAnchorId and columnAnchorId address a Smartsheet sheet only, and ' +
          'this file is not one. Nothing was looked up — this is NOT a cell ' +
          'without changes. Use sheetName + cellAddress (or anchorId) for ' +
          'this file.',
      );
    }
    const fold = await foldFreshness(api, fileMsId);
    const response = await api.getSmartsheetCellHistory(
      fileMsId,
      rowAnchorId,
      columnAnchorId,
    );
    const freshness = mergeFreshness(fold, CURRENT);
    return {
      content: [
        {
          type: 'text',
          text: formatSmartsheetCellHistory(
            response,
            freshness.state === 'updating' ? freshness : null,
          ),
        },
      ],
    };
  } catch (error) {
    if (isNotReady(error)) return notReadyToolResult(error);
    if (isCellHistoryUnavailable(error)) {
      return anchorHistoryUnavailableToolResult(
        `row ${rowAnchorId}, column ${columnAnchorId}`,
      );
    }
    return refusal(
      `Failed to get cell history: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
