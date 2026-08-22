import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

describe('read tool handlers', () => {
  it('should register read tools', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const toolNames = server.registerTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain('list_files');
    expect(toolNames).toContain('get_file_versions');
    expect(toolNames).toContain('get_file_comments');
    expect(toolNames).toContain('get_reviews');
    expect(toolNames).toContain('get_cell_history');
    expect(toolNames).toContain('search_files');
    expect(toolNames).toContain('get_unattributed_changes');
  });

  it('list_files should call API and render summary', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'list_files');
    const handler = call?.[2];
    const result = await handler({ search: 'Bud' });

    expect(api.listEnrolledFiles).toHaveBeenCalledWith({ search: 'Bud' });
    expect(result.content[0].text).toContain('Found');
  });

  // ENG-1638 (P3-2) remainder — the widened cell-history rendering.
  describe('get_cell_history widened entries', () => {
    const getHandler = (api: ReturnType<typeof createMockApiClient>) => {
      const server = createMockMcpServer();
      registerTools(server as any, api as any);
      return server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_cell_history',
      )?.[2];
    };

    it('prints the backend-formatted line verbatim when present', async () => {
      const api = createMockApiClient();
      api.getCellHistory.mockResolvedValue([
        {
          versionId: 'v1.2.3',
          value: 42,
          formula: null,
          provenance: 'ai_auto',
          actorKind: 'agent',
          changedBy: 'Agent X',
          drivingHuman: 'Grace Hopper',
          changedAt: '2026-07-01T10:00:00.000Z',
          formatted:
            'v1.2.3: 42 — ai_auto (driven by Grace Hopper) — 2026-07-01T10:00:00.000Z',
        },
      ]);
      const handler = getHandler(api);
      const result = await handler({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });
      expect(result.content[0].text).toContain(
        '- v1.2.3: 42 — ai_auto (driven by Grace Hopper) — 2026-07-01T10:00:00.000Z',
      );
    });

    it('falls back to the legacy rendering for a narrow (pre-widening) entry', async () => {
      const api = createMockApiClient();
      api.getCellHistory.mockResolvedValue([
        {
          versionId: 'v3.0.0',
          value: '$18,500,000',
          changedBy: 'Sebastian Perez Lawrence',
          changedAt: '2026-05-12T15:42:56.676Z',
        },
      ]);
      const handler = getHandler(api);
      const result = await handler({
        fileMsId: 'file-1',
        sheetName: 'Financing',
        cellAddress: 'B5',
      });
      expect(result.content[0].text).toContain('v3.0.0');
      expect(result.content[0].text).toContain('"$18,500,000"');
      expect(result.content[0].text).toContain('Sebastian Perez Lawrence');
    });
  });

  it('get_reviews should error when neither versionId nor fileMsId provided', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'get_reviews');
    const handler = call?.[2];
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide either versionId or fileMsId');
  });

  it('search_files should return error payload on API failure', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.listEnrolledFiles.mockRejectedValue(new Error('boom'));
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'search_files');
    const handler = call?.[2];
    const result = await handler({ query: 'budget' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Search failed');
  });

  it('search_files should call API with default name search when matchIn omitted (ENG-1383)', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'search_files');
    const handler = call?.[2];
    await handler({ query: 'Bud' });

    expect(api.listEnrolledFiles).toHaveBeenCalledWith({
      search: 'Bud',
      matchIn: undefined,
    });
  });

  it('search_files should forward matchIn to the API (ENG-1383)', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'search_files');
    const handler = call?.[2];

    for (const matchIn of ['name', 'comments', 'versions', 'all'] as const) {
      await handler({ query: 'foo', matchIn });
      expect(api.listEnrolledFiles).toHaveBeenCalledWith({
        search: 'foo',
        matchIn,
      });
    }
  });

  // KI-097: paginated/repointed get_unattributed_changes
  describe('get_unattributed_changes (KI-097)', () => {
    it('uses BySheet method when sheetName supplied', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      await handler({ fileMsId: 'file-1', sheetName: 'Sheet1' });

      expect(api.getUnattributedChangesBySheet).toHaveBeenCalledWith(
        'file-1',
        'Sheet1',
      );
      expect(api.getUnattributedChangesPaginated).not.toHaveBeenCalled();
    });

    it('uses Paginated method when sheetName omitted', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      await handler({ fileMsId: 'file-1' });

      expect(api.getUnattributedChangesPaginated).toHaveBeenCalledWith(
        'file-1',
        undefined,
      );
      expect(api.getUnattributedChangesBySheet).not.toHaveBeenCalled();
    });

    it('forwards cursor to Paginated method', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      await handler({ fileMsId: 'file-1', cursor: 'abc123' });

      expect(api.getUnattributedChangesPaginated).toHaveBeenCalledWith(
        'file-1',
        'abc123',
      );
    });

    it('renders paginated summary line with totals + top sheets', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      api.getUnattributedChangesPaginated.mockResolvedValue({
        changes: [
          {
            id: 1,
            changeType: 'update',
            sheetName: 'Sheet1',
            cellAddress: 'A1',
            oldValue: 1,
            newValue: 2,
            byUserPlatformId: 'u-1',
            byUserPlatformType: 'microsoft',
            processingStatus: 'pending',
            attributionDate: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 2,
            changeType: 'update',
            sheetName: 'Sheet2',
            cellAddress: 'B2',
            oldValue: 'a',
            newValue: 'b',
            byUserPlatformId: null,
            byUserPlatformType: null,
            processingStatus: 'pending',
            attributionDate: null,
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ],
        nextCursor: null,
        totalCount: 2,
        snapshotId: '1700000000000',
        snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
      });
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      const result = await handler({ fileMsId: 'file-1' });

      const text = result.content[0].text;
      expect(text).toContain('Showing 2 of 2');
      expect(text).toContain('Top sheets on this page: Sheet1 (1), Sheet2 (1)');
      expect(text).toContain('Sheet1!A1');
      expect(text).toContain('Sheet2!B2');
      // No pagination hint when nextCursor is null + nothing hidden:
      expect(text).not.toContain('cursor="');
    });

    it('caps displayed rows at 200 and shows hidden-row hint', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      const rows = Array.from({ length: 250 }, (_, i) => ({
        id: i + 1,
        changeType: 'update',
        sheetName: 'Sheet1',
        cellAddress: `A${i + 1}`,
        oldValue: i,
        newValue: i + 1,
        byUserPlatformId: 'u-1',
        byUserPlatformType: 'microsoft',
        processingStatus: 'pending',
        attributionDate: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }));
      api.getUnattributedChangesPaginated.mockResolvedValue({
        changes: rows,
        nextCursor: null,
        totalCount: 250,
        snapshotId: '1700000000000',
        snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
      });
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      const result = await handler({ fileMsId: 'file-1' });

      const text = result.content[0].text;
      expect(text).toContain('Showing 200 of 250');
      expect(text).toContain('50 more row(s) on this page not shown');
      expect(text).toContain('Sheet1!A1');
      expect(text).toContain('Sheet1!A200');
      expect(text).not.toContain('Sheet1!A201');
    });

    it('emits cursor pagination hint when nextCursor is non-null', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      api.getUnattributedChangesPaginated.mockResolvedValue({
        changes: [
          {
            id: 1,
            changeType: 'update',
            sheetName: 'Sheet1',
            cellAddress: 'A1',
            oldValue: 1,
            newValue: 2,
            byUserPlatformId: null,
            byUserPlatformType: null,
            processingStatus: 'pending',
            attributionDate: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: 'next-cursor-xyz',
        totalCount: 1500,
        snapshotId: '1700000000000',
        snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
      });
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      const result = await handler({ fileMsId: 'file-1' });

      const text = result.content[0].text;
      expect(text).toContain('More pages available');
      expect(text).toContain('cursor="next-cursor-xyz"');
      expect(text).toContain('1500 total across the file');
    });

    it('returns end-of-pages message when changes is empty but totalCount > 0', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      api.getUnattributedChangesPaginated.mockResolvedValue({
        changes: [],
        nextCursor: null,
        totalCount: 42,
        snapshotId: '1700000000000',
        snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
      });
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      const result = await handler({ fileMsId: 'file-1' });

      expect(result.content[0].text).toContain(
        'End of pages reached (42 total across the file)',
      );
    });

    it('returns no-changes message when file has no unattributed changes', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      api.getUnattributedChangesPaginated.mockResolvedValue({
        changes: [],
        nextCursor: null,
        totalCount: 0,
        snapshotId: '1700000000000',
        snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
      });
      registerTools(server as any, api as any);

      const call = server.registerTool.mock.calls.find(
        (c) => c[0] === 'get_unattributed_changes',
      );
      const handler = call?.[2];
      const result = await handler({ fileMsId: 'file-1' });

      expect(result.content[0].text).toBe(
        'No unattributed changes found for this file.',
      );
    });
  });
});

/**
 * The rendering arms of the read tools that nothing drove.
 *
 * Every existing case above feeds the happy fixture, so the fallbacks each
 * renderer carries — an author with no name, a review with no requester, a
 * reverted version — ran only in their present branch. Measured before these
 * cases: `get-comments.ts` 71.42% branches, `get-reviews.ts` 78.57%,
 * `get-versions.ts` 83.33%.
 *
 * These are not cosmetic. The consumer is a model quoting the line back to a
 * customer, and the failure is a sentence like `**null** [undefined]`.
 */
function readHandler(
  api: ReturnType<typeof createMockApiClient>,
  name: string,
) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find((c) => c[0] === name)?.[2] as (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

describe('get_file_comments rendering arms', () => {
  const comment = (over: Record<string, unknown>) => ({
    internalId: 1,
    message: 'Check A1',
    source: 'rockhopper',
    cellReference: 'Sheet1!A1',
    resolved: false,
    authorName: 'Alice',
    authorEmail: 'alice@test.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    editedOn: null,
    replies: [],
    ...over,
  });

  it('falls back to the email, then to Unknown, when there is no author name', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({ internalId: 1, message: 'by-email', authorName: null }),
      comment({
        internalId: 2,
        message: 'by-nobody',
        authorName: null,
        authorEmail: null,
      }),
    ]);

    const text = (await readHandler(api, 'get_file_comments')({
      fileMsId: 'file-1',
    })).content[0].text;

    expect(text).toContain('**alice@test.com**');
    expect(text).toContain('**Unknown**');
    expect(text).not.toContain('**null**');
  });

  it('marks a resolved thread and leaves an open one unmarked', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({ internalId: 1, message: 'closed', resolved: true }),
      comment({ internalId: 2, message: 'open' }),
    ]);

    const text = (await readHandler(api, 'get_file_comments')({
      fileMsId: 'file-1',
    })).content[0].text;

    const [closed, open] = text.split('\n').filter((l) => l.includes('**Alice**'));
    expect(closed).toContain('(resolved)');
    expect(open).not.toContain('(resolved)');
  });

  it('indents replies under their parent instead of flattening the thread', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({
        internalId: 1,
        message: 'parent',
        replies: [
          comment({
            internalId: 2,
            message: 'child',
            authorName: 'Bob',
            cellReference: null,
          }),
        ],
      }),
    ]);

    const text = (await readHandler(api, 'get_file_comments')({
      fileMsId: 'file-1',
    })).content[0].text;

    // One thread, two rendered lines — the reply is nested, not counted again.
    expect(text).toContain('1 comment thread(s)');
    expect(text).toContain('\n  - **Bob**');
    expect(text).not.toContain('\n- **Bob**');
  });

  it('omits the cell segment for a file-level comment', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({ message: 'file-level', cellReference: null }),
    ]);

    const text = (await readHandler(api, 'get_file_comments')({
      fileMsId: 'file-1',
    })).content[0].text;

    expect(text).toContain('**Alice**: file-level');
    expect(text).not.toContain('[null]');
  });

  it('reports a non-Error rejection as text rather than "[object Object]" swallowing it', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockRejectedValue('backend said no');

    const result = await readHandler(api, 'get_file_comments')({
      fileMsId: 'file-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('backend said no');
  });
});

describe('get_reviews rendering arms', () => {
  const review = (over: Record<string, unknown>) => ({
    id: 500,
    subject: 'Please review v1',
    status: 'PENDING',
    createdAt: '2026-01-01T00:00:00Z',
    requester: { firstName: 'Grace', lastName: 'Hopper' },
    ...over,
  });

  it('names the requester and prints the description when both are present', async () => {
    const api = createMockApiClient();
    api.getReviewsForVersion.mockResolvedValue([
      review({ description: 'Growth rate looks high' }),
    ]);

    const text = (await readHandler(api, 'get_reviews')({ versionId: 101 }))
      .content[0].text;

    expect(text).toContain('**Please review v1** (id: 500, status: PENDING)');
    expect(text).toContain('requested by Grace Hopper');
    expect(text).toContain('— Growth rate looks high');
  });

  it('says Unknown for a review with no requester and prints no dangling description', async () => {
    const api = createMockApiClient();
    api.getReviewsForVersion.mockResolvedValue([review({ requester: null })]);

    const text = (await readHandler(api, 'get_reviews')({ versionId: 101 }))
      .content[0].text;

    expect(text).toContain('requested by Unknown');
    expect(text).not.toContain('undefined');
    expect(text.trimEnd().endsWith('2026-01-01T00:00:00Z')).toBe(true);
  });

  it('says no reviews were found rather than printing an empty list', async () => {
    const api = createMockApiClient();
    api.getReviewsForLatestVersion.mockResolvedValue([]);

    const text = (await readHandler(api, 'get_reviews')({ fileMsId: 'file-1' }))
      .content[0].text;

    expect(text).toBe('No reviews found.');
  });
});

describe('get_file_versions flag rendering', () => {
  const version = (over: Record<string, unknown>) => ({
    internalId: 101,
    majorVersion: 1,
    minorVersion: 0,
    patchVersion: 0,
    description: 'Initial',
    createdAt: '2026-01-01T00:00:00Z',
    wasDiscarded: false,
    wasReverted: false,
    byUserName: 'David Kuchar',
    byUserPlatformId: 'ms-user-1',
    byUserPlatformType: 'microsoft',
    ...over,
  });

  it('tags a reverted version, which is a different fact from a discarded one', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([version({ wasReverted: true })]);

    const text = (await readHandler(api, 'get_file_versions')({
      fileMsId: 'file-1',
    })).content[0].text;

    expect(text).toContain('[reverted]');
    expect(text).not.toContain('discarded');
  });

  it('lists both flags on a version that is discarded AND reverted', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([
      version({ wasDiscarded: true, wasReverted: true, majorVersion: 1 }),
    ]);

    const text = (await readHandler(api, 'get_file_versions')({
      fileMsId: 'file-1',
    })).content[0].text;

    expect(text).toContain('[discarded, reverted]');
  });

  it('prints no flag bracket at all on an ordinary version', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([version({})]);

    const text = (await readHandler(api, 'get_file_versions')({
      fileMsId: 'file-1',
    })).content[0].text;

    expect(text).not.toContain('[');
  });

  it('omits the description segment when the backend sent none', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([version({ description: null })]);

    const text = (await readHandler(api, 'get_file_versions')({
      fileMsId: 'file-1',
    })).content[0].text;

    expect(text).toContain('— by David Kuchar');
    expect(text).not.toContain('null');
  });
});
