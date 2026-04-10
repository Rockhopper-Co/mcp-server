import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

describe('write tool handlers', () => {
  it('should register write tools', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const toolNames = server.registerTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain('add_comment');
    expect(toolNames).toContain('reply_to_comment');
    expect(toolNames).toContain('resolve_comment');
    expect(toolNames).toContain('create_review_request');
    expect(toolNames).toContain('approve_review');
    expect(toolNames).toContain('update_file_description');
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
