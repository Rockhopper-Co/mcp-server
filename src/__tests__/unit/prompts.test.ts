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

  // KI-099 sibling — same lowercase-vs-uppercase casing bug class in the prompt
  // filter. Backend's ReviewRequestStatus enum is uppercase
  // (PENDING/APPROVED/CANCELLED). Prior filter compared against lowercase
  // 'approved' and a nonexistent 'rejected' status — APPROVED and CANCELLED
  // reviews were silently classified as pending.
  it('file-overview should classify reviews by real backend casing (PENDING uppercase)', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([
      { internalId: 1, majorVersion: 1, minorVersion: 0, patchVersion: 0 },
    ]);
    api.getReviewsForVersion.mockResolvedValue([
      { id: 1, subject: 'r-pending', status: 'PENDING', requester: { firstName: 'A', lastName: 'B' } },
      { id: 2, subject: 'r-approved', status: 'APPROVED', requester: { firstName: 'A', lastName: 'B' } },
      { id: 3, subject: 'r-cancelled', status: 'CANCELLED', requester: { firstName: 'A', lastName: 'B' } },
    ]);
    registerPrompts(server as any, api as any);

    const call = server.registerPrompt.mock.calls.find((c) => c[0] === 'file-overview');
    const handler = call?.[2];
    const result = await handler({ fileMsId: 'file-1' });

    const text = result.messages[0].content.text;
    // Only the 1 PENDING review should be counted as pending. The bug-present
    // code (lowercase compare) classified all 3 as pending because APPROVED !==
    // 'approved' (case-sensitive) AND CANCELLED !== 'rejected' both eval true.
    expect(text).toContain('## Reviews: 3 total, 1 pending');
  });
});
