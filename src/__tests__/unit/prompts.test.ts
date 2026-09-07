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
    expect(api.getUnattributedChangesPaginated).toHaveBeenCalledWith('file-1');
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

/**
 * The two prompts nothing drove.
 *
 * `pending-reviews` and `unresolved-comments` were reached only by the
 * in-memory e2e, which asserted the STATIC heading each template always
 * prints — so the rendering underneath ran and nothing checked it. Measured
 * before these cases: `src/prompts/index.ts` reported 100% statements and
 * 55.55% BRANCHES, with lines 37-139 named as the uncovered arms.
 *
 * A prompt is the surface a model narrates as fact, so each arm below is a
 * sentence a customer can end up reading.
 */
function promptHandler(name: string, api: ReturnType<typeof createMockApiClient>) {
  const server = createMockMcpServer();
  registerPrompts(server as any, api as any);
  const call = server.registerPrompt.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`prompt ${name} was never registered`);
  return call[2] as (args: { fileMsId: string }) => Promise<{
    messages: Array<{ content: { text: string } }>;
  }>;
}

async function renderPrompt(
  name: string,
  api: ReturnType<typeof createMockApiClient>,
): Promise<string> {
  const result = await promptHandler(name, api)({ fileMsId: 'file-1' });
  return result.messages[0].content.text;
}

describe('pending-reviews prompt rendering', () => {
  it('renders subject, status, id and requester for each review', async () => {
    const api = createMockApiClient();
    api.getReviewsForLatestVersion.mockResolvedValue([
      {
        id: 77,
        subject: 'Q3 assumptions',
        status: 'PENDING',
        description: 'Check the growth rate',
        requester: { firstName: 'Grace', lastName: 'Hopper' },
      },
    ]);

    const text = await renderPrompt('pending-reviews', api);

    expect(text).toContain('"Q3 assumptions" (status: PENDING, id: 77)');
    expect(text).toContain('requested by Grace Hopper');
    expect(text).toContain('Description: Check the growth rate');
  });

  /** Both optional arms absent — neither may print `undefined` at a customer. */
  it('omits the requester and description segments when the backend sent neither', async () => {
    const api = createMockApiClient();
    api.getReviewsForLatestVersion.mockResolvedValue([
      { id: 78, subject: 'Bare review', status: 'PENDING' },
    ]);

    const text = await renderPrompt('pending-reviews', api);

    expect(text).toContain('"Bare review" (status: PENDING, id: 78)');
    expect(text).not.toContain('requested by');
    expect(text).not.toContain('Description:');
    expect(text).not.toContain('undefined');
  });

  /**
   * ENG-4384 — the prompt twin of the `get_reviews` defect, same expression.
   *
   * `Unknown` rather than dropping the segment: the requester EXISTS here, so
   * omitting "requested by" would say nobody asked for the review, which is a
   * different falsehood. The omit branch below stays for a genuinely absent
   * requester.
   */
  it('says Unknown for a requester with no name, never the word null', async () => {
    const api = createMockApiClient();
    api.getReviewsForLatestVersion.mockResolvedValue([
      {
        id: 79,
        subject: 'Nameless requester',
        status: 'PENDING',
        requester: { internalId: 7, firstName: null, lastName: null },
      },
    ]);

    const text = await renderPrompt('pending-reviews', api);

    expect(text).not.toContain('null');
    expect(text).toContain('requested by Unknown');
  });

  it('renders the one name part it has instead of pairing it with null', async () => {
    const api = createMockApiClient();
    api.getReviewsForLatestVersion.mockResolvedValue([
      {
        id: 80,
        subject: 'Half-named requester',
        status: 'PENDING',
        requester: { internalId: 8, firstName: 'Dana', lastName: null },
      },
    ]);

    const text = await renderPrompt('pending-reviews', api);

    expect(text).toContain('requested by Dana');
    expect(text).not.toContain('null');
    expect(text).not.toContain('Unknown');
  });

  it('says there are no reviews rather than printing an empty section', async () => {
    const api = createMockApiClient();
    api.getReviewsForLatestVersion.mockResolvedValue([]);

    const text = await renderPrompt('pending-reviews', api);

    expect(text).toContain('No reviews found for the latest version.');
  });
});

describe('unresolved-comments prompt rendering', () => {
  const comment = (over: Record<string, unknown>) => ({
    internalId: 1,
    message: 'Check A1',
    resolved: false,
    authorName: 'Alice',
    authorEmail: 'alice@test.com',
    cellReference: 'Sheet1!A1',
    createdAt: '2026-01-01T00:00:00Z',
    replies: [],
    ...over,
  });

  it('drops the resolved threads and counts them against the total', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({ internalId: 1, message: 'still open' }),
      comment({ internalId: 2, message: 'already handled', resolved: true }),
      comment({ internalId: 3, message: 'also open' }),
    ]);

    const text = await renderPrompt('unresolved-comments', api);

    expect(text).toContain('Unresolved Comments (2 of 3 total)');
    expect(text).toContain('still open');
    expect(text).toContain('also open');
    expect(text).not.toContain('already handled');
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

    const text = await renderPrompt('unresolved-comments', api);

    expect(text).toContain('**alice@test.com**');
    expect(text).toContain('**Unknown**');
    expect(text).not.toContain('**null**');
  });

  it('prints the cell only when there is one, and the reply count only when there are replies', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({
        internalId: 1,
        message: 'anchored',
        replies: [{ internalId: 9 }, { internalId: 10 }],
      }),
      comment({ internalId: 2, message: 'file-level', cellReference: null }),
    ]);

    const text = await renderPrompt('unresolved-comments', api);
    const [anchored, fileLevel] = text
      .split('\n')
      .filter((l) => l.startsWith('- **'));

    expect(anchored).toContain('[Sheet1!A1]');
    expect(anchored).toContain('— 2 replies');
    expect(fileLevel).not.toContain('[');
    expect(fileLevel).not.toContain('replies');
  });

  it('says every comment is resolved rather than listing nothing', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      comment({ internalId: 1, resolved: true }),
    ]);

    const text = await renderPrompt('unresolved-comments', api);

    expect(text).toContain('All comments are resolved!');
    expect(text).toContain('(0 of 1 total)');
  });
});

describe('summarize-file-changes rendering arms', () => {
  it('names a version with no description rather than printing an empty one', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([
      {
        internalId: 101,
        majorVersion: 1,
        minorVersion: 0,
        patchVersion: 0,
        description: '',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const text = await renderPrompt('summarize-file-changes', api);

    expect(text).toContain('v1.0.0: No description');
  });

  it('prints None — not an empty list — when the file has no unattributed changes', async () => {
    const api = createMockApiClient();
    api.getUnattributedChangesPaginated.mockResolvedValue({
      changes: [],
      nextCursor: null,
      totalCount: 0,
      snapshotId: '1700000000000',
      snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
    });

    const text = await renderPrompt('summarize-file-changes', api);

    expect(text).toContain('## Unattributed Changes (0 total)\nNone');
  });

  it('shows at most five versions and says how many that is of the whole list', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        internalId: 100 + i,
        majorVersion: 1,
        minorVersion: i,
        patchVersion: 0,
        description: `v${i}`,
        createdAt: '2026-01-01T00:00:00Z',
      })),
    );

    const text = await renderPrompt('summarize-file-changes', api);

    expect(text).toContain('## Recent Versions (last 5 of 8)');
    expect(text).toContain('v1.4.0');
    expect(text).not.toContain('v1.5.0');
  });
});

describe('file-overview review classification', () => {
  /**
   * The comparator is `r.status?.toUpperCase() === 'PENDING'`. A review row
   * carrying no status must not count as pending — that is the arm the
   * optional chain exists for, and it decides a number the model reports.
   */
  it('does not count a statusless review as pending', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue([
      { internalId: 1, majorVersion: 1, minorVersion: 0, patchVersion: 0 },
    ]);
    api.getReviewsForVersion.mockResolvedValue([
      { id: 1, subject: 'no-status' },
      { id: 2, subject: 'pending', status: 'pending' },
    ]);

    const text = await renderPrompt('file-overview', api);

    // Lowercase still counts — the comparator upper-cases defensively.
    expect(text).toContain('## Reviews: 2 total, 1 pending');
  });
});
