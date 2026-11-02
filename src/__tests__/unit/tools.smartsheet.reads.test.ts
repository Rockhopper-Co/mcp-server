import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { changeModelForFileType } from '../../file-type-model.js';
import { sheetCatalogueRouteFor } from '../../sheet-catalogue.js';
import { commentLocation } from '../../comment-location.js';
import { registerPrompts } from '../../prompts/index.js';
import { registerResources } from '../../resources/index.js';
import { registerTools } from '../../tools/index.js';
import { serveLedger, servedCell } from './ledger-mock.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * Reading a Smartsheet sheet through the tools that read a workbook: the file
 * type takes the spreadsheet lane BY NAME, a cell is addressed by its row and
 * column ids, and a comment reads as sitting on a row.
 */
type Api = ReturnType<typeof createMockApiClient>;

const SHEET_FILE = {
  internalId: 21,
  platformId: '4583173393803140',
  fileType: 'smartsheet_sheet',
  driveMsId: '',
  name: 'Q4 Forecast',
  hasUncommittedChanges: true,
};

const ROW = '2f9d7a52-1c44-5b3a-9e0a-5a3f0f1d0001';
const COLUMN = '8c1b6e10-7a3d-5e2b-8f11-0d9b3c7a0002';

function tool(api: Api, name: string) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any, { scope: 'read-write' });
  return server.registerTool.mock.calls.find((c) => c[0] === name)!;
}

type Result = { content: Array<{ text: string }>; isError?: boolean };

describe('the file-type seam', () => {
  it('a Smartsheet sheet takes the spreadsheet lane and has no worksheet catalogue', () => {
    expect(changeModelForFileType('smartsheet_sheet')).toBe('spreadsheet');
    expect(sheetCatalogueRouteFor('smartsheet_sheet')).toBeNull();
  });

  it('positive control: an unlisted type is still refused, not defaulted', () => {
    expect(changeModelForFileType('smartsheet_dashboard')).toBeNull();
    expect(changeModelForFileType('microsoft_xlsx')).toBe('spreadsheet');
  });
});

describe('the change read reaches the spreadsheet lane for a Smartsheet file', () => {
  const overview = async (api: Api) => {
    const server = createMockMcpServer();
    registerPrompts(server as never, api as never);
    const handler = server.registerPrompt.mock.calls.find(
      (c) => c[0] === 'file-overview',
    )![2] as (a: { fileMsId: string }) => Promise<{
      messages: Array<{ content: { text: string } }>;
    }>;
    return (await handler({ fileMsId: SHEET_FILE.platformId })).messages[0]
      .content.text;
  };

  it('counts the rows the ledger holds, from the compare route of that file', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue(SHEET_FILE);
    serveLedger(api, [
      {
        name: 'Sheet1',
        cells: [servedCell({ cell: 'B2' }), servedCell({ cell: 'B3' })],
      },
    ]);
    const text = await overview(api);
    expect(api.getCompareSummary).toHaveBeenCalledWith(21);
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
    expect(text).toContain('## Unattributed Changes: 2\n');
  });

  it('positive control: the same call on a sheet with no rows says zero', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue(SHEET_FILE);
    serveLedger(api, [{ name: 'Sheet1', cells: [] }]);
    const text = await overview(api);
    expect(api.getCompareSummary).toHaveBeenCalledWith(21);
    expect(text).toContain('## Unattributed Changes: 0\n');
  });

  it('the changes resource reads the same lane', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue(SHEET_FILE);
    serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'C4' })] }]);
    const server = createMockMcpServer();
    registerResources(server as never, api as never);
    const handler = server.registerResource.mock.calls.find(
      (c) => c[0] === 'unattributed-changes',
    )![3] as (
      uri: URL,
      vars: Record<string, unknown>,
    ) => Promise<{ contents: Array<{ text: string }> }>;
    const out = await handler(
      new URL('rockhopper://files/4583173393803140/changes'),
      { fileMsId: SHEET_FILE.platformId },
    );
    expect(api.getCompareSummary).toHaveBeenCalledWith(21);
    expect(out.contents[0].text).toContain('C4');
  });
});

describe('get_cell_history by row and column id', () => {
  const ENTRY = {
    eventId: '1',
    eventType: 'edit',
    valueKind: 'value',
    fromValue: { v: 'draft' },
    toValue: { v: 'final' },
    provenance: 'webhook',
    actorKind: 'human',
    actorPlatformId: 'ss-user-1',
    valueConfidence: 'high',
    attributionConfidence: 'credential_bound',
    coalesced: false,
    changedAt: '2026-11-01T10:00:00.000Z',
  };

  it('reads the row and column route by the file id and prints the rows', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue(SHEET_FILE);
    api.getSmartsheetCellHistory.mockResolvedValue({
      rowAnchorId: ROW,
      columnAnchorId: COLUMN,
      history: [ENTRY, { ...ENTRY, coalesced: true }],
      truncated: false,
    });
    const [, , handler] = tool(api, 'get_cell_history');
    const result = (await handler({
      fileMsId: SHEET_FILE.platformId,
      rowAnchorId: ROW,
      columnAnchorId: COLUMN,
    })) as Result;
    expect(api.getSmartsheetCellHistory).toHaveBeenCalledWith(
      SHEET_FILE.platformId,
      ROW,
      COLUMN,
    );
    expect(api.getCellHistory).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain('2 change(s), oldest first');
    expect(text).toContain('"draft" -> "final"');
    expect(text).toContain('by human ss-user-1');
    expect(text).toContain('only the first and last values are kept');
  });

  it('an empty answer is about this one cell, not the sheet', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue(SHEET_FILE);
    const [, , handler] = tool(api, 'get_cell_history');
    const result = (await handler({
      fileMsId: SHEET_FILE.platformId,
      rowAnchorId: ROW,
      columnAnchorId: COLUMN,
    })) as Result;
    expect(result.content[0].text).toContain('that one cell');
    expect(result.content[0].text).toContain('never grounds');
  });

  it('refuses the anchors on a file that is not a Smartsheet sheet, as a refusal', async () => {
    const api = createMockApiClient();
    const [, , handler] = tool(api, 'get_cell_history');
    const result = (await handler({
      fileMsId: 'file-1',
      rowAnchorId: ROW,
      columnAnchorId: COLUMN,
    })) as Result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Smartsheet sheet only');
    expect(api.getSmartsheetCellHistory).not.toHaveBeenCalled();
  });

  it('the schema takes the pair alone and refuses mixed address forms', () => {
    const [, spec] = tool(createMockApiClient(), 'get_cell_history');
    const parse = (args: Record<string, unknown>) =>
      spec.inputSchema.safeParse({ fileMsId: 'f', ...args }).success;
    expect(parse({ rowAnchorId: ROW, columnAnchorId: COLUMN })).toBe(true);
    expect(parse({ rowAnchorId: ROW })).toBe(false);
    expect(
      parse({ rowAnchorId: ROW, columnAnchorId: COLUMN, anchorId: 'a' }),
    ).toBe(false);
    expect(
      parse({
        rowAnchorId: ROW,
        columnAnchorId: COLUMN,
        sheetName: 'S',
        cellAddress: 'A1',
      }),
    ).toBe(false);
    // Positive control: the existing forms still pass.
    expect(parse({ sheetName: 'S', cellAddress: 'A1' })).toBe(true);
    expect(parse({ anchorId: 'a' })).toBe(true);
  });

  it('positive control: a Microsoft cell is still read through the A1 route', async () => {
    const api = createMockApiClient();
    const [, , handler] = tool(api, 'get_cell_history');
    await handler({ fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'A1' });
    expect(api.getCellHistory).toHaveBeenCalled();
    expect(api.getSmartsheetCellHistory).not.toHaveBeenCalled();
  });
});

describe('comment locations', () => {
  const chat = (cellReference: string | null) =>
    ({ cellReference, anchor: null }) as any;

  it('a row-level Smartsheet comment reads as its row, a sheet-level one is labelled', () => {
    expect(commentLocation(chat('A5'), 'smartsheet_sheet')).toBe(' [row 5]');
    expect(commentLocation(chat(null), 'smartsheet_sheet')).toBe(
      ' [whole sheet]',
    );
  });

  it('positive control: other file types keep their location text', () => {
    expect(commentLocation(chat('A5'), 'microsoft_xlsx')).toBe(' [A5]');
    expect(commentLocation(chat('A5'))).toBe(' [A5]');
    expect(commentLocation(chat(null), 'microsoft_xlsx')).toBe('');
  });

  it('get_file_comments labels the location by the file type', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue(SHEET_FILE);
    api.getFileComments.mockResolvedValue([
      {
        internalId: 1,
        message: 'check this',
        authorName: 'Ana',
        createdAt: '2026-11-01T00:00:00Z',
        resolved: false,
        cellReference: 'A7',
        replies: [],
      },
      {
        internalId: 2,
        message: 'overall note',
        authorName: 'Ben',
        createdAt: '2026-11-01T00:00:00Z',
        resolved: false,
        cellReference: null,
        replies: [],
      },
    ]);
    const [, , handler] = tool(api, 'get_file_comments');
    const text = ((await handler({ fileMsId: '4583173393803140' })) as Result)
      .content[0].text;
    expect(text).toContain('**Ana** [row 7]');
    expect(text).toContain('**Ben** [whole sheet]');
  });
});

describe('the cell-history requests on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function wired() {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: () => Promise.resolve([]),
        text: () => Promise.resolve('[]'),
      });
    });
    const client = new ApiClient({ baseUrl: 'https://api.test', token: 't' });
    return { seen, client };
  }

  it('a Smartsheet cell asks the file-versions route with the two anchors only', async () => {
    const { seen, client } = wired();
    await client.getSmartsheetCellHistory('4583173393803140', ROW, COLUMN);
    expect(seen).toEqual([
      'https://api.test/file-versions/file/4583173393803140/cell-history' +
        `?rowAnchorId=${ROW}&columnAnchorId=${COLUMN}`,
    ]);
  });

  it('positive control: the A1 request is byte-identical to before', async () => {
    const { seen, client } = wired();
    await client.getCellHistory('file-1', 'Sheet1', 'B2');
    expect(seen).toEqual([
      'https://api.test/file-versions/file/file-1/cell-history' +
        '?cell=B2&sheetName=Sheet1&format=mcp',
    ]);
  });
});
