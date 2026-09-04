// ENG-4340 — get_cell_history advertises `Sheet1!C3` in its own parameter
// description, then passed it to the API verbatim where it was matched as a
// literal string. It missed every row and rendered the miss as "No history
// found", a silent false negative on a cell that has history.
import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const ROWS = [
  {
    versionId: 'v3.0.0',
    value: 793907,
    formula: 'SUM(BS7:BS10)',
    provenance: 'system_recalc',
    actorKind: 'system',
    changedBy: null,
    drivingHuman: null,
    changedAt: '2026-08-24T01:13:58.000Z',
    formatted:
      'v3.0.0: 793907 [SUM(BS7:BS10)] — system_recalc — 2026-08-24T01:13:58Z',
  },
  {
    versionId: 'v1.0.0',
    value: 793907,
    formula: 'SUM(BS7:BS10)',
    provenance: 'human_direct',
    actorKind: 'human',
    changedBy: 'Sebastian Perez Lawrence',
    drivingHuman: 'Sebastian Perez Lawrence',
    changedAt: '2026-02-12T21:20:58.000Z',
    formatted:
      'v1.0.0: 793907 [SUM(BS7:BS10)] — human_direct — 2026-02-12T21:20:58Z',
  },
];

const getHandler = (api: ReturnType<typeof createMockApiClient>) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_cell_history',
  )?.[2];
};

describe('get_cell_history sheet-qualified cell addresses (ENG-4340)', () => {
  it('returns the same history rows for the qualified and bare forms', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue(ROWS);
    const handler = getHandler(api);

    const bare = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Accruals',
      cellAddress: 'BS11',
    });
    const qualified = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Accruals',
      cellAddress: 'Project Accruals!BS11',
    });

    // Assert on the rows themselves, not on a count.
    for (const result of [bare, qualified]) {
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(
        '- v3.0.0: 793907 [SUM(BS7:BS10)] — system_recalc — 2026-08-24T01:13:58Z',
      );
      expect(result.content[0].text).toContain(
        '- v1.0.0: 793907 [SUM(BS7:BS10)] — human_direct — 2026-02-12T21:20:58Z',
      );
    }
    expect(qualified.content[0].text).toBe(bare.content[0].text);

    // The sheet prefix is stripped before the API sees it — the API matches
    // `cell` as a literal string, so "Project Accruals!BS11" matches nothing.
    expect(api.getCellHistory).toHaveBeenCalledTimes(2);
    for (const call of api.getCellHistory.mock.calls) {
      expect(call).toEqual(['file-1', 'Project Accruals', 'BS11']);
    }
  });

  it('accepts the quoted form for a sheet name containing spaces', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue(ROWS);
    const handler = getHandler(api);

    const result = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Accruals',
      cellAddress: "'Project Accruals'!BS11",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(
      '- v1.0.0: 793907 [SUM(BS7:BS10)] — human_direct — 2026-02-12T21:20:58Z',
    );
    expect(api.getCellHistory).toHaveBeenCalledWith(
      'file-1',
      'Project Accruals',
      'BS11',
    );
  });

  it('refuses a sheet prefix that disagrees with sheetName, naming both', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue(ROWS);
    const handler = getHandler(api);

    const result = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Accruals',
      cellAddress: 'Summary!BS11',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Summary');
    expect(result.content[0].text).toContain('Project Accruals');
    // A refusal never reads as an absence of changes.
    expect(result.content[0].text).not.toContain('No history found');
    expect(api.getCellHistory).not.toHaveBeenCalled();
  });

  it('errors on a malformed address rather than returning an empty history', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue([]);
    const handler = getHandler(api);

    for (const cellAddress of ['BS', '11', 'BS11:BS20', 'not a cell', '!BS11']) {
      const result = await handler({
        fileMsId: 'file-1',
        sheetName: 'Project Accruals',
        cellAddress,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(cellAddress);
      // "Empty" must mean "this cell has no recorded changes" and must not be
      // reachable from a malformed input.
      expect(result.content[0].text).not.toContain('No history found');
    }
    expect(api.getCellHistory).not.toHaveBeenCalled();
  });

  it('still reports a genuine empty history as an absence, not an error', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue([]);
    const handler = getHandler(api);

    const result = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Accruals',
      cellAddress: 'Project Accruals!ZZ99',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No history found');
    expect(api.getCellHistory).toHaveBeenCalledWith(
      'file-1',
      'Project Accruals',
      'ZZ99',
    );
  });
});
