import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const WRITE_TOOL_NAMES = [
  'add_comment',
  'reply_to_comment',
  'resolve_comment',
  'create_review_request',
  'approve_review',
  'update_file_description',
];

const READ_TOOL_NAMES = [
  'list_files',
  'get_file_versions',
  'get_file_comments',
  'get_reviews',
  'get_cell_history',
  'search_files',
];

describe('write tool handlers', () => {
  it('should register write tools when no scope specified', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const toolNames = server.registerTool.mock.calls.map((c) => c[0]);
    for (const name of WRITE_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });

  it('should register write tools when scope is read-write', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any, { scope: 'read-write' });

    const toolNames = server.registerTool.mock.calls.map((c) => c[0]);
    for (const name of WRITE_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });

  it('should NOT register write tools when scope is read-only', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any, { scope: 'read-only' });

    const toolNames = server.registerTool.mock.calls.map((c) => c[0]);
    for (const name of WRITE_TOOL_NAMES) {
      expect(toolNames).not.toContain(name);
    }
    for (const name of READ_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });

  it('add_comment should call API and format success response', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'add_comment');
    const handler = call?.[2];
    const result = await handler({
      fileMsId: 'file-1',
      message: 'Hello',
      cellReference: 'Sheet1!A1',
    });

    expect(api.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        fileMsId: 'file-1',
        message: 'Hello',
      }),
    );
    expect(result.content[0].text).toContain('Comment created');
  });

  it('approve_review should return isError on API failure', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.approveReview.mockRejectedValue(new Error('forbidden'));
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'approve_review');
    const handler = call?.[2];
    const result = await handler({ reviewId: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to approve');
  });
});
