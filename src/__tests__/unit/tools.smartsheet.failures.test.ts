import { describe, expect, it } from 'vitest';
import { accountLinkFor } from '../../account-link-providers.js';
import { RockhopperApiError } from '../../api-client.js';
import type { FileProvider } from '../../types.js';
import {
  classifySmartsheetEnrollment,
  classifySmartsheetFailure,
} from '../../smartsheet-discovery.js';
import { registerTools } from '../../tools/index.js';
import { smartsheetParentProblem } from '../../tools/list-unenrolled-smartsheet.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * How each failed Smartsheet call is named to the assistant. Every refusal is
 * pinned by the outcome or text that only its own branch produces, next to a
 * positive control that takes the ordinary path on the same fixture.
 */
type Api = ReturnType<typeof createMockApiClient>;
type Result = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function handler(api: Api, name: string) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any, { scope: 'read-write' });
  return server.registerTool.mock.calls.find((c) => c[0] === name)![2] as (
    args: Record<string, unknown>,
  ) => Promise<Result>;
}

const lastLine = (r: Result) => r.content[0].text.split('\n').at(-1) ?? '{}';
const outcomeOf = (r: Result) =>
  (JSON.parse(lastLine(r)) as { outcome: string }).outcome;

const apiError = (status: number, code: string | null = null) =>
  new RockhopperApiError(status, `Rockhopper API ${status}`, code, null);

const ADMIN_REMEDY = 'An administrator of their organization';

describe('classifySmartsheetFailure', () => {
  it.each([
    [404, 'backend_unsupported', 'cannot reach Smartsheet from an assistant'],
    [400, 'search_unavailable', 'at least two characters'],
    [401, 'search_refused', 'trying again will not change that'],
    [403, 'search_refused', 'trying again will not change that'],
    [503, 'search_unavailable', 'do not tell them they have none'],
  ])('a %i is %s, with its own remedy', (status, outcome, phrase) => {
    const failure = classifySmartsheetFailure(apiError(status));
    expect(failure.outcome).toBe(outcome);
    expect(failure.message).toContain(phrase);
  });

  it('a 403 naming the missing organization connector sends the user to an administrator', () => {
    const failure = classifySmartsheetFailure(
      apiError(403, 'SMARTSHEET_ORG_CONNECTOR_REQUIRED'),
    );
    expect(failure.outcome).toBe('search_refused');
    expect(failure.message).toContain(ADMIN_REMEDY);
    expect(failure.message).not.toContain('check their access');
    // Positive control, same status: a bare 403 keeps the generic remedy.
    expect(classifySmartsheetFailure(apiError(403)).message).toContain(
      'check their access',
    );
  });

  it('an error that is not from the API keeps its own message', () => {
    expect(classifySmartsheetFailure(new Error('socket hang up'))).toEqual({
      outcome: 'search_unavailable',
      message: 'socket hang up',
    });
    expect(classifySmartsheetFailure('boom').message).toBe('boom');
  });
});

describe('classifySmartsheetEnrollment', () => {
  it('positive control: an unproven access names connect_smartsheet', () => {
    const named = classifySmartsheetEnrollment(apiError(403, 'ACCESS_UNPROVEN'));
    expect(named?.outcome).toBe('access_unproven');
    expect(named?.message).toContain('connect_smartsheet');
  });

  it('a denied sheet asks for a share, and says retrying will not help', () => {
    const named = classifySmartsheetEnrollment(
      apiError(403, 'FILE_ACCESS_DENIED'),
    );
    expect(named?.outcome).toBe('access_unproven');
    expect(named?.message).toContain("Ask the sheet's owner to share it");
    expect(named?.message).not.toContain('connect_smartsheet');
  });

  it('a code it does not own, or a non-API error, is left to the general classifier', () => {
    expect(classifySmartsheetEnrollment(apiError(409, 'SOMETHING_ELSE'))).toBeNull();
    expect(classifySmartsheetEnrollment(new Error('x'))).toBeNull();
  });
});

describe('search_drive_files with provider smartsheet, when a call fails', () => {
  const notConnected = () => apiError(403, 'SMARTSHEET_CONNECT_REQUIRED');

  it('positive control: a connect link is handed over when the backend builds one', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockRejectedValue(notConnected());
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(outcomeOf(result)).toBe('smartsheet_not_connected');
    expect(result.content[0].text).toContain('app.smartsheet.com');
    expect(result.content[0].text).not.toContain(ADMIN_REMEDY);
  });

  it('a missing organization connector names the administrator and mints no link', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockRejectedValue(
      apiError(403, 'SMARTSHEET_ORG_CONNECTOR_REQUIRED'),
    );
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(result.isError).toBe(true);
    expect(outcomeOf(result)).toBe('search_refused');
    expect(result.content[0].text).toContain(ADMIN_REMEDY);
    expect(result.content[0].text).not.toContain('app.smartsheet.com');
    expect(api.beginSmartsheetConnect).not.toHaveBeenCalled();
  });

  it('no link could be built: the Smartsheet fallback, never a composed link', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockRejectedValue(notConnected());
    api.beginSmartsheetConnect.mockRejectedValue(new Error('backend down'));
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(api.beginSmartsheetConnect).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(outcomeOf(result)).toBe('smartsheet_not_connected');
    expect(result.content[0].text).toContain(
      'could not produce a sign-in link just now',
    );
    expect(result.content[0].text).toContain('connect_smartsheet');
    expect(result.content[0].text).not.toContain('app.smartsheet.com');
  });

  it('an outage is search_unavailable and says nothing about the sheets', async () => {
    const api = createMockApiClient();
    api.searchSmartsheet.mockRejectedValue(apiError(502));
    const result = await handler(api, 'search_drive_files')({
      query: 'forecast',
      provider: 'smartsheet',
    });
    expect(result.isError).toBe(true);
    expect(outcomeOf(result)).toBe('search_unavailable');
    expect(result.content[0].text).toContain('Smartsheet could not answer');
    expect(api.beginSmartsheetConnect).not.toHaveBeenCalled();
  });
});

describe('list_unenrolled_files with provider smartsheet, when a call fails', () => {
  it('an outage says the listing failed, not that there are no sheets', async () => {
    const api = createMockApiClient();
    api.browseSmartsheet.mockRejectedValue(new Error('gateway timeout'));
    const result = await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
    });
    expect(api.browseSmartsheet).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Could not list the Smartsheet sheets: gateway timeout.',
    );
    expect(result.content[0].text).toContain('do not report that they have none');
  });

  it.each([
    ['SMARTSHEET_CONNECT_REQUIRED', 'connect_smartsheet', ADMIN_REMEDY],
    ['SMARTSHEET_ORG_CONNECTOR_REQUIRED', ADMIN_REMEDY, 'connect_smartsheet'],
  ])('a %s refusal names its own remedy only', async (code, own, other) => {
    const api = createMockApiClient();
    api.browseSmartsheet.mockRejectedValue(apiError(403, code));
    const result = await handler(api, 'list_unenrolled_files')({
      provider: 'smartsheet',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(own);
    expect(result.content[0].text).not.toContain(other);
    expect(result.content[0].text).not.toContain('Could not list');
  });

  it('names the missing half of a parent pair, either way round', () => {
    expect(smartsheetParentProblem(undefined, undefined)).toBeNull();
    expect(smartsheetParentProblem('folder', '991')).toBeNull();
    expect(smartsheetParentProblem('folder', undefined)).toContain(
      'Send `parentId` with `parentType`',
    );
    expect(smartsheetParentProblem(undefined, '991')).toContain(
      'Send `parentType` ("workspace" or "folder") with `parentId`',
    );
  });
});

describe('get_file_comments when the file type cannot be read', () => {
  const COMMENT = {
    internalId: 1,
    message: 'check this',
    authorName: 'Ana',
    createdAt: '2026-11-01T00:00:00Z',
    resolved: false,
    cellReference: 'A7',
    replies: [],
  };

  it('positive control: a Smartsheet file prints the row', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue({
      internalId: 21,
      platformId: '4583173393803140',
      fileType: 'smartsheet_sheet',
      driveMsId: '',
      name: 'Q4 Forecast',
      hasUncommittedChanges: false,
    });
    api.getFileComments.mockResolvedValue([COMMENT]);
    const result = await handler(api, 'get_file_comments')({
      fileMsId: '4583173393803140',
    });
    expect(result.content[0].text).toContain('**Ana** [row 7]');
  });

  it('still lists the comments, with the generic location', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockRejectedValue(new Error('lookup failed'));
    api.getFileComments.mockResolvedValue([COMMENT]);
    const result = await handler(api, 'get_file_comments')({
      fileMsId: '4583173393803140',
    });
    expect(api.getEnrolledFile).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('**Ana** [A7]');
    expect(result.content[0].text).not.toContain('[row 7]');
  });
});

describe('accountLinkFor', () => {
  it('positive control: each provider gets its own link row', () => {
    expect(accountLinkFor('smartsheet').key).toBe('smartsheet');
    expect(accountLinkFor('google').key).toBe('google');
    expect(accountLinkFor('microsoft').key).toBe('microsoft');
  });

  it('a provider outside the union throws by name instead of borrowing a remedy', () => {
    expect(() => accountLinkFor('dropbox' as unknown as FileProvider)).toThrow(
      'Unknown file provider: dropbox',
    );
  });
});
