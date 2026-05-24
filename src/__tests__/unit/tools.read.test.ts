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
});
