import { describe, expect, it } from 'vitest';
import { RockhopperApiError, type ApiClient } from '../../api-client.js';
import { ChangeHistoryNotReadyError } from '../../not-ready.js';
import type { SmartsheetCellHistoryEntry } from '../../smartsheet-types.js';
import {
  formatSmartsheetCellHistory,
  readSmartsheetCellHistory,
} from '../../tools/smartsheet-cell-history.js';
import { createMockApiClient } from './test-helpers.js';

/**
 * The Smartsheet arm of get_cell_history beyond the plain answer: a fold in
 * progress, a truncated page, values with formulas, and each way the read can
 * fail. Every failure is pinned by the text only its own branch writes, next
 * to a positive control that reads rows from the same file.
 */
const SHEET_ID = '4583173393803140';
const ROW = '2f9d7a52-1c44-5b3a-9e0a-5a3f0f1d0001';
const COLUMN = '8c1b6e10-7a3d-5e2b-8f11-0d9b3c7a0002';

const ENTRY: SmartsheetCellHistoryEntry = {
  eventType: 'edit',
  fromValue: { v: 'draft' },
  toValue: { v: 4, f: '=SUM(A1:A3)' },
  provenance: 'webhook',
  actorKind: 'human',
  actorPlatformId: 'ss-user-1',
  attributionConfidence: 'credential_bound',
  coalesced: false,
  changedAt: '2026-11-01T10:00:00.000Z',
};

function sheetApi() {
  const api = createMockApiClient();
  api.getEnrolledFile.mockResolvedValue({
    internalId: 21,
    platformId: SHEET_ID,
    fileType: 'smartsheet_sheet',
    driveMsId: '',
    name: 'Q4 Forecast',
    hasUncommittedChanges: true,
  });
  api.getSmartsheetCellHistory.mockResolvedValue({
    rowAnchorId: ROW,
    columnAnchorId: COLUMN,
    history: [ENTRY],
    truncated: false,
  });
  return api;
}

const read = (api: ReturnType<typeof sheetApi>) =>
  readSmartsheetCellHistory(api as unknown as ApiClient, SHEET_ID, ROW, COLUMN);
const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe('readSmartsheetCellHistory', () => {
  it('positive control: a settled fold prints the rows with no updating line', async () => {
    const result = await read(sheetApi());
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('1 change(s), oldest first:');
    expect(textOf(result)).not.toContain('UPDATING');
  });

  it('a fold in progress opens with the updating line and still lists the rows', async () => {
    const api = sheetApi();
    api.getFoldStatus.mockResolvedValue({
      fileMsId: SHEET_ID,
      foldPending: true,
      foldTargetVersionId: null,
      checkedAt: '2026-11-03T00:00:00.000Z',
    });
    const text = textOf(await read(api));
    expect(text.startsWith('UPDATING — incomplete')).toBe(true);
    expect(text).toContain('1 change(s) so far are listed below');
    expect(text).toContain('1 change(s) so far, oldest first:');
    // The formula is what the cell holds now, so it is what is printed.
    expect(text).toContain('"draft" -> =SUM(A1:A3)');
  });

  it('a not-ready refusal is the not-ready answer, never an empty cell', async () => {
    const api = sheetApi();
    api.getSmartsheetCellHistory.mockRejectedValue(
      new ChangeHistoryNotReadyError({ reason: 'completeness_unknown' }),
    );
    const result = await read(api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('CHANGE_HISTORY_NOT_READY');
    expect(textOf(result)).not.toContain('No change is recorded');
  });

  it('an unavailable history names the row and column it was asked about', async () => {
    const api = sheetApi();
    api.getSmartsheetCellHistory.mockRejectedValue(
      new RockhopperApiError(422, 'no', 'CELL_HISTORY_UNAVAILABLE', null),
    );
    const result = await read(api);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('CELL_HISTORY_UNAVAILABLE');
    expect(text).toContain(`row ${ROW}, column ${COLUMN}`);
    expect(text).not.toContain('CHANGE_HISTORY_NOT_READY');
  });

  it('any other failure is a named refusal carrying the error', async () => {
    const api = sheetApi();
    api.getSmartsheetCellHistory.mockRejectedValue(new Error('socket closed'));
    const result = await read(api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Failed to get cell history: socket closed',
    );
  });
});

describe('formatSmartsheetCellHistory', () => {
  const base = { rowAnchorId: ROW, columnAnchorId: COLUMN };

  it('a truncated page says older changes are not listed', () => {
    const text = formatSmartsheetCellHistory(
      { ...base, history: [ENTRY], truncated: true },
      null,
    );
    expect(text).toContain('1 change(s), oldest first:');
    expect(text).toContain('the oldest are not listed');
  });

  it('positive control: a full page does not claim to be truncated', () => {
    const text = formatSmartsheetCellHistory(
      { ...base, history: [ENTRY], truncated: false },
      null,
    );
    expect(text).toContain('1 change(s), oldest first:');
    expect(text).not.toContain('the oldest are not listed');
  });

  it('an empty updating answer says so in the updating line, not as a zero', () => {
    const text = formatSmartsheetCellHistory(
      { ...base, history: [], truncated: false },
      { retryAfterSeconds: 9 },
    );
    expect(text).toContain('No change is recorded here so far; more may appear.');
    expect(text).toContain('Retry in 9 s.');
    expect(text).toContain('0 change(s) so far, oldest first.');
  });

  it('a row with no actor and no time says so rather than leaving a gap', () => {
    const text = formatSmartsheetCellHistory(
      {
        ...base,
        history: [
          {
            ...ENTRY,
            fromValue: null,
            toValue: { v: 'x' },
            actorKind: null,
            actorPlatformId: null,
            changedAt: null,
          },
        ],
        truncated: false,
      },
      null,
    );
    expect(text).toContain(
      '- time not recorded: (empty) -> "x" — webhook, actor not recorded',
    );
  });
});
