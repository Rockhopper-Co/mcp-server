import { describe, expect, it } from 'vitest';
import { registerTools } from '../index.js';
import {
  createMockApiClient,
  createMockMcpServer,
} from '../../__tests__/unit/test-helpers.js';

/**
 * ENG-4958 — `enroll_file` on a Google Drive link produces an enrolled row.
 *
 * THIS IS THE ACCEPTANCE, AND IT IS DELIBERATELY NOT A DESCRIPTION TEST. Before
 * this change the account type was the literal `'microsoft'` at all three write
 * sites in `api-client.ts`, so a Google file the backend was already willing to
 * enroll was unreachable from this package by any route. A test asserting the
 * tool's wording had changed would pass for a client that still sends
 * `accountType: 'microsoft'` for a Google file — which writes a row keyed on an
 * id nothing looks up.
 *
 * WHAT IS ASSERTED is therefore the CALL: which id field carries the Drive id,
 * which account type goes with it, and that no file type is asserted by the
 * client. The backend derives the type from the Drive mime on the caller's own
 * access probe, and a client that asserted one would be telling Rockhopper what
 * a file is rather than asking.
 */

type Api = ReturnType<typeof createMockApiClient>;

const GOOGLE_URL = 'https://docs.google.com/spreadsheets/d/drive-file-1/edit';

function handlerFor(api: Api) {
  const server = createMockMcpServer();
  registerTools(server as never, api as never, {
    capabilities: ['files:write'],
  });
  const call = server.registerTool.mock.calls.find(
    (c) => c[0] === 'enroll_file',
  );
  return call?.[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function outcomeOf(result: { content: Array<{ text: string }> }): string {
  const line = result.content[0].text.split('\n').at(-1) ?? '{}';
  return (JSON.parse(line) as { outcome: string }).outcome;
}

/** The backend's answer for a resolved Google link. */
function googleResolution(api: Api) {
  api.resolveEnrollmentUrl.mockResolvedValue({
    msId: 'drive-file-1',
    driveMsId: null,
    provider: 'google',
    name: 'Team Budget',
    listItemUniqueId: null,
    webUrl: GOOGLE_URL,
    enrollmentState: 'not_enrolled',
  });
}

describe('enroll_file reaches Google', () => {
  it('enrolls a resolved Google file under the Google account type', async () => {
    const api = createMockApiClient();
    googleResolution(api);

    const result = await handlerFor(api)({
      url: GOOGLE_URL,
      share_with: 'me',
    });

    expect(outcomeOf(result)).toBe('enrolled');
    expect(api.createEnrolledFile).toHaveBeenCalledWith({
      provider: 'google',
      fileId: 'drive-file-1',
      // A Google file has no drive id. The client sends the empty string and
      // `enrollmentBody` drops the field entirely for the Google branch.
      driveMsId: '',
      name: 'Team Budget',
    });
  });

  it('shares a Google file with the team through the same batch route', async () => {
    const api = createMockApiClient();
    googleResolution(api);

    await handlerFor(api)({ url: GOOGLE_URL, share_with: 'team' });

    expect(api.enrollFileSharedWith).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', fileId: 'drive-file-1' }),
      ['ms-user-2'],
    );
  });

  /**
   * THE PLANTED VIOLATION, kept as a test rather than as a note. Revert the
   * `provider` field in `resolveTarget` to the literal `'microsoft'` and this
   * is the assertion that goes red: the enroll still succeeds and still reports
   * `enrolled`, while writing the file into the wrong id space.
   */
  it('takes the account type from the ANSWER, never from the link shape', async () => {
    const api = createMockApiClient();
    googleResolution(api);

    await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    const sent = api.createEnrolledFile.mock.calls[0][0] as {
      provider: string;
    };
    expect(sent.provider).not.toBe('microsoft');
  });

  /**
   * A backend older than the Google lane sends no `provider` at all — this
   * package publishes to npm on its own clock and a customer's `npx` picks up
   * `latest` immediately. Absent must read as Microsoft, which is the only
   * thing such a backend resolves.
   */
  it('falls back to microsoft when the backend sends no provider', async () => {
    const api = createMockApiClient();
    api.resolveEnrollmentUrl.mockResolvedValue({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      name: 'Legacy.xlsx',
      listItemUniqueId: 'liuid-9',
      webUrl: 'https://contoso.sharepoint.com/x',
      enrollmentState: 'not_enrolled',
    });

    await handlerFor(api)({
      url: 'https://contoso.sharepoint.com/x',
      share_with: 'me',
    });

    expect(api.createEnrolledFile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'microsoft', fileId: 'ms-item-9' }),
    );
  });

  /**
   * The id pair has one honest source — `search_drive_files` — and it is
   * Microsoft's by construction, because a Google candidate carries no drive
   * id. A model that assembled a pair out of a Drive id must not turn that into
   * a Google enroll, and the state lookup must ask in the same id space.
   */
  it('treats the driveMsId + msId pair as Microsoft and asks in that id space', async () => {
    const api = createMockApiClient();

    await handlerFor(api)({
      driveMsId: 'drive-9',
      msId: 'ms-item-9',
      share_with: 'me',
    });

    expect(api.getEnrollmentInfo).toHaveBeenCalledWith(
      ['ms-item-9'],
      'microsoft',
    );
    expect(api.createEnrolledFile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'microsoft' }),
    );
  });
});
