import { describe, expect, it, vi } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { SearchBudget } from '../../drive-search.js';
import { registerDriveSearchTool } from '../../tools/drive-search.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2204 (plan 13 / SP08) — the half of ENG-1647 ENG-2200 did not fix.
 *
 * The specs that matter here are the negative ones. A happy path proves a
 * search returns files; it proves nothing about the two properties the ticket
 * is actually about:
 *
 * - a confirmation may only ever name a file THIS session's search returned,
 *   so a model that has read a hostile file name cannot conjure identifiers
 *   and have the tool bless them, and
 * - the per-session cap must refuse BEFORE the network call, because a cap
 *   that discards an answer already fetched has capped nothing.
 *
 * Both are written so that deleting the guard turns them red. Verified by
 * deleting each one — see the file's Progress note in the pull request.
 */

type Api = ReturnType<typeof createMockApiClient>;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  resultType?: string;
  inputRequests?: Record<string, unknown>;
  requestState?: string;
}

type Handler = (
  args: Record<string, unknown>,
  ctx?: unknown,
) => Promise<ToolResult>;

function handlerFor(api: Api, budget?: SearchBudget): Handler {
  const server = createMockMcpServer();
  registerDriveSearchTool(server as never, api as never, { budget });
  const call = server.registerTool.mock.calls.find(
    (c) => c[0] === 'search_drive_files',
  );
  return call?.[2] as Handler;
}

/** The JSON object every answer carries so a model can branch without prose. */
function outcomeOf(result: ToolResult): string {
  const line = result.content[0].text.split('\n').at(-1) ?? '{}';
  return (JSON.parse(line) as { outcome: string }).outcome;
}

function detailOf(result: ToolResult): Record<string, unknown> {
  const line = result.content[0].text.split('\n').at(-1) ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}

/** A 2026-07-28 request envelope, exactly as the stdio e2e spec sends one. */
const MODERN_CTX = {
  mcpReq: {
    envelope: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    requestState: () => undefined,
  },
};

describe('search_drive_files registration', () => {
  it('rides the read floor — a read-only token can find an un-enrolled file', () => {
    const server = createMockMcpServer();
    registerTools(server as never, createMockApiClient() as never, {
      scope: 'read-only',
    });
    expect(server.registerTool.mock.calls.map((c) => c[0])).toContain(
      'search_drive_files',
    );
  });

  it('tells the model to confirm with the user before enrolling', () => {
    const server = createMockMcpServer();
    registerDriveSearchTool(server as never, createMockApiClient() as never);
    const spec = server.registerTool.mock.calls[0][1] as {
      description: string;
      annotations: { readOnlyHint: boolean };
    };
    expect(spec.description).toContain('CONFIRM THE FILE WITH THE USER');
    expect(spec.description).toContain('enroll_file');
    expect(spec.annotations.readOnlyHint).toBe(true);
  });

  it('takes no authorize URL, so a model can never aim the consent', () => {
    const server = createMockMcpServer();
    registerDriveSearchTool(server as never, createMockApiClient() as never);
    const spec = server.registerTool.mock.calls[0][1] as {
      inputSchema: { shape: Record<string, unknown> };
    };
    expect(Object.keys(spec.inputSchema.shape)).toEqual([
      'query',
      'scope',
      'limit',
      'confirm_index',
      'confirm_token',
    ]);
  });
});

describe('search_drive_files — finding candidates', () => {
  it('returns every match with its enrolment state and never picks one', async () => {
    const api = createMockApiClient();
    const result = await handlerFor(api)({ query: 'Becklar' });

    expect(outcomeOf(result)).toBe('candidates');
    const text = result.content[0].text;
    // BOTH matches, because presenting one of two is the ENG-1647 failure.
    expect(text).toContain('Becklar_RMR_Model.xlsx');
    expect(text).toContain('Becklar_RMR_Model_OLD.xlsx');
    expect(text).toContain('not in Rockhopper yet');
    expect(text).toContain('already in Rockhopper');
    expect(text).toContain('DO NOT enroll any of these yet');
    expect(detailOf(result).candidateCount).toBe(2);
  });

  it('says an empty answer is an empty answer, not a failure', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockResolvedValue({ scope: 'search', items: [] });
    const result = await handlerFor(api)({ query: 'nothing' });
    expect(outcomeOf(result)).toBe('no_matches');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('did not fail');
  });

  it('defaults to a modest page rather than the backend maximum', async () => {
    const api = createMockApiClient();
    await handlerFor(api)({ query: 'Becklar' });
    expect(api.searchDriveFiles).toHaveBeenCalledWith({
      q: 'Becklar',
      scope: undefined,
      limit: 10,
    });
  });
});

describe('search_drive_files — the confirmation gate', () => {
  it('hands back the identifiers only for the candidate the user picked', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    const found = await handler({ query: 'Becklar' });
    const token = detailOf(found).confirmToken as string;

    const confirmed = await handler({ confirm_index: 2, confirm_token: token });
    expect(outcomeOf(confirmed)).toBe('confirmed');
    expect(detailOf(confirmed)).toMatchObject({
      name: 'Becklar_RMR_Model_OLD.xlsx',
      driveMsId: 'drive-9',
      msId: 'ms-item-10',
    });
    // A read tool that enrolled would be duplicating `enroll_file`'s logic,
    // including the share_with question. It hands over identifiers instead.
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
  });

  it('refuses a token this session never issued', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    await handler({ query: 'Becklar' });

    const forged = await handler({ confirm_index: 1, confirm_token: 'forged' });
    expect(outcomeOf(forged)).toBe('unknown_candidate');
    expect(forged.isError).toBe(true);
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('refuses a position outside the list it offered', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    const found = await handler({ query: 'Becklar' });
    const token = detailOf(found).confirmToken as string;

    for (const confirm_index of [3, -1, 99]) {
      const result = await handler({ confirm_index, confirm_token: token });
      expect(outcomeOf(result)).toBe('unknown_candidate');
    }
  });

  it('enrols nothing when the user declines', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    const found = await handler({ query: 'Becklar' });
    const token = detailOf(found).confirmToken as string;

    const declined = await handler({
      confirm_index: 0,
      confirm_token: token,
    });
    expect(outcomeOf(declined)).toBe('declined');
    expect(declined.isError).toBeUndefined();
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('does not re-run the search when a confirmation arrives', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    const found = await handler({ query: 'Becklar' });
    const token = detailOf(found).confirmToken as string;
    await handler({ confirm_index: 1, confirm_token: token });
    expect(api.searchDriveFiles).toHaveBeenCalledTimes(1);
  });
});

describe('search_drive_files — the per-session breadth cap', () => {
  it('stops searching once the session ceiling is reached', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api, new SearchBudget(2));

    expect(outcomeOf(await handler({ query: 'a' }))).toBe('candidates');
    expect(outcomeOf(await handler({ query: 'b' }))).toBe('candidates');
    const capped = await handler({ query: 'c' });

    expect(outcomeOf(capped)).toBe('search_limit_reached');
    expect(capped.isError).toBe(true);
    // The load-bearing assertion: the third request never reached Microsoft.
    // A cap that fetched and then discarded would leave this at 3 and would
    // have enumerated the drive anyway.
    expect(api.searchDriveFiles).toHaveBeenCalledTimes(2);
  });

  it('does not restore itself, so waiting buys nothing', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api, new SearchBudget(1));
    await handler({ query: 'a' });
    for (let i = 0; i < 5; i += 1) {
      expect(outcomeOf(await handler({ query: 'b' }))).toBe(
        'search_limit_reached',
      );
    }
    expect(api.searchDriveFiles).toHaveBeenCalledTimes(1);
  });

  it('still lets a confirmation through after the cap is reached', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api, new SearchBudget(1));
    const found = await handler({ query: 'Becklar' });
    const token = detailOf(found).confirmToken as string;
    // Capping DISCOVERY must not strand a user mid-question: the answer they
    // are about to give is about a list they have already been shown.
    expect(
      outcomeOf(await handler({ confirm_index: 1, confirm_token: token })),
    ).toBe('confirmed');
  });

  it('applies the default ceiling when no budget is supplied', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    for (let i = 0; i < 20; i += 1) {
      expect(outcomeOf(await handler({ query: `q${i}` }))).toBe('candidates');
    }
    expect(outcomeOf(await handler({ query: 'one too many' }))).toBe(
      'search_limit_reached',
    );
  });
});

describe('search_drive_files — no connected Microsoft account', () => {
  it('returns the link the BACKEND built, never one composed here', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(
      new RockhopperApiError(403, 'connect first', 'NO_DELEGATED_TOKEN'),
    );
    const result = await handlerFor(api)({ query: 'Becklar' });

    expect(outcomeOf(result)).toBe('microsoft_not_connected');
    expect(api.beginMicrosoftConnect).toHaveBeenCalled();
    expect(result.content[0].text).toContain(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=real-client',
    );
    expect(result.content[0].text).toContain(
      'Do not compose a sign-in link yourself',
    );
  });

  it('points at connect_microsoft when even the link cannot be minted', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(
      new RockhopperApiError(403, 'connect first', 'NO_DELEGATED_TOKEN'),
    );
    api.beginMicrosoftConnect.mockRejectedValue(new Error('down'));
    const result = await handlerFor(api)({ query: 'Becklar' });

    expect(outcomeOf(result)).toBe('microsoft_not_connected');
    expect(result.content[0].text).toContain('connect_microsoft');
  });
});

/**
 * ENG-2614 — the three tenant states, from the assistant's side.
 *
 * All three arrive as HTTP 403 with the same coarse `NO_DELEGATED_TOKEN`
 * code, so only the fine `reason` tells them apart. Getting this wrong is
 * not a cosmetic copy bug: it hands a user who cannot consent a link to a
 * Microsoft screen that refuses them, then offers the same link again.
 */
describe('search_drive_files — the three tenant consent states', () => {
  function refusal(reason: string) {
    return new RockhopperApiError(
      403,
      'no delegated token',
      'NO_DELEGATED_TOKEN',
      reason,
    );
  }

  it('never consented: names the administrator and offers NO connect link', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(refusal('CONSENT_REQUIRED'));
    const result = await handlerFor(api)({ query: 'Becklar' });

    expect(outcomeOf(result)).toBe('microsoft_admin_approval_required');
    // The link is the loop. Minting one here sends the user to a Microsoft
    // screen that refuses them and returns them to this exact answer.
    expect(api.beginMicrosoftConnect).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain('administrator');
    expect(text).toContain(
      'https://docs.rockhopper.co/it-setup/approve-file-access',
    );
    expect(text).not.toContain('login.microsoftonline.com');
    // A model told only "could not connect" offers to try again, and every
    // retry is another dead end for the user.
    expect(text).toContain('Do not retry');
  });

  it('consented but never linked: the ordinary connect link, unchanged', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(refusal('NO_DELEGATED_TOKEN'));
    const result = await handlerFor(api)({ query: 'Becklar' });

    expect(outcomeOf(result)).toBe('microsoft_not_connected');
    expect(api.beginMicrosoftConnect).toHaveBeenCalled();
  });

  it('revoked after the fact: reconnect, NOT ask an administrator', async () => {
    // The state nobody writes a test for. The tenant DID approve
    // Rockhopper, so an administrator has nothing left to do — the user's
    // own grant died and only the user can revive it. Sending them to IT
    // here wastes an administrator's time and does not fix anything.
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(
      refusal('DELEGATED_TOKEN_REJECTED'),
    );
    const result = await handlerFor(api)({ query: 'Becklar' });

    expect(outcomeOf(result)).toBe('microsoft_not_connected');
    expect(api.beginMicrosoftConnect).toHaveBeenCalled();
    expect(result.content[0].text).not.toContain('administrator');
  });

  it('a backend that sends no reason at all still gets the connect link', async () => {
    // Every deployment predating the reason field, and the npm package
    // ships on its own clock — an absent reason must read as the old
    // behaviour, not as an administrator problem.
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(
      new RockhopperApiError(403, 'no token', 'NO_DELEGATED_TOKEN'),
    );
    expect(outcomeOf(await handlerFor(api)({ query: 'Becklar' }))).toBe(
      'microsoft_not_connected',
    );
  });
});

describe('search_drive_files — confirmation lanes', () => {
  it('asks through input_required on a 2026-07-28 request', async () => {
    const result = await handlerFor(createMockApiClient())(
      { query: 'Becklar' },
      MODERN_CTX,
    );
    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests?.confirm_file).toBeTruthy();
    expect(result.requestState).toBeTruthy();
  });

  it('resolves a retried input_required answer against server memory', async () => {
    const api = createMockApiClient();
    const handler = handlerFor(api);
    const asked = await handler({ query: 'Becklar' }, MODERN_CTX);
    const nonce = asked.requestState as string;

    const retry = await handler(
      { query: 'Becklar' },
      {
        mcpReq: {
          envelope: MODERN_CTX.mcpReq.envelope,
          requestState: () => nonce,
          inputResponses: {
            confirm_file: { action: 'accept', content: { choice: '1' } },
          },
        },
      },
    );
    expect(outcomeOf(retry)).toBe('confirmed');
    expect(detailOf(retry).msId).toBe('ms-item-9');
    // The retry carries the original query, and must not spend a second search.
    expect(api.searchDriveFiles).toHaveBeenCalledTimes(1);
  });

  it('treats a declined or cancelled elicitation as "no file"', async () => {
    const handler = handlerFor(createMockApiClient());
    for (const action of ['decline', 'cancel']) {
      const result = await handler(
        { query: 'Becklar' },
        {
          mcpReq: {
            envelope: MODERN_CTX.mcpReq.envelope,
            requestState: () => 'whatever',
            inputResponses: { confirm_file: { action } },
          },
        },
      );
      expect(outcomeOf(result)).toBe('declined');
    }
  });

  it('degrades to the tool-result question when no richer lane exists', async () => {
    const result = await handlerFor(createMockApiClient())({ query: 'Becklar' });
    expect(result.resultType).toBeUndefined();
    expect(outcomeOf(result)).toBe('candidates');
    expect(result.content[0].text).toContain('confirm_token');
  });

  it('falls back to the question when an advertised elicitation throws', async () => {
    const api = createMockApiClient();
    const server = createMockMcpServer();
    (server as unknown as { server: unknown }).server = {
      getClientCapabilities: () => ({ elicitation: {} }),
    };
    registerDriveSearchTool(server as never, api as never);
    const handler = server.registerTool.mock.calls[0][2] as Handler;

    const elicitInput = vi.fn().mockRejectedValue(new Error('unsupported'));
    const result = await handler(
      { query: 'Becklar' },
      { mcpReq: { elicitInput, requestState: () => undefined } },
    );

    expect(elicitInput).toHaveBeenCalled();
    expect(outcomeOf(result)).toBe('candidates');
  });

  it('resolves an accepted elicitation without a second round trip', async () => {
    const api = createMockApiClient();
    const server = createMockMcpServer();
    (server as unknown as { server: unknown }).server = {
      getClientCapabilities: () => ({ elicitation: {} }),
    };
    registerDriveSearchTool(server as never, api as never);
    const handler = server.registerTool.mock.calls[0][2] as Handler;

    const result = await handler(
      { query: 'Becklar' },
      {
        mcpReq: {
          elicitInput: vi
            .fn()
            .mockResolvedValue({ action: 'accept', content: { choice: '2' } }),
          requestState: () => undefined,
        },
      },
    );
    expect(outcomeOf(result)).toBe('confirmed');
    expect(detailOf(result).msId).toBe('ms-item-10');
  });
});

describe('search_drive_files — the remaining refusals', () => {
  it('reports a Microsoft outage as an outage, never as an empty drive', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockRejectedValue(
      new RockhopperApiError(503, 'unavailable', 'DRIVE_SEARCH_UNAVAILABLE'),
    );
    const result = await handlerFor(api)({ query: 'Becklar' });
    expect(outcomeOf(result)).toBe('search_unavailable');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not an empty drive');
  });

  it('sends the user to the browser bar when Graph withheld the drive id', async () => {
    const api = createMockApiClient();
    api.searchDriveFiles.mockResolvedValue({
      scope: 'search',
      items: [
        {
          msId: 'ms-item-9',
          driveMsId: null,
          name: 'Orphan.xlsx',
          webUrl: null,
          lastModifiedAt: null,
          size: null,
          parentPath: null,
          enrollmentState: 'not_enrolled',
        },
      ],
    });
    const handler = handlerFor(api);
    const found = await handler({ query: 'Orphan' });
    const token = detailOf(found).confirmToken as string;

    const confirmed = await handler({ confirm_index: 1, confirm_token: token });
    // A half-identified file must not be handed to `enroll_file` as a pair:
    // `enroll_file` needs both ids, and inventing the missing one is exactly
    // the wrong-file failure this whole flow exists to stop.
    expect(outcomeOf(confirmed)).toBe('unknown_candidate');
    expect(confirmed.content[0].text).toContain('browser bar');
  });

  it('treats a declined elicitation as "no file", not as an error', async () => {
    const api = createMockApiClient();
    const server = createMockMcpServer();
    (server as unknown as { server: unknown }).server = {
      getClientCapabilities: () => ({ elicitation: {} }),
    };
    registerDriveSearchTool(server as never, api as never);
    const handler = server.registerTool.mock.calls[0][2] as Handler;

    const result = await handler(
      { query: 'Becklar' },
      {
        mcpReq: {
          elicitInput: vi.fn().mockResolvedValue({ action: 'decline' }),
          requestState: () => undefined,
        },
      },
    );
    expect(outcomeOf(result)).toBe('declined');
    expect(result.isError).toBeUndefined();
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });
});
