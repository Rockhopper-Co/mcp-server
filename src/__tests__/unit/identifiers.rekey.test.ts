import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient } from '../../api-client.js';
import { registerResources } from '../../resources/index.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2230 — the published tool schema must accept BOTH spellings of a
 * user / team / workspace identifier for the 400-day transition window
 * (decided 2026-08-10, ENG-2155).
 *
 * This file is the regression fence for the whole window. The defect it
 * pins is not a backend contract: `z.array(z.number().int().positive())`
 * ran zod ON THE CUSTOMER'S MACHINE, so a uuid was refused before any
 * request left the process and no backend change could rescue it. The
 * numeric branch is therefore just as load-bearing as the uuid one —
 * every customer still on an older published version sends numbers.
 */

/** A real version-7 uuid: version nibble 7, RFC 9562 variant nibble 9. */
const UUID_V7 = '0198f3a1-2b4c-7d8e-9f01-23456789abcd';

/**
 * Uuids the BACKEND accepts that a version-strict validator would refuse.
 *
 * `resource-identifier.ts:37` matches `[0-9a-f]` in the version and variant
 * positions on purpose, with the reason written down: refusing on the version
 * nibble "makes a row unreachable by its own primary key the moment one value
 * disagrees". Zod's `z.uuid()` refuses all three of these (measured).
 *
 * A client-side validator STRICTER than the server recreates exactly the
 * ENG-2230 defect in a narrower form — a row the backend would resolve,
 * refused on a machine we cannot redeploy. So these must parse here.
 */
const BACKEND_LEGAL_UUIDS = [
  '0198f3a1-2b4c-7d8e-0f01-23456789abcd', // variant nibble 0
  '0198f3a1-2b4c-7d8e-cf01-23456789abcd', // variant nibble c
  '0198f3a1-2b4c-0d8e-9f01-23456789abcd', // version nibble 0
  '0198F3A1-2B4C-7D8E-9F01-23456789ABCD', // uppercase (PostgreSQL normalises case)
];

interface RegisteredTool {
  inputSchema: Record<string, z.ZodTypeAny>;
  description?: string;
}

function toolConfig(name: string): RegisteredTool {
  const server = createMockMcpServer();
  const api = createMockApiClient();
  registerTools(server as never, api as never);
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} was never registered`);
  return call[1] as RegisteredTool;
}

describe('ENG-2230: create_review_request reviewerIds accepts both spellings', () => {
  const schema = () =>
    z.object(toolConfig('create_review_request').inputSchema);

  it('still accepts the numeric internal id — every installed version sends this', () => {
    expect(
      schema().safeParse({ versionId: 101, subject: 's', reviewerIds: [1, 2] })
        .success,
    ).toBe(true);
  });

  it('accepts a version-7 uuid', () => {
    expect(
      schema().safeParse({
        versionId: 101,
        subject: 's',
        reviewerIds: [UUID_V7],
      }).success,
    ).toBe(true);
  });

  it('accepts a mixed array while consumers migrate one reviewer at a time', () => {
    expect(
      schema().safeParse({
        versionId: 101,
        subject: 's',
        reviewerIds: [7, UUID_V7],
      }).success,
    ).toBe(true);
  });

  it.each(BACKEND_LEGAL_UUIDS)(
    'is not stricter than the backend predicate: accepts %s',
    (uuid) => {
      expect(
        schema().safeParse({
          versionId: 101,
          subject: 's',
          reviewerIds: [uuid],
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    ['a non-identifier string', ['not-a-uuid']],
    ['an empty string', ['']],
    ['a uuid missing a group', ['0198f3a1-2b4c-7d8e-9f01']],
    ['a uuid with a non-hex character', ['0198f3a1-2b4c-7d8e-9f01-23456789abcg']],
    ['zero', [0]],
    ['a negative number', [-1]],
    ['a fractional number', [1.5]],
    ['null', [null]],
    ['an object', [{ internalId: 1 }]],
  ])('still rejects %s', (_label, reviewerIds) => {
    expect(
      schema().safeParse({ versionId: 101, subject: 's', reviewerIds }).success,
    ).toBe(false);
  });

  it('still requires at least one reviewer', () => {
    expect(
      schema().safeParse({ versionId: 101, subject: 's', reviewerIds: [] })
        .success,
    ).toBe(false);
  });

  it('describes both spellings — the description is what the AI client reads', () => {
    const config = toolConfig('create_review_request');
    const described = (
      config.inputSchema.reviewerIds as { description?: string }
    ).description;
    expect(described).toBeDefined();
    expect(described).toMatch(/uuid/i);
    // The pre-ENG-2230 copy claimed the numeric form was the only one.
    expect(described).not.toMatch(/^Internal user IDs of reviewers to assign$/);
    expect(config.description).toMatch(/uuid/i);
    expect(config.description).not.toMatch(/are numeric internal user IDs/i);
  });
});

describe('ENG-2230: the team resource passes a uuid through uncoerced', () => {
  function teamHandler() {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerResources(server as never, api as never);
    const call = server.registerResource.mock.calls.find(
      (c) => c[0] === 'team-detail',
    );
    if (!call) throw new Error('team-detail resource was never registered');
    return {
      api,
      handler: call[3] as (
        uri: { href: string },
        vars: Record<string, string | string[]>,
      ) => Promise<unknown>,
    };
  }

  it('forwards a uuid unchanged instead of Number()-ing it to NaN', async () => {
    const { api, handler } = teamHandler();
    await handler({ href: `rockhopper://teams/${UUID_V7}` }, {
      teamId: UUID_V7,
    });
    expect(api.getTeam).toHaveBeenCalledWith(UUID_V7);
  });

  it('still forwards the numeric id', async () => {
    const { api, handler } = teamHandler();
    await handler({ href: 'rockhopper://teams/10' }, { teamId: '10' });
    // The path variable arrives as text and is interpolated into the URL
    // unchanged, so `'10'` and `10` produce a byte-identical request. The
    // ApiClient URL assertion below is the one that pins the wire behaviour.
    expect(api.getTeam).toHaveBeenCalledWith('10');
  });
});

describe('ENG-2230: ApiClient carries either spelling to the wire', () => {
  function mockFetch() {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ id: 1 }),
      text: () => Promise.resolve('{}'),
    });
  }

  it('sends uuid reviewerIds in the POST body verbatim', async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });
    await client.createReviewRequest({
      versionId: 1,
      subject: 's',
      reviewerIds: [UUID_V7, 42],
    });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).reviewerIds).toEqual([
      UUID_V7,
      42,
    ]);
    vi.unstubAllGlobals();
  });

  it('builds a team URL from a uuid without NaN', async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });
    await client.getTeam(UUID_V7);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `https://api.rockhopper.co/teams/${UUID_V7}`,
    );
    vi.unstubAllGlobals();
  });
});
