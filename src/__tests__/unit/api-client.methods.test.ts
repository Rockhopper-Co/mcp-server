import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

describe('ApiClient method coverage', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });
  });

  it('should call getMe', async () => {
    const fetchSpy = mockFetch({ internalId: 1 });
    vi.stubGlobal('fetch', fetchSpy);
    await client.getMe();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/users/me',
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it('should call team and file detail endpoints', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.getTeam(10);
    await client.getEnrolledFile('file-1');
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.rockhopper.co/teams/10',
      expect.anything(),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.rockhopper.co/enrolled-files/file-1',
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it('should call version and review endpoints', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.getFileVersion(7);
    await client.getReviewsForVersion(7);
    await client.getReviewsForLatestVersion('file-1');
    await client.getReview(8);
    await client.getReviewActivities(8);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    vi.unstubAllGlobals();
  });

  it('should call comment endpoints', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.getComment(5);
    await client.replyToComment(5, { message: 'reply', versionInternalId: 42 });
    await client.resolveComment(5);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
    expect(fetchSpy.mock.calls[2][1].method).toBe('PATCH');
    vi.unstubAllGlobals();
  });

  it('should call write endpoints with payload', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.createReviewRequest({
      versionId: 1,
      subject: 's',
      reviewerIds: [42],
    });
    await client.approveReview(1, { notes: 'ok' });
    await client.updateEnrolledFile('file-1', { name: 'New' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
    expect(fetchSpy.mock.calls[2][1].method).toBe('PATCH');
    vi.unstubAllGlobals();
  });

  it('should call createVersion with POST', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.createVersion({
      enrolledFileMsId: 'file-1',
      version: { majorVersion: 2, minorVersion: 0, patchVersion: 0, description: 'v2' },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-versions',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('should call discardChanges with POST', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.discardChanges('file-1', { description: 'reason' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-versions/file/discard-live/file-1',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('should call cancelReview with PUT', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.cancelReview(500);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/reviews/requests/500',
      expect.objectContaining({ method: 'PUT' }),
    );
    vi.unstubAllGlobals();
  });

  it('should build unattributed changes path with sheetName', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.getUnattributedChanges('file-1', { sheetName: 'Sheet1' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/unattributed-changes/file-1/Sheet1',
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it('should call getFileVersions', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);
    await client.getFileVersions('file-1');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-versions/file/file-1',
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it('should call getFileComments', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);
    await client.getFileComments('file-1');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-chat/file-1',
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });
});
