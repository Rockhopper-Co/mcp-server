// ENG-4347 — nothing validates `sheetName` against the workbook's real sheets.
// A misspelled sheet renders as "No unattributed changes on sheet X" /
// "No history found for <cell> on X", byte-identical to a real sheet that
// genuinely has nothing on it. The tool descriptions establish that an empty
// answer is a POSITIVE claim, so a one-character typo becomes a clean bill of
// health on a sheet holding pending edits.
import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const getHandler = (
  api: ReturnType<typeof createMockApiClient>,
  name: string,
) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find((c) => c[0] === name)?.[2];
};

describe('unknown sheetName is refused, not answered empty (ENG-4347)', () => {
  it('get_unattributed_changes refuses a sheet the workbook does not have', async () => {
    const api = createMockApiClient();
    // The backend takes sheetName as a FILTER and returns [] for a name that
    // matches nothing — there is no 404, so the miss is indistinguishable
    // from a real sheet with no pending changes.
    api.getUnattributedChangesBySheet.mockResolvedValue([]);
    const handler = getHandler(api, 'get_unattributed_changes');

    const result = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Acruals',
    });

    // Assert on the REFUSAL, not on a count — "0 changes" passes against the
    // broken behaviour this test exists to catch.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Project Acruals');
    expect(result.content[0].text).not.toContain(
      'No unattributed changes on sheet',
    );
  });

  it('get_cell_history refuses a sheet the workbook does not have', async () => {
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue([]);
    const handler = getHandler(api, 'get_cell_history');

    const result = await handler({
      fileMsId: 'file-1',
      sheetName: 'Project Acruals',
      cellAddress: 'BS11',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Project Acruals');
    expect(result.content[0].text).not.toContain('No history found');
  });
});
