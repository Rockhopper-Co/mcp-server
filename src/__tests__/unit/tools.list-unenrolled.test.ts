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
