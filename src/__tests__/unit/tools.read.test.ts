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
