import { describe, expect, it } from 'vitest';
import { registerPrompts } from '../../prompts/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

describe('prompt registrations', () => {
  it('should register all prompts', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerPrompts(server as any, api as any);

    const names = server.registerPrompt.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      'summarize-file-changes',
      'pending-reviews',
      'unresolved-comments',
      'file-overview',
    ]);
  });

  it('summarize-file-changes should call required APIs and include summaries', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerPrompts(server as any, api as any);

    const call = server.registerPrompt.mock.calls.find(
      (c) => c[0] === 'summarize-file-changes',
    );
    const handler = call?.[2];
    const result = await handler({ fileMsId: 'file-1' });

    expect(api.getEnrolledFile).toHaveBeenCalledWith('file-1');
    expect(api.getFileVersions).toHaveBeenCalledWith('file-1');
    expect(api.getUnattributedChanges).toHaveBeenCalledWith('file-1');
    expect(result.messages[0].content.text).toContain('Recent Versions');
    expect(result.messages[0].content.text).toContain('Unattributed Changes');
  });

  it('file-overview should handle no versions branch', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([]);
    registerPrompts(server as any, api as any);

    const call = server.registerPrompt.mock.calls.find((c) => c[0] === 'file-overview');
    const handler = call?.[2];
    const result = await handler({ fileMsId: 'file-1' });

    expect(api.getReviewsForVersion).not.toHaveBeenCalled();
    expect(result.messages[0].content.text).toContain('No versions yet');
  });
});
