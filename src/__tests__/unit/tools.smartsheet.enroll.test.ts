import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * Adding a Smartsheet sheet through `enroll_file`, the tool that already adds
 * Microsoft and Google files. Split out of `tools.smartsheet.discovery.test.ts`
 * to keep both under the 300-line cap. What is pinned is the route taken and
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

const SHEET = { id: '4583173393803140', name: 'Q4 Forecast' };

describe('enroll_file with provider smartsheet', () => {
  it('enrolls under the Smartsheet account type by sheet id', async () => {
    const api = createMockApiClient();
    const result = await handler(api, 'enroll_file')({
      provider: 'smartsheet',
      msId: SHEET.id,
      share_with: 'me',
    });
    expect(outcomeOf(result)).toBe('enrolled');
    expect(api.createEnrolledFile).toHaveBeenCalledWith({
      provider: 'smartsheet',
      fileId: SHEET.id,
      driveMsId: '',
      name: '',
    });
    expect(api.getEnrollmentInfo).not.toHaveBeenCalled();
    expect(api.resolveEnrollmentUrl).not.toHaveBeenCalled();
  });

  it('reports a sheet already in Rockhopper without writing', async () => {
    const api = createMockApiClient();
    api.listEnrolledFiles.mockResolvedValue([
      {
        internalId: 5,
        platformId: SHEET.id,
        fileType: 'smartsheet_sheet',
        name: SHEET.name,
      },
    ]);
    const result = await handler(api, 'enroll_file')({
      provider: 'smartsheet',
      msId: SHEET.id,
      share_with: 'me',
    });
    expect(outcomeOf(result)).toBe('already_enrolled');
    expect(result.content[0].text).toContain('Q4 Forecast');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('refuses a link or a drive id alongside the sheet id', async () => {
    const api = createMockApiClient();
    const run = handler(api, 'enroll_file');
    for (const extra of [{ url: 'https://app.smartsheet.com/sheets/x' }, { driveMsId: 'd' }]) {
      const result = await run({
        provider: 'smartsheet',
        msId: SHEET.id,
        share_with: 'me',
        ...extra,
      });
      expect(result.isError).toBe(true);
      expect(outcomeOf(result)).toBe('unresolvable');
    }
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('an unproven access names connect_smartsheet, never connect_microsoft', async () => {
    const api = createMockApiClient();
    api.createEnrolledFile.mockRejectedValue(
      new RockhopperApiError(403, 'x', 'ACCESS_UNPROVEN'),
    );
    const result = await handler(api, 'enroll_file')({
      provider: 'smartsheet',
      msId: SHEET.id,
      share_with: 'me',
    });
    expect(outcomeOf(result)).toBe('access_unproven');
    expect(result.content[0].text).toContain('connect_smartsheet');
    expect(result.content[0].text).not.toContain('connect_microsoft');
  });

  it('a report or dashboard is refused as unsupported', async () => {
    const api = createMockApiClient();
    api.createEnrolledFile.mockRejectedValue(
      new RockhopperApiError(422, 'x', 'SMARTSHEET_UNSUPPORTED_OBJECT'),
    );
    const result = await handler(api, 'enroll_file')({
      provider: 'smartsheet',
      msId: '77',
      share_with: 'me',
    });
    expect(outcomeOf(result)).toBe('unsupported_provider');
    expect(result.content[0].text).toContain('report or a dashboard');
  });

  it('positive control: a Microsoft id pair still enrolls under the Microsoft account type', async () => {
    const api = createMockApiClient();
    await handler(api, 'enroll_file')({
      driveMsId: 'drive-9',
      msId: 'item-9',
      share_with: 'me',
    });
    expect(api.getEnrollmentInfo).toHaveBeenCalledWith(['item-9'], 'microsoft');
    expect(api.createEnrolledFile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'microsoft', fileId: 'item-9' }),
    );
  });
});
