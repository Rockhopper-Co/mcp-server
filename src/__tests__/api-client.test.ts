import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient } from '../api-client.js';

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test123',
    });
  });

  it('sends Authorization header on all requests', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.listEnrolledFiles();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/enrolled-files',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer rh_pat_test123',
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('strips trailing slash from baseUrl', async () => {
    client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co/',
      token: 'test',
    });
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.listEnrolledFiles();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/enrolled-files',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  it('throws on non-OK response', async () => {
    const fetchSpy = mockFetch({ message: 'Not found' }, 404);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(client.getEnrolledFile('abc')).rejects.toThrow(
      'Rockhopper API 404',
    );

    vi.unstubAllGlobals();
  });

  it('appends search param to listEnrolledFiles', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.listEnrolledFiles({ search: 'budget' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/enrolled-files?search=budget',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  it('builds correct URL for getCellHistory', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.getCellHistory('file123', 'Sheet1', 'A1');

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/file-versions/file/file123/cell-history');
    expect(calledUrl).toContain('cell=A1');
    expect(calledUrl).toContain('sheetName=Sheet1');

    vi.unstubAllGlobals();
  });

  it('sends POST with body for createComment including versionInternalId', async () => {
    const fetchSpy = mockFetch({ internalId: 1, message: 'test' });
    vi.stubGlobal('fetch', fetchSpy);

    await client.createComment({
      fileMsId: 'file123',
      message: 'Test comment',
      versionInternalId: 42,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          fileMsId: 'file123',
          message: 'Test comment',
          versionInternalId: 42,
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('sends versionInternalId in replyToComment body', async () => {
    const fetchSpy = mockFetch({ internalId: 2, message: 'reply' });
    vi.stubGlobal('fetch', fetchSpy);

    await client.replyToComment(7, {
      message: 'reply',
      versionInternalId: 42,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-chat/7/replies',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'reply',
          versionInternalId: 42,
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('sends versionId + reviewerIds in createReviewRequest body', async () => {
    const fetchSpy = mockFetch({ id: 5, subject: 'Review me', status: 'pending' });
    vi.stubGlobal('fetch', fetchSpy);

    await client.createReviewRequest({
      versionId: 42,
      subject: 'Review me',
      description: 'Please review',
      reviewerIds: [1, 2, 3],
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/reviews/requests',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          versionId: 42,
          subject: 'Review me',
          description: 'Please review',
          reviewerIds: [1, 2, 3],
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('omits trailing slash for getUnattributedChanges sheet path', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.getUnattributedChanges('file123', { sheetName: 'Sheet1' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/unattributed-changes/file123/Sheet1',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });
});
