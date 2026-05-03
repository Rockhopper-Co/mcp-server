import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const WRITE_TOOL_NAMES = [
  'add_comment',
  'reply_to_comment',
  'resolve_comment',
  'create_review_request',
  'approve_review',
  'cancel_review',
  'create_version',
  'discard_changes',
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

  it('create_version should compute next semver and call API', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'create_version');
    const handler = call?.[2];
    const result = await handler({
      fileMsId: 'file-1',
      versionType: 'minor',
      description: 'Added assumptions',
    });

    expect(api.getEnrolledFile).toHaveBeenCalledWith('file-1');
    expect(api.getFileVersions).toHaveBeenCalledWith('file-1');
    expect(api.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        enrolledFileMsId: 'file-1',
        version: expect.objectContaining({
          majorVersion: 1,
          minorVersion: 1,
          patchVersion: 0,
          description: 'Added assumptions',
        }),
      }),
    );
    expect(result.content[0].text).toContain('Version v1.1.0 created');
  });

  it('create_version should return error when no uncommitted changes', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue({
      internalId: 12,
      platformId: 'file-2',
      name: 'Forecast.xlsx',
      hasUncommittedChanges: false,
    });
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'create_version');
    const handler = call?.[2];
    const result = await handler({
      fileMsId: 'file-2',
      versionType: 'patch',
      description: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no uncommitted changes');
  });

  it('discard_changes should call API and format response', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'discard_changes');
    const handler = call?.[2];
    const result = await handler({
      fileMsId: 'file-1',
      description: 'Wrong assumptions',
    });

    expect(api.discardChanges).toHaveBeenCalledWith('file-1', {
      description: 'Wrong assumptions',
    });
    expect(result.content[0].text).toContain('Changes discarded');
  });

  it('cancel_review should pre-check status and call API', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getReview.mockResolvedValue({
      id: 401,
      subject: 'Review Q1',
      status: 'pending',
    });
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'cancel_review');
    const handler = call?.[2];
    const result = await handler({ reviewId: 401 });

    expect(api.cancelReview).toHaveBeenCalledWith(401);
    expect(result.content[0].text).toContain('Review 401 cancelled');
  });

  it('cancel_review should reject non-pending reviews', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getReview.mockResolvedValue({
      id: 401,
      subject: 'Review Q1',
      status: 'approved',
    });
    registerTools(server as any, api as any);

    const call = server.registerTool.mock.calls.find((c) => c[0] === 'cancel_review');
    const handler = call?.[2];
    const result = await handler({ reviewId: 401 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot be cancelled');
    expect(api.cancelReview).not.toHaveBeenCalled();
  });
});
