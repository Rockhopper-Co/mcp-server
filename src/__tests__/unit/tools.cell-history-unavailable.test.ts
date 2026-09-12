// ENG-1748 — `get_cell_history` answered "No history found" for every file the
// backend could not reconstruct a history for. The empty list arrived with HTTP
// 200, so nothing in the tool could tell it from a cell that genuinely never
// changed, and an assistant reported the absence to a customer as fact.
//
// The contract these tests pin: an UNANSWERABLE read is a refusal a model can
// branch on, and a real zero stays a plain, trustworthy zero.
import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const call = (api: ReturnType<typeof createMockApiClient>) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_cell_history',
  )!;
};

const getHandler = (api: ReturnType<typeof createMockApiClient>) =>
  call(api)[2];

const getDescription = (api: ReturnType<typeof createMockApiClient>) =>
  call(api)[1].description as string;

const args = { fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'A1' };

const unavailable = () =>
  new RockhopperApiError(
    422,
    'Rockhopper API 422: Unprocessable Entity',
    'CELL_HISTORY_UNAVAILABLE',
    null,
  );

describe('get_cell_history — an unavailable source is not an empty history', () => {
  it('refuses, and says so in terms a model cannot read as "no changes"', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockRejectedValue(unavailable());

    const result = await getHandler(api)(args);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('CELL_HISTORY_UNAVAILABLE');
    expect(text).toContain('NOT an empty result');
    expect(text).toContain('Do NOT say the cell has no history');
    // The exact sentence the defect produced must not appear.
    expect(text).not.toContain('No history found');
    // A machine-readable branch, not only prose.
    expect(text).toContain('"status":"unavailable"');
  });

  it('names the cell it could not answer for, so the refusal is not mistaken for another', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockRejectedValue(unavailable());

    const result = await getHandler(api)({
      ...args,
      sheetName: 'Q3 Model',
      cellAddress: 'B12',
    });

    expect(result.content[0].text).toContain('B12');
    expect(result.content[0].text).toContain('Q3 Model');
  });

  it('still renders a REAL empty history as an empty history', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue([]);

    const result = await getHandler(api)(args);

    // A 200 with zero rows is a measurement the backend stands behind; the
    // refusal must not swallow it, or the fix would trade one lie for another.
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No history found for A1');
  });

  it('leaves an unrelated failure on the generic branch', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockRejectedValue(
      new RockhopperApiError(500, 'Rockhopper API 500: Internal Server Error'),
    );

    const result = await getHandler(api)(args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to get cell history');
    expect(result.content[0].text).not.toContain('CELL_HISTORY_UNAVAILABLE');
  });

  it('publishes the refusal in the description, and names no vendor there', () => {
    const description = getDescription(createMockApiClient());

    // A model decides whether to trust an absence from the tool doc, not from
    // the error envelope it may never see.
    expect(description).toContain('CELL_HISTORY_UNAVAILABLE');
    expect(description).toContain('NOT an empty history');
    // Customer-facing copy: never another vendor as the reason for our
    // behaviour, and no internal mechanism.
    for (const banned of ['Google', 'Microsoft', 'Excel', 'ledger', 'poll']) {
      expect(description).not.toContain(banned);
    }
  });
});
