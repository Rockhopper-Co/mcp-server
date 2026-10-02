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

  // A call COUNT is not a path check: five methods could all hit the wrong
  // route and this stayed green, which is the one thing this suite exists to
  // catch (every other spec in the package mocks the client away).
  it('should call version and review endpoints', async () => {
    const fetchSpy = mockFetch({});
    vi.stubGlobal('fetch', fetchSpy);
    await client.getFileVersion(7);
    await client.getReviewsForVersion(7);
    await client.getReviewsForLatestVersion('file-1');
    await client.getReview(8);
    await client.getReviewActivities(8);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      'https://api.rockhopper.co/file-versions/file/version/7',
      'https://api.rockhopper.co/reviews/versions/7/requests',
      'https://api.rockhopper.co/reviews/files/file-1/latest-version/requests',
      'https://api.rockhopper.co/reviews/requests/8',
      'https://api.rockhopper.co/reviews/requests/8/activities',
    ]);
    // All five are reads, so none of them may carry a write verb.
    for (const [, init] of fetchSpy.mock.calls) {
      expect((init as { method?: string }).method ?? 'GET').toBe('GET');
    }
    vi.unstubAllGlobals();
  });

  it('should call comment endpoints', async () => {
    // KI-096: `resolveComment` now zod-parses the response, so the fixture
    // must satisfy `FileChatSchema` (minimum: `internalId`).
    const fetchSpy = mockFetch({ internalId: 5, message: 'r', resolved: true });
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
    // KI-096: `updateEnrolledFile` now zod-parses the response, so the
    // shared fixture must satisfy `EnrolledFileSchema` (required:
    // `platformId` + `name`). The other two calls have no schema and
    // accept anything.
    const fetchSpy = mockFetch({ platformId: 'file-1', name: 'New' });
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
    await client.getUnattributedChangesBySheet('file-1', 'Sheet1');
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

/**
 * ENG-2200 — the request BODIES, not just the paths.
 *
 * Every other spec in this package mocks the API client, so a wrong field name
 * (`url` where the DTO says `webUrl`, an `msId` where a `platformId` belongs)
 * survives all of them and fails exactly once: in production, at a customer.
 * These pin the wire shape against the backend DTOs they were read from.
 */
describe('enrollment methods put the backend DTO shapes on the wire', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });
  });

  const bodyOf = (spy: ReturnType<typeof mockFetch>): Record<string, unknown> =>
    JSON.parse(spy.mock.calls[0][1].body as string) as Record<string, unknown>;

  it('sends `webUrl` — the field name ResolveUrlDto declares', async () => {
    const fetchSpy = mockFetch({ msId: 'm', driveMsId: 'd', enrollmentState: 'not_enrolled' });
    vi.stubGlobal('fetch', fetchSpy);
    await client.resolveEnrollmentUrl('https://contoso.sharepoint.com/x');
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/enrolled-files/resolve-url',
    );
    expect(bodyOf(fetchSpy)).toEqual({
      webUrl: 'https://contoso.sharepoint.com/x',
    });
    vi.unstubAllGlobals();
  });

  it('sends a Microsoft enroll as the (driveMsId, msId) pair', async () => {
    const fetchSpy = mockFetch({ enrollmentId: 'e1', status: 'queued' });
    vi.stubGlobal('fetch', fetchSpy);
    await client.createEnrolledFile({
      provider: 'microsoft',
      fileId: 'm',
      driveMsId: 'd',
      name: 'B.xlsx',
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/enrolled-files',
    );
    expect(bodyOf(fetchSpy)).toEqual({
      msId: 'm',
      driveMsId: 'd',
      name: 'B.xlsx',
      accountType: 'microsoft',
    });
    vi.unstubAllGlobals();
  });

  /**
   * ENG-4958 — THE CASE THAT COULD NOT BE EXPRESSED. `accountType` was the
   * literal `'microsoft'` at this write site, so a Google file the backend was
   * already willing to enroll was unreachable from this package by any route.
   *
   * `platformId`, never `msId`: the backend's Google branch requires it, and a
   * Drive id sent as `msId` writes a row keyed on a value nothing looks up.
   * And NO `fileType` — the backend derives it from the Drive mime type on the
   * caller's own access probe, so a client cannot assert what a file is.
   */
  it('sends a Google enroll as platformId with no drive id and no asserted type', async () => {
    const fetchSpy = mockFetch({ enrollmentId: 'e1', status: 'queued' });
    vi.stubGlobal('fetch', fetchSpy);
    await client.createEnrolledFile({
      provider: 'google',
      fileId: 'drive-file-1',
      name: 'Budget',
    });
    expect(bodyOf(fetchSpy)).toEqual({
      platformId: 'drive-file-1',
      name: 'Budget',
      accountType: 'google',
    });
    vi.unstubAllGlobals();
  });

  it('wraps a shared enroll as a one-item batch with the share list', async () => {
    const fetchSpy = mockFetch({ enrollmentId: 'e2', status: 'queued' });
    vi.stubGlobal('fetch', fetchSpy);
    await client.enrollFileSharedWith(
      { provider: 'microsoft', fileId: 'm', driveMsId: 'd', name: 'B.xlsx' },
      ['ms-bob'],
    );
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/enrolled-files/batch',
    );
    expect(bodyOf(fetchSpy)).toEqual({
      files: [{ msId: 'm', driveMsId: 'd', name: 'B.xlsx', accountType: 'microsoft' }],
      shareWithUserMsIds: ['ms-bob'],
    });
    vi.unstubAllGlobals();
  });

  it('asks info/bulk for the three-state answer an id lookup needs', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);
    await client.getEnrollmentInfo(['ms-1']);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/enrolled-files/info/bulk',
    );
    expect(bodyOf(fetchSpy)).toEqual({ ids: ['ms-1'], accountType: 'microsoft' });
    vi.unstubAllGlobals();
  });

  /**
   * ENG-4958 — the id SPACE, not a label. The backend reads a Microsoft list
   * as `msId`s and a Google list as `platformId`s, so a Drive id sent under
   * `microsoft` matches no row and answers `not_enrolled` for a file the
   * tenant already tracks.
   */
  it('asks info/bulk in the Google id space when told to', async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal('fetch', fetchSpy);
    await client.getEnrollmentInfo(['drive-1'], 'google');
    expect(bodyOf(fetchSpy)).toEqual({
      ids: ['drive-1'],
      accountType: 'google',
    });
    vi.unstubAllGlobals();
  });

  it('lifts the backend refusal code onto the thrown error', async () => {
    // Without this, `ACCESS_UNPROVEN` and `FILE_ACCESS_DENIED` are two 403s
    // with different prose, and the tool would have to match on wording.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          JSON.stringify({ statusCode: 403, message: 'no', code: 'ACCESS_UNPROVEN' }),
        ),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      client.createEnrolledFile({
        provider: 'microsoft',
        fileId: 'm',
        driveMsId: 'd',
        name: 'n',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'ACCESS_UNPROVEN' });
    vi.unstubAllGlobals();
  });

  it('lifts the backend refusal REASON too (ENG-2614)', async () => {
    // The drive-search route sends one coarse code for four situations and
    // puts which one in `reason`. Dropping it makes "your organisation has
    // not approved us" indistinguishable from "you have not connected yet",
    // and only the first of those is unfixable by the user.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          JSON.stringify({
            statusCode: 403,
            message: 'no',
            code: 'NO_DELEGATED_TOKEN',
            reason: 'CONSENT_REQUIRED',
          }),
        ),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      client.searchDriveFiles({ q: 'anything' }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'NO_DELEGATED_TOKEN',
      reason: 'CONSENT_REQUIRED',
    });
    vi.unstubAllGlobals();
  });

  it('leaves `reason` null when the backend sends none', async () => {
    // Every deployment predating the field. Absent must mean "fall back to
    // what the code alone said", never "administrator approval needed".
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          JSON.stringify({ statusCode: 403, message: 'no', code: 'NO_DELEGATED_TOKEN' }),
        ),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      client.searchDriveFiles({ q: 'anything' }),
    ).rejects.toMatchObject({ reason: null });
    vi.unstubAllGlobals();
  });

  it('leaves `code` null when the body is not JSON, rather than throwing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: { get: () => null },
      text: () => Promise.resolve('<html>gateway</html>'),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(client.getEnrollmentInfo(['m'])).rejects.toMatchObject({
      status: 502,
      code: null,
    });
    vi.unstubAllGlobals();
  });

  it('leaves `code` null for a JSON body that is not an object', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Error',
      headers: { get: () => null },
      text: () => Promise.resolve('["nope"]'),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(client.getEnrollmentInfo(['m'])).rejects.toMatchObject({
      code: null,
    });
    vi.unstubAllGlobals();
  });
});

/**
 * ENG-2198's three account-link methods. They arrived with tool-level specs
 * only, so the client methods themselves were never executed — which is what
 * held global function coverage under its threshold once the suite went green
 * again. Cheap to close, and they are credential-adjacent enough to be worth
 * pinning: none of them may put a token on the wire.
 */
describe('Microsoft account-link methods (ENG-2198)', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });
  });

  it('asks the backend to build the consent URL, sending nothing that could steer it', async () => {
    const fetchSpy = mockFetch({ authorizeUrl: 'https://login/x', expiresAt: 'z' });
    vi.stubGlobal('fetch', fetchSpy);
    await client.beginMicrosoftConnect();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/auth/microsoft/connect',
    );
    // An empty body is the guarantee: no redirect, client id or scope list.
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({});
    vi.unstubAllGlobals();
  });

  it('reads the link status', async () => {
    const fetchSpy = mockFetch({ linked: false, grantedScopes: [] });
    vi.stubGlobal('fetch', fetchSpy);
    await client.getMicrosoftLink();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/auth/microsoft/link',
    );
    vi.unstubAllGlobals();
  });

  it('deletes the link', async () => {
    const fetchSpy = mockFetch({ linked: false, removed: true });
    vi.stubGlobal('fetch', fetchSpy);
    await client.unlinkMicrosoft();
    expect(fetchSpy.mock.calls[0][1].method).toBe('DELETE');
    vi.unstubAllGlobals();
  });
});

/**
 * ENG-2785 / ENG-2814 — the drive-inventory read, on the wire.
 *
 * `list_unenrolled_files` has 19 specs; every one of them mocks this method,
 * so the URL it actually builds was never exercised (measured: `api-client.ts`
 * lines 527-532 uncovered before these cases). The cursor is the part that
 * bites — it is opaque, expires after 30 minutes, and a caller that
 * double-encodes or drops it silently restarts the customer's paging.
 */
describe('listDriveInventory query construction (ENG-2814)', () => {
  const EMPTY = {
    items: [],
    freshness: {
      asOf: '2026-08-19T21:00:00.000Z',
      stale: false,
      refreshing: false,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
    },
    nextCursor: null,
    snapshotId: '1',
    snapshotCreatedAt: '2026-08-19T21:00:00.000Z',
  };

  function client(): { api: ApiClient; fetchSpy: ReturnType<typeof vi.fn> } {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(EMPTY),
      text: () => Promise.resolve(JSON.stringify(EMPTY)),
    });
    vi.stubGlobal('fetch', fetchSpy);
    return {
      api: new ApiClient({
        baseUrl: 'https://api.rockhopper.co',
        token: 'rh_pat_test',
      }),
      fetchSpy,
    };
  }

  it('asks for the bare route when no parameters are given', async () => {
    const { api, fetchSpy } = client();
    await api.listDriveInventory();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/drive-files/inventory',
    );
    vi.unstubAllGlobals();
  });

  it('carries enrollment, limit and cursor together', async () => {
    const { api, fetchSpy } = client();
    await api.listDriveInventory({
      enrollment: 'not_enrolled',
      limit: 50,
      cursor: 'opaque-cursor',
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.rockhopper.co/drive-files/inventory' +
        '?enrollment=not_enrolled&limit=50&cursor=opaque-cursor',
    );
    vi.unstubAllGlobals();
  });

  it('percent-encodes a cursor exactly once, so the backend gets what it issued', async () => {
    const { api, fetchSpy } = client();
    await api.listDriveInventory({ cursor: 'a+b/c=d' });
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get('cursor')).toBe('a+b/c=d');
    vi.unstubAllGlobals();
  });

  it('sends limit=0 rather than dropping it, and omits an empty cursor', async () => {
    // `limit` is guarded on `!== undefined` and `cursor` on truthiness — two
    // different rules on adjacent lines, so they are asserted apart.
    const { api, fetchSpy } = client();
    await api.listDriveInventory({ limit: 0, cursor: '' });
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get('limit')).toBe('0');
    expect(url.searchParams.has('cursor')).toBe(false);
    vi.unstubAllGlobals();
  });
});

// ENG-4347 — the sheet catalogue. Two routes, two platforms, two id KINDS,
// and getting the id kind wrong is the failure that a mock ignoring its
// argument cannot catch: the manifest route resolves on the enrolled file's
// INTERNAL id and would 403 for every real call handed a platformId.
describe('ApiClient sheet catalogue (ENG-4347)', () => {
  it('reads the workbook manifest by internal id, and extracts the names', async () => {
    const fetchSpy = mockFetch({
      activeSheetIndex: 0,
      sheets: [
        { index: 0, name: 'Sheet1' },
        { index: 1, name: 'Project Accruals' },
      ],
    });
    vi.stubGlobal('fetch', fetchSpy);
    const api = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });

    const names = await api.getWorkbookSheetNames(11);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/file-handler/by-enrolled-file/11/live/workbook-manifest',
      expect.anything(),
    );
    expect(names).toEqual(['Sheet1', 'Project Accruals']);
    vi.unstubAllGlobals();
  });

  it('fails LOUDLY when the manifest arrives without `sheets`', async () => {
    // The route passes the parser's manifest through opaquely, so the DTO is
    // documentation rather than a contract. An absent `sheets` must throw: as
    // `undefined` it would make the existence check answer "not a sheet in
    // this workbook" for every sheet of every workbook.
    const fetchSpy = mockFetch({ activeSheetIndex: 0 });
    vi.stubGlobal('fetch', fetchSpy);
    const api = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });

    await expect(api.getWorkbookSheetNames(11)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('reads native Google tab names by platformId, encoding it once', async () => {
    const fetchSpy = mockFetch(['Tab A', 'Tab B']);
    vi.stubGlobal('fetch', fetchSpy);
    const api = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });

    const names = await api.getGoogleSheetNames('1a/b+c');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.rockhopper.co/google-drive/sheet-names/1a%2Fb%2Bc',
      expect.anything(),
    );
    expect(names).toEqual(['Tab A', 'Tab B']);
    vi.unstubAllGlobals();
  });
});
