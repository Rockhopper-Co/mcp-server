import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2200 (plan 13 / SP03) — every outcome `enroll_file` can reach.
 *
 * The two specs that matter most are negative ones, and they are the reason
 * this file exists rather than a happy-path smoke test:
 *
 * - a HIDDEN file must not be enrolled and must not be un-hidden without an
 *   explicit `confirm_restore` (D8). "Already enrolled", said to somebody who
 *   deliberately removed the file, is the ENG-1647 dead end rebuilt.
 * - an omitted `share_with` must return the QUESTION, never a default. A
 *   default is invisible: nobody notices a file was shared with the wrong
 *   audience until they cannot find it, or until they find it and should not
 *   have.
 */

type Api = ReturnType<typeof createMockApiClient>;

function handlerFor(api: Api) {
  const server = createMockMcpServer();
  registerTools(server as never, api as never, { capabilities: ['files:write'] });
  const call = server.registerTool.mock.calls.find((c) => c[0] === 'enroll_file');
  return call?.[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/** The JSON object every answer carries so a model can branch without prose. */
function outcomeOf(result: { content: Array<{ text: string }> }): string {
  const line = result.content[0].text.split('\n').at(-1) ?? '{}';
  return (JSON.parse(line) as { outcome: string }).outcome;
}

const URL = 'https://contoso.sharepoint.com/:x:/r/sites/finance/Doc.aspx';

/** A refusal exactly as `ApiClient.request` builds one, code included. */
function apiError(status: number, code: string | null) {
  return new RockhopperApiError(status, `Rockhopper API ${status}`, code);
}

describe('enroll_file registration', () => {
  it('is registered under files:write, not under any other family', () => {
    for (const capability of ['comments:write', 'reviews:write', 'versions:write']) {
      const server = createMockMcpServer();
      registerTools(server as never, createMockApiClient() as never, {
        capabilities: [capability],
      });
      expect(server.registerTool.mock.calls.map((c) => c[0])).not.toContain(
        'enroll_file',
      );
    }
  });

  it('is withheld from a read-only token', () => {
    const server = createMockMcpServer();
    registerTools(server as never, createMockApiClient() as never, {
      scope: 'read-only',
    });
    expect(server.registerTool.mock.calls.map((c) => c[0])).not.toContain(
      'enroll_file',
    );
  });

  it('tells the model it is Microsoft-only and that it must ask about sharing', () => {
    const server = createMockMcpServer();
    registerTools(server as never, createMockApiClient() as never, {
      capabilities: ['files:write'],
    });
    const spec = server.registerTool.mock.calls.find(
      (c) => c[0] === 'enroll_file',
    )?.[1] as { description: string };

    expect(spec.description).toContain('MICROSOFT ONLY');
    expect(spec.description).toContain('share_with');
    // The broken-stream promise: a re-call after a lost answer is safe.
    expect(spec.description).toContain('already_enrolled');
  });
});

describe('share_with is required and never defaulted (D5/D6)', () => {
  it('returns the QUESTION rather than enrolling when it is omitted', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({ url: URL });

    expect(outcomeOf(result)).toBe('share_with_required');
    expect(result.content[0].text).toContain('just you, or to your whole team');
    // Nothing was written, and nothing was even looked up.
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
    expect(api.resolveEnrollmentUrl).not.toHaveBeenCalled();
  });

  it('enrolls privately for share_with="me" and shares with nobody', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({ url: URL, share_with: 'me' });

    expect(outcomeOf(result)).toBe('enrolled');
    expect(api.createEnrolledFile).toHaveBeenCalledWith({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      name: 'Becklar_RMR_Model.xlsx',
    });
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
  });

  it('fans out to the teammates for share_with="team", excluding the caller', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({ url: URL, share_with: 'team' });

    expect(outcomeOf(result)).toBe('enrolled');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    // `ms-user-1` is the caller; sharing a file with yourself is not sharing.
    expect(api.enrollFileSharedWith).toHaveBeenCalledWith(
      { msId: 'ms-item-9', driveMsId: 'drive-9', name: 'Becklar_RMR_Model.xlsx' },
      ['ms-user-2'],
    );
  });

  it('asks again rather than quietly enrolling privately when there is no team', async () => {
    const api = createMockApiClient();
    api.getMe.mockResolvedValue({ internalId: 1, msId: 'ms-user-1', teamMembers: [] });
    const result = await handlerFor(api)({ url: URL, share_with: 'team' });

    expect(outcomeOf(result)).toBe('share_with_required');
    expect(result.content[0].text).toContain('not on a team');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
  });

  it('refuses a one-person team rather than sharing with nobody', async () => {
    const api = createMockApiClient();
    api.getTeam.mockResolvedValue({
      internalId: 2,
      name: 'Finance',
      teamMembers: [{ user: { msId: 'ms-user-1' } }],
    });
    const result = await handlerFor(api)({ url: URL, share_with: 'team' });

    expect(outcomeOf(result)).toBe('share_with_required');
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
  });
});

describe('a hidden file is never silently restored (D8)', () => {
  const hidden = (api: Api) => {
    api.resolveEnrollmentUrl.mockResolvedValue({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      name: 'Becklar_RMR_Model.xlsx',
      listItemUniqueId: null,
      webUrl: URL,
      enrollmentState: 'hidden',
    });
    return api;
  };

  it('asks first: no enroll call, no un-hide, without confirm_restore', async () => {
    const api = hidden(createMockApiClient());
    const result = await handlerFor(api)({ url: URL, share_with: 'me' });

    expect(outcomeOf(result)).toBe('restore_confirmation_required');
    // THE assertion. Either of these firing means the file was un-hidden
    // without the person who removed it being asked.
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
  });

  it('never answers "already enrolled" about a file the user removed', async () => {
    const api = hidden(createMockApiClient());
    const result = await handlerFor(api)({ url: URL, share_with: 'me' });

    expect(outcomeOf(result)).not.toBe('already_enrolled');
    expect(result.content[0].text).toContain('previously removed');
    expect(result.content[0].text).toContain('confirm_restore');
  });

  it('restores only on the explicit second call', async () => {
    const api = hidden(createMockApiClient());
    const result = await handlerFor(api)({
      url: URL,
      share_with: 'me',
      confirm_restore: true,
    });

    expect(outcomeOf(result)).toBe('restored');
    expect(api.createEnrolledFile).toHaveBeenCalledTimes(1);
  });

  it('holds the same line when the target arrived as an id pair', async () => {
    const api = createMockApiClient();
    api.getEnrollmentInfo.mockResolvedValue([
      { isEnrolled: false, enrollmentState: 'hidden', isInUserWorkspace: false },
    ]);
    const result = await handlerFor(api)({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      share_with: 'me',
    });

    expect(outcomeOf(result)).toBe('restore_confirmation_required');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    // The URL resolver is not consulted for an id pair.
    expect(api.resolveEnrollmentUrl).not.toHaveBeenCalled();
  });
});

describe('a file already there', () => {
  it('reports already_enrolled and writes nothing', async () => {
    const api = createMockApiClient();
    api.resolveEnrollmentUrl.mockResolvedValue({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      name: 'Budget.xlsx',
      listItemUniqueId: null,
      webUrl: URL,
      enrollmentState: 'enrolled',
    });
    const result = await handlerFor(api)({ url: URL, share_with: 'me' });

    expect(outcomeOf(result)).toBe('already_enrolled');
    expect(result.content[0].text).toContain('Budget.xlsx');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('is the answer a re-call gets after a dropped stream', async () => {
    // The backend writes the stub row synchronously before enqueueing, so the
    // second call of a retried pair sees `enrolled` — the enroll is not
    // repeated and the user is not told something ambiguous.
    const api = createMockApiClient();
    const handler = handlerFor(api);
    await handler({ url: URL, share_with: 'me' });
    api.resolveEnrollmentUrl.mockResolvedValue({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      name: 'Becklar_RMR_Model.xlsx',
      listItemUniqueId: null,
      webUrl: URL,
      enrollmentState: 'enrolled',
    });

    expect(outcomeOf(await handler({ url: URL, share_with: 'me' }))).toBe(
      'already_enrolled',
    );
    expect(api.createEnrolledFile).toHaveBeenCalledTimes(1);
  });
});

describe('refusals name the remedy, not just the status', () => {
  it('sends an unlinked session to connect_microsoft (ACCESS_UNPROVEN)', async () => {
    const api = createMockApiClient();
    api.createEnrolledFile.mockRejectedValue(apiError(403, 'ACCESS_UNPROVEN'));
    const result = await handlerFor(api)({ url: URL, share_with: 'me' });

    expect(outcomeOf(result)).toBe('access_unproven');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connect_microsoft');
  });

  it('refuses a Google link as unsupported_provider, without asking for another', async () => {
    const api = createMockApiClient();
    api.resolveEnrollmentUrl.mockRejectedValue(
      apiError(400, 'URL_UNSUPPORTED_PROVIDER'),
    );
    const result = await handlerFor(api)({
      url: 'https://docs.google.com/spreadsheets/d/abc/edit',
      share_with: 'me',
    });

    expect(outcomeOf(result)).toBe('unsupported_provider');
    expect(result.content[0].text).toContain('Microsoft');
    // Looping "paste the link again" at a Google user is the dead end.
    expect(result.content[0].text).not.toContain('paste');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('asks for the browser address when the link resolves to nothing', async () => {
    const api = createMockApiClient();
    api.resolveEnrollmentUrl.mockRejectedValue(apiError(400, 'URL_UNRESOLVABLE'));
    const result = await handlerFor(api)({ url: 'https://x.test/a', share_with: 'me' });

    expect(outcomeOf(result)).toBe('unresolvable');
    expect(result.content[0].text).toContain('browser bar');
  });

  it('says the backend is too old rather than that the file is gone (404)', async () => {
    const api = createMockApiClient();
    api.resolveEnrollmentUrl.mockRejectedValue(apiError(404, null));
    const result = await handlerFor(api)({ url: URL, share_with: 'me' });

    expect(outcomeOf(result)).toBe('backend_unsupported');
    expect(result.content[0].text).toContain('does not support');
    expect(result.content[0].text).toContain('Nothing was changed');
  });
});

describe('input shape', () => {
  it('refuses url and an id pair together rather than guessing', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({
      url: URL,
      msId: 'ms-item-1',
      driveMsId: 'drive-1',
      share_with: 'me',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(api.resolveEnrollmentUrl).not.toHaveBeenCalled();
  });

  it('asks for a link when neither input arrived', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({ share_with: 'me' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('paste');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('treats a half-supplied id pair as no file named', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({ msId: 'ms-item-9', share_with: 'me' });

    expect(result.isError).toBe(true);
    expect(api.getEnrollmentInfo).not.toHaveBeenCalled();
  });
});
