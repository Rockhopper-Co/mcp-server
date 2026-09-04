import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2785 — `list_unenrolled_files`, the answer to "what could I add".
 *
 * David: *"list unenrolled files needs to be a command."*
 *
 * The assertions below are almost all about the EMPTY answer, and that is
 * deliberate. A populated list is self-evidently right or wrong; an empty one
 * is where this tool can lie, because four different situations produce it:
 * every workbook is already enrolled, the user has never linked Microsoft, the
 * first refresh has not run yet, and the refresh has been failing for a day.
 * Rendering all four as "no un-enrolled files" is the failure this file exists
 * to prevent.
 */

const FRESH = {
  asOf: '2026-08-19T21:00:00.000Z',
  stale: false,
  refreshing: false,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
};

const NEVER_REFRESHED = {
  asOf: null,
  stale: true,
  refreshing: true,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
};

function handlerFor(api: ReturnType<typeof createMockApiClient>) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  const call = server.registerTool.mock.calls.find(
    (c: unknown[]) => c[0] === 'list_unenrolled_files',
  );
  return { call, handler: call?.[2] as (args: unknown) => Promise<any> };
}

describe('list_unenrolled_files', () => {
  it('is on the read floor, with no write scope needed', () => {
    const { call } = handlerFor(createMockApiClient());
    expect(call).toBeDefined();
    expect(call?.[1].annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it('asks the backend only for un-enrolled rows', async () => {
    const api = createMockApiClient();
    const { handler } = handlerFor(api);

    await handler({ limit: 25 });

    expect(api.listDriveInventory).toHaveBeenCalledWith({
      enrollment: 'not_enrolled',
      limit: 25,
    });
  });

  it('renders each file with the ids `enroll_file` needs', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [
        {
          msId: 'item-1',
          driveMsId: 'drive-1',
          name: 'Q3 Forecast.xlsx',
          webUrl: 'https://contoso.sharepoint.com/Q3.xlsx',
          parentPath: '/Finance/2026',
          lastModifiedAt: '2026-08-18T10:00:00.000Z',
          size: 1024,
          enrollmentState: 'not_enrolled',
          entitlementObservedAt: '2026-08-19T20:00:00.000Z',
        },
      ],
      freshness: FRESH,
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toContain('Q3 Forecast.xlsx');
    expect(text).toContain('item-1');
    expect(text).toContain('drive-1');
    expect(text).toContain('/Finance/2026');
  });

  /**
   * A file the user UNENROLLED is offerable again, and its history is still
   * there — enrolling it restores rather than duplicates. Printing it as if
   * Rockhopper had never seen it loses the only fact that makes the next step
   * different.
   */
  it('says when a listed file was previously removed rather than never added', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [
        {
          msId: 'item-2',
          driveMsId: 'drive-2',
          name: 'Old Model.xlsx',
          webUrl: null,
          parentPath: null,
          lastModifiedAt: null,
          size: null,
          enrollmentState: 'hidden',
          entitlementObservedAt: '2026-08-19T20:00:00.000Z',
        },
      ],
      freshness: FRESH,
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toMatch(/previously removed/i);
  });

  // ─── THE EMPTY ANSWER, WHICH IS WHERE THIS TOOL CAN LIE ─────────────

  it('does not call an empty list "nothing to add" when no refresh has ever run', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: NEVER_REFRESHED,
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toMatch(/has not finished/i);
    // The disclaimer legitimately contains the phrase "already in Rockhopper",
    // so the assertion is on the CLAIM, which only the covered branch opens.
    expect(text).not.toMatch(/^Every workbook/);
  });

  it('tells an unlinked user to connect Microsoft instead of reporting an empty drive', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: {
        ...NEVER_REFRESHED,
        refreshing: false,
        lastFailureAt: '2026-08-19T21:00:00.000Z',
        lastFailureReason: 'no_delegated_token',
        consecutiveFailures: 3,
      },
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toContain('connect_microsoft');
  });

  it('reports a persistently failing refresh rather than a quiet empty list', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: {
        asOf: '2026-08-10T09:00:00.000Z',
        stale: true,
        refreshing: false,
        lastFailureAt: '2026-08-19T21:00:00.000Z',
        lastFailureReason: 'graph_unavailable',
        consecutiveFailures: 12,
      },
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toContain('graph_unavailable');
    expect(text).toContain('12');
  });

  it('only says everything is covered when a refresh has actually succeeded', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: FRESH,
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toMatch(/^Every workbook/);
  });

  /**
   * The answer is stored rows, never a live Microsoft read. A surface that
   * presents it as live invites a user to conclude a file is missing from their
   * drive when it is only missing from our last refresh.
   */
  it('always dates the answer instead of implying it is live', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: FRESH,
    });
    const { handler } = handlerFor(api);

    const text = (await handler({})).content[0].text;

    expect(text).toContain('2026-08-19T21:00:00.000Z');
  });

  it('reports a failure to reach the backend as an error, not as an empty drive', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockRejectedValue(new Error('connection refused'));
    const { handler } = handlerFor(api);

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connection refused');
  });

  it('never enrolls anything and never asks the user to pick one', async () => {
    const api = createMockApiClient();
    const { handler } = handlerFor(api);

    const result = await handler({});

    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    expect(result.inputRequests).toBeUndefined();
  });
});

/**
 * ENG-2814 — pagination.
 *
 * David ruled a cursor rather than a truncation notice, because past the old
 * 200-row ceiling files were simply not considered and nothing said so.
 *
 * The hazard that lands HERE rather than in the backend is a rendering one, and
 * it is the same one this file already exists for: **a short page with a cursor
 * is not the end of the list**. The backend's enrollment filter and its
 * per-request scan budget both cut a page short, so an empty page with a cursor
 * means "we have not finished looking" — and rendering that as "every workbook
 * is already in Rockhopper" is exactly the lie the tool was written against.
 */
describe('list_unenrolled_files pagination', () => {
  const PAGE = {
    items: [
      {
        msId: 'ms-1',
        driveMsId: 'drive-1',
        name: 'Model.xlsx',
        webUrl: null,
        parentPath: null,
        lastModifiedAt: null,
        size: null,
        enrollmentState: 'not_enrolled' as const,
        entitlementObservedAt: '2026-08-19T21:00:00.000Z',
      },
    ],
    freshness: FRESH,
  };

  it('passes the caller’s cursor straight through', async () => {
    const api = createMockApiClient();
    const { handler } = handlerFor(api);

    await handler({ cursor: 'opaque-token' });

    expect(api.listDriveInventory).toHaveBeenCalledWith({
      enrollment: 'not_enrolled',
      limit: undefined,
      cursor: 'opaque-token',
    });
  });

  it('tells the model the exact cursor to pass for the next page', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      ...PAGE,
      nextCursor: 'next-token',
    });
    const { handler } = handlerFor(api);

    const res = await handler({});

    expect(res.content[0].text).toContain('next-token');
    expect(res.content[0].text).toMatch(/more/i);
  });

  it('says nothing about paging when the list is finished', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({ ...PAGE, nextCursor: null });
    const { handler } = handlerFor(api);

    const res = await handler({});

    expect(res.content[0].text).not.toMatch(/cursor/i);
  });

  /**
   * THE ONE THAT MATTERS. An empty page carrying a cursor is the middle of a
   * walk, not an answer. Reporting it as "everything is already enrolled" tells
   * a user their drive is covered on the strength of a page we filtered to
   * nothing.
   */
  it('never calls an empty page with a cursor "everything is already enrolled"', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: FRESH,
      nextCursor: 'keep-going',
    });
    const { handler } = handlerFor(api);

    const res = await handler({});
    const text = res.content[0].text;

    expect(text).not.toMatch(/already in Rockhopper/i);
    expect(text).toContain('keep-going');
    expect(text).toMatch(/more/i);
  });

  it('still calls an empty FINAL page "everything is already enrolled"', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: FRESH,
      nextCursor: null,
    });
    const { handler } = handlerFor(api);

    expect(res_text(await handler({}))).toMatch(/already in Rockhopper/i);
  });

  /**
   * The unlinked-account and never-refreshed branches must keep winning over
   * the pagination hint: a user with no Microsoft link has no rows to page
   * through, and telling them to fetch another page instead of running
   * `connect_microsoft` sends them round a loop that cannot terminate.
   */
  it('prefers the unlinked-account message over a pagination hint', async () => {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness: { ...NEVER_REFRESHED, lastFailureReason: 'no_delegated_token' },
      nextCursor: 'keep-going',
    });
    const { handler } = handlerFor(api);

    expect(res_text(await handler({}))).toContain('connect_microsoft');
  });

  /**
   * The restart rule lives in the TOOL description, not only on the `cursor`
   * parameter. Measured: `JSON.stringify` of the zod schema does not carry a
   * field's `.describe()` text, so a rule written only there is one
   * serialisation detail away from never reaching the model. The tool
   * description is the text that always does.
   */
  it('describes the snapshot restart rule so the model does not retry a dead cursor', () => {
    const { call } = handlerFor(createMockApiClient());

    expect(call?.[1].description).toContain('SNAPSHOT_EXPIRED');
    expect(call?.[1].description).toMatch(/restart/i);
  });

  it('also spells the rule out on the cursor parameter itself', () => {
    const { call } = handlerFor(createMockApiClient());
    const described = call?.[1].inputSchema.shape.cursor.description as string;

    expect(described).toContain('SNAPSHOT_EXPIRED');
    expect(described).toMatch(/restart/i);
  });
});

function res_text(res: { content: Array<{ text: string }> }): string {
  return res.content[0].text;
}

/**
 * ENG-4311 — THE VALUES THE BACKEND ACTUALLY WRITES.
 *
 * Every fixture above spells the reason `'no_delegated_token'`, and the branch
 * guarding against "we never managed to look" compares that literal. The
 * producer writes something else entirely:
 *
 *   `graph-link-errors.ts` defines `GraphLinkFailure` as a SCREAMING_SNAKE
 *   enum; `user-drive-inventory-refresh.service.ts:136` passes
 *   `error.reason` — one of those four values — as the recorded reason;
 *   `user-drive-sync-state.service.ts:124` stores it as
 *   `detail.reason ?? outcome`, and `detail.reason` is always set on that
 *   path; `user-drive-inventory.service.ts:318` serializes it verbatim.
 *
 * So the lowercase literal never matches, the branch is dead, and a user whose
 * Microsoft link is missing or dead falls through to the "first scan has not
 * finished, one has been started, try again shortly" message — an instruction
 * to retry, addressed to a state no retry can change.
 *
 * These cases use the enum values. The `'no_delegated_token'` cases above stay
 * exactly as they are: that literal is still reachable through the
 * `?? outcome` fallback and from any older backend, so both spellings must
 * work.
 */
describe('list_unenrolled_files — the reason codes the backend really sends (ENG-4311)', () => {
  /** A user who has never had a successful scan and has no Microsoft link. */
  const NEVER_SCANNED_UNLINKED = {
    asOf: null,
    stale: true,
    refreshing: false,
    lastFailureAt: '2026-09-03T21:00:00.000Z',
    consecutiveFailures: 1,
  };

  /** A user whose link worked last week and has since died. */
  const SCANNED_THEN_BROKEN = {
    asOf: '2026-08-28T09:00:00.000Z',
    stale: true,
    refreshing: false,
    lastFailureAt: '2026-09-03T21:00:00.000Z',
    consecutiveFailures: 4,
  };

  async function render(freshness: unknown, nextCursor: string | null = null) {
    const api = createMockApiClient();
    api.listDriveInventory.mockResolvedValue({
      items: [],
      freshness,
      nextCursor,
    });
    const { handler } = handlerFor(api);
    return res_text(await handler({}));
  }

  it('tells a never-linked user to connect Microsoft, not that a scan is running', async () => {
    const text = await render({
      ...NEVER_SCANNED_UNLINKED,
      lastFailureReason: 'NO_DELEGATED_TOKEN',
    });

    expect(text).toContain('connect_microsoft');
    // The specific harm: today this renders the never-refreshed copy, which
    // asserts an action that did not happen and asks for a retry.
    expect(text).not.toMatch(/has been started/i);
    expect(text).not.toMatch(/try again/i);
  });

  it('tells a user whose link was revoked to reconnect, and does not claim a scan is pending', async () => {
    const text = await render({
      ...SCANNED_THEN_BROKEN,
      lastFailureReason: 'DELEGATED_TOKEN_REJECTED',
    });

    expect(text).toMatch(/revoked|expired|reconnect/i);
    expect(text).toContain('connect_microsoft');
    expect(text).not.toMatch(/^Every workbook/);
  });

  it('names an administrator for a tenant that has not approved Rockhopper', async () => {
    const text = await render({
      ...NEVER_SCANNED_UNLINKED,
      lastFailureReason: 'CONSENT_REQUIRED',
    });

    expect(text).toMatch(/administrator/i);
    expect(text).not.toMatch(/has been started/i);
  });

  /**
   * ENG-2614 measured this exact loop on the search surface: handing a connect
   * link to a user whose TENANT is the blocker sends them to Microsoft, gets
   * them refused, and returns them here with the same link. The remedy is
   * someone else's to take, so the tool must not offer the user's one.
   */
  it('does NOT offer connect_microsoft when only an administrator can act', async () => {
    const text = await render({
      ...NEVER_SCANNED_UNLINKED,
      lastFailureReason: 'CONSENT_REQUIRED',
    });

    expect(text).not.toContain('connect_microsoft');
  });

  it('says the stored credential could not be read, and that it is ours to fix', async () => {
    const text = await render({
      ...SCANNED_THEN_BROKEN,
      lastFailureReason: 'DELEGATED_TOKEN_UNREADABLE',
    });

    expect(text).toContain('connect_microsoft');
    expect(text).not.toMatch(/has been started/i);
  });

  it('prefers the link answer over a pagination hint, for the real reason codes too', async () => {
    const text = await render(
      { ...NEVER_SCANNED_UNLINKED, lastFailureReason: 'NO_DELEGATED_TOKEN' },
      'keep-going',
    );

    expect(text).toContain('connect_microsoft');
    expect(text).not.toContain('keep-going');
  });

  /**
   * THE REFUSAL MUST STAY REACHABLE. A fix that answers "your link is broken"
   * to everybody would replace a wrong reassurance with a wrong alarm, and the
   * second is worse: it is unfalsifiable from the user's side.
   */
  it('still says everything is covered for a healthy account with nothing to add', async () => {
    const text = await render(FRESH);

    expect(text).toMatch(/^Every workbook/);
    expect(text).not.toContain('connect_microsoft');
  });

  it('still reports an ordinary refresh failure as a refresh failure', async () => {
    const text = await render({
      ...SCANNED_THEN_BROKEN,
      lastFailureReason: 'graph_unavailable',
    });

    expect(text).toContain('graph_unavailable');
    expect(text).not.toContain('connect_microsoft');
  });
});
