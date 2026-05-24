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
    const fetchSpy = mockFetch({ id: 5, subject: 'Review me', status: 'PENDING' });
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

  it('uses sheet-filter path for getUnattributedChangesBySheet', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.getUnattributedChangesBySheet('file123', 'Sheet1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/unattributed-changes/file123/Sheet1',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  it('URL-encodes sheet name with special characters', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);

    await client.getUnattributedChangesBySheet('file123', 'My Sheet/Tab');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/unattributed-changes/file123/My%20Sheet%2FTab',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  // KI-097: mcp-server now uses the dedicated `/paginated/:fileMsId` route
  // added by backend PR #475 (KI-102). The legacy `:fileMsId/v2` route is
  // shadowed by `:fileMsId/:sheetName` and unusable.
  it('hits paginated route for getUnattributedChangesPaginated (no cursor)', async () => {
    const fetchSpy = mockFetch({
      changes: [],
      nextCursor: null,
      totalCount: 0,
      snapshotId: '1700000000000',
      snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await client.getUnattributedChangesPaginated('file123');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/unattributed-changes/paginated/file123',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  it('passes URL-encoded cursor as query param for getUnattributedChangesPaginated', async () => {
    const fetchSpy = mockFetch({
      changes: [],
      nextCursor: null,
      totalCount: 0,
      snapshotId: '1700000000000',
      snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await client.getUnattributedChangesPaginated(
      'file123',
      'cursor+/with=special',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/unattributed-changes/paginated/file123?cursor=cursor%2B%2Fwith%3Dspecial',
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  // KI-096: zod-parse opt-in pins backend↔mcp-server contract for the
  // three previously-broken response shapes.
  describe('KI-096 zod-parse opt-in', () => {
    it('getCellHistory sends ?format=mcp', async () => {
      const fetchSpy = mockFetch([
        {
          versionId: 'v1.0.0',
          value: 'foo',
          changedBy: 'A',
          changedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      vi.stubGlobal('fetch', fetchSpy);

      await client.getCellHistory('file-1', 'Sheet1', 'A1');

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('format=mcp');
      expect(url).toContain('cell=A1');
      expect(url).toContain('sheetName=Sheet1');

      vi.unstubAllGlobals();
    });

    it('getCellHistory accepts the normalized projection shape', async () => {
      const fetchSpy = mockFetch([
        {
          versionId: 'v3.0.0',
          value: '$18,500,000',
          changedBy: 'Sebastian Perez Lawrence',
          changedAt: '2026-05-12T15:42:56.676Z',
        },
      ]);
      vi.stubGlobal('fetch', fetchSpy);

      const result = await client.getCellHistory('file-1', 'Financing', 'B5');

      expect(result).toEqual([
        {
          versionId: 'v3.0.0',
          value: '$18,500,000',
          changedBy: 'Sebastian Perez Lawrence',
          changedAt: '2026-05-12T15:42:56.676Z',
        },
      ]);

      vi.unstubAllGlobals();
    });

    it('getCellHistory throws a useful error when versionId is the wrong type (drift sentinel)', async () => {
      // Simulates the original audit symptom: legacy raw-CTE response
      // shape leaking through. With opt-in zod-parse the formatter would
      // have caught this immediately instead of rendering `undefined`.
      const fetchSpy = mockFetch([
        {
          versionId: 101,
          value: 1234,
          changedBy: 'Alice',
          changedAt: '2026-01-04T00:00:00Z',
        },
      ]);
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        client.getCellHistory('file-1', 'Sheet1', 'A1'),
      ).rejects.toThrow(/failed schema check at .*cell-history.*versionId/);

      vi.unstubAllGlobals();
    });

    it('resolveComment accepts a valid FileChat response', async () => {
      const fetchSpy = mockFetch({
        internalId: 607,
        message: 'smoke',
        resolved: true,
      });
      vi.stubGlobal('fetch', fetchSpy);

      const result = await client.resolveComment(607);

      expect(result.internalId).toBe(607);
      expect(result.resolved).toBe(true);

      vi.unstubAllGlobals();
    });

    it('resolveComment throws when the response is the legacy UpdateResult shape (regression sentinel for KI-096)', async () => {
      // Simulates the pre-fix backend response.
      const fetchSpy = mockFetch({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      vi.stubGlobal('fetch', fetchSpy);

      await expect(client.resolveComment(607)).rejects.toThrow(
        /failed schema check at .*\/file-chat\/607.*internalId/,
      );

      vi.unstubAllGlobals();
    });

    it('updateEnrolledFile accepts a valid EnrolledFile response', async () => {
      const fetchSpy = mockFetch({
        internalId: 1,
        platformId: 'file-1',
        name: 'Renamed.xlsx',
        fileType: 'microsoft_xlsx',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const result = await client.updateEnrolledFile('file-1', {
        name: 'Renamed.xlsx',
      });

      expect(result.platformId).toBe('file-1');
      expect(result.name).toBe('Renamed.xlsx');

      vi.unstubAllGlobals();
    });

    it('updateEnrolledFile throws when the response is the legacy UpdateResult shape (regression sentinel for KI-096)', async () => {
      const fetchSpy = mockFetch({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        client.updateEnrolledFile('file-1', { name: 'foo' }),
      ).rejects.toThrow(
        /failed schema check at .*\/enrolled-files\/file-1.*(platformId|name)/,
      );

      vi.unstubAllGlobals();
    });
  });
});
