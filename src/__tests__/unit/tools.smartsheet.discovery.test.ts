import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * Finding and adding a Smartsheet sheet through the tools that already find
 * and add Microsoft and Google files. What is pinned is the route taken and
 * the remedy named, not only that a call returned.
 */
type Api = ReturnType<typeof createMockApiClient>;
type Result = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function handler(api: Api, name: string, caps = ['files:write']) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any, { capabilities: caps as any });
  return server.registerTool.mock.calls.find((c) => c[0] === name)![2] as (
    args: Record<string, unknown>,
  ) => Promise<Result>;
}

const lastLine = (r: Result) => r.content[0].text.split('\n').at(-1) ?? '{}';
const outcomeOf = (r: Result) =>
  (JSON.parse(lastLine(r)) as { outcome: string }).outcome;

const SHEET = {
  kind: 'sheet',
  id: '4583173393803140',
  name: 'Q4 Forecast',
  permalink: 'https://app.smartsheet.com/sheets/abc',
  enrollable: true,
  unsupportedReason: null,
};
const REPORT = {
  kind: 'report',
  id: '77',
  name: 'Weekly report',
  permalink: null,
  enrollable: false,
  unsupportedReason: 'reports_and_dashboards_not_tracked',
};

const notConnected = () =>
  new RockhopperApiError(
    403,
    'no',
    'SMARTSHEET_CONNECT_REQUIRED',
    null,
    'Connect your Smartsheet account to add this sheet',
  );
/** Neither the user's own link nor an organization connector is usable. */
const noOrgConnector = () =>
  new RockhopperApiError(403, 'no', 'SMARTSHEET_ORG_CONNECTOR_REQUIRED');
const ADMIN_REMEDY = 'An administrator of their organization';

describe('search_drive_files with provider smartsheet', () => {
  it('searches Smartsheet, never the Microsoft route, and lists sheets only', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockResolvedValue({
      query: 'forecast',
      totalCount: 2,
      items: [SHEET, REPORT],
    });
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(api.searchSmartsheet).toHaveBeenCalledWith('forecast');
    expect(api.searchDriveFiles).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain('Q4 Forecast');
    expect(text).toContain('not in Rockhopper yet');
    expect(text).not.toContain('Weekly report');
  });

  it('marks a sheet Rockhopper already holds as already added', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockResolvedValue({
      query: 'forecast',
      totalCount: 1,
      items: [SHEET],
    });
    api.listEnrolledFiles.mockResolvedValue([
      {
        internalId: 5,
        platformId: SHEET.id,
        fileType: 'smartsheet_sheet',
        name: SHEET.name,
      },
    ]);
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(result.content[0].text).toContain('already in Rockhopper');
  });

  it('a user with no Smartsheet connection gets the Smartsheet remedy, never a Microsoft link', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockRejectedValue(notConnected());
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(outcomeOf(result)).toBe('smartsheet_not_connected');
    expect(api.beginSmartsheetConnect).toHaveBeenCalled();
    expect(api.beginMicrosoftConnect).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('app.smartsheet.com');
    expect(result.content[0].text).not.toContain('login.microsoftonline.com');
    expect(result.content[0].text).not.toContain(ADMIN_REMEDY);
  });

  it('a user whose organization has no connector is sent to an administrator, with no connect link', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockRejectedValue(noOrgConnector());
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(api.searchSmartsheet).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(outcomeOf(result)).toBe('search_refused');
    expect(result.content[0].text).toContain(ADMIN_REMEDY);
    expect(result.content[0].text).toContain('NOT evidence');
    expect(api.beginSmartsheetConnect).not.toHaveBeenCalled();
  });

  it('a Smartsheet search with no usable query is refused before any call', async () => {
    const api = createMockApiClient();
    const run = handler(api, 'search_drive_files');
    for (const args of [
      { provider: 'smartsheet' },
      { provider: 'smartsheet', query: 'a' },
      { provider: 'smartsheet', scope: 'recent' },
    ]) {
      const result = await run(args);
      expect(result.isError).toBe(true);
      expect(outcomeOf(result)).toBe('search_unavailable');
    }
    expect(api.searchSmartsheet).not.toHaveBeenCalled();
  });

  it('confirming a Smartsheet pick hands back the sheet id for enroll_file', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockResolvedValue({
      query: 'forecast',
      totalCount: 1,
      items: [SHEET],
    });
    const run = handler(api, 'search_drive_files');
    const first = await run({ query: 'forecast', provider: 'smartsheet' });
    const token = (JSON.parse(lastLine(first)) as { confirmToken: string })
      .confirmToken;
    const confirmed = await run({ confirm_index: 1, confirm_token: token });
    expect(outcomeOf(confirmed)).toBe('confirmed');
    const detail = JSON.parse(lastLine(confirmed)) as Record<string, unknown>;
    expect(detail.provider).toBe('smartsheet');
    expect(detail.msId).toBe(SHEET.id);
  });

  it('positive control: a Microsoft search still takes the Microsoft route', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockResolvedValue({ scope: 'search', items: [] });
    await handler(api, 'search_drive_files')({ query: 'budget' });
    expect(api.searchDriveFiles).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'budget', provider: undefined }),
    );
    expect(api.searchSmartsheet).not.toHaveBeenCalled();
  });
});

describe('list_unenrolled_files with provider smartsheet', () => {
  it('lists sheets not yet added, containers to open, and what is not tracked', async () => {
    const api = createMockApiClient();
    api.browseSmartsheet.mockResolvedValue({
      parent: { parentType: 'home', parentId: null },
      items: [
        SHEET,
        { ...SHEET, id: '9', name: 'Already here' },
        {
          kind: 'folder',
          id: '55',
          name: 'Finance',
          permalink: null,
          enrollable: false,
          unsupportedReason: null,
        },
        REPORT,
      ],
    });
    api.listEnrolledFiles.mockResolvedValue([
      { internalId: 1, platformId: '9', fileType: 'smartsheet_sheet', name: 'x' },
    ]);
    const result = await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
    });
    const text = result.content[0].text;
    expect(api.listDriveInventory).not.toHaveBeenCalled();
    expect(text).toContain('1 sheet(s) not yet in Rockhopper');
    expect(text).toContain('Q4 Forecast');
    expect(text).toContain('sheetId: 4583173393803140');
    expect(text).not.toContain('Already here');
    expect(text).toContain('parentType="folder", parentId="55"');
    expect(text).toContain('1 report(s) or dashboard(s)');
  });

  it('opens a folder with the parent the caller named', async () => {
    const api = createMockApiClient();
    await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
      parentType: 'folder',
      parentId: '55',
    });
    expect(api.browseSmartsheet).toHaveBeenCalledWith({
      parentType: 'folder',
      parentId: '55',
    });
  });

  it('an empty location says it is an answer about that location only', async () => {
    const result = await handler(createMockApiClient(), 'list_unenrolled_files')(
      { provider: 'smartsheet' },
    );
    expect(result.content[0].text).toContain('one location only');
  });

  it('a user with no connection is told to connect, and that this is not "no sheets"', async () => {
    const api = createMockApiClient();
    api.browseSmartsheet.mockRejectedValue(notConnected());
    const result = await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connect_smartsheet');
    expect(result.content[0].text).toContain('NOT evidence');
    expect(result.content[0].text).not.toContain(ADMIN_REMEDY);
  });

  it('a user whose organization has no connector is sent to an administrator', async () => {
    const api = createMockApiClient();
    api.browseSmartsheet.mockRejectedValue(noOrgConnector());
    const result = await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
    });
    expect(api.browseSmartsheet).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(ADMIN_REMEDY);
    expect(result.content[0].text).toContain('NOT evidence');
    expect(result.content[0].text).not.toContain('connect_smartsheet');
  });

  it('a parent type without an id is refused', async () => {
    const api = createMockApiClient();
    const result = await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
      parentType: 'folder',
    });
    expect(result.isError).toBe(true);
    expect(api.browseSmartsheet).not.toHaveBeenCalled();
  });

  it('positive control: without a provider the stored inventory is still read', async () => {
    const api = createMockApiClient();
    await handler(api, 'list_unenrolled_files')({});
    expect(api.listDriveInventory).toHaveBeenCalled();
    expect(api.browseSmartsheet).not.toHaveBeenCalled();
  });
});
