import { IncomingMessage, ServerResponse } from 'node:http';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sampleFile = {
  internalId: 1,
  platformId: 'file-1',
  fileType: 'microsoft_xlsx',
  driveMsId: 'drive-1',
  name: 'Budget.xlsx',
  hasUncommittedChanges: true,
};

const sampleVersion = {
  internalId: 101,
  majorVersion: 1,
  minorVersion: 0,
  patchVersion: 0,
  description: 'Initial',
  createdAt: '2026-01-01T00:00:00Z',
  wasDiscarded: false,
  wasReverted: false,
  byUserPlatformId: 'u-1',
  byUserPlatformType: 'microsoft',
};

const sampleComment = {
  internalId: 900,
  message: 'Please double-check A1',
  cellReference: 'Sheet1!A1',
  createdAt: '2026-01-02T00:00:00Z',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  resolved: false,
  replies: [
    {
      internalId: 901,
      message: 'Looks right to me',
      createdAt: '2026-01-02T01:00:00Z',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      resolved: false,
    },
  ],
};

const sampleReview = {
  id: 500,
  subject: 'Please review v1',
  description: 'Initial review',
  status: 'PENDING',
  createdAt: '2026-01-03T00:00:00Z',
  requester: {
    internalId: 1,
    firstName: 'Alice',
    lastName: 'Liddell',
  },
};

/** ENG-2205: what `/users/me` reports about the presenting token. */
export interface MockApiOptions {
  /**
   * Served as `patScope`. Defaults to `read-write` — the scope the pre-ENG-2208
   * suite implicitly assumed when the CLI registered every write tool
   * unconditionally. Pass `null` to omit the field, which is what a backend
   * older than ENG-2205 answers.
   */
  patScope?: string | null;
  /**
   * ENG-2212: served as `patScopes` — the write families the token holds.
   *
   * Defaults to every family for a `read-write` scope and none otherwise,
   * which is the only pairing the backend can produce: `scopeForCapabilities`
   * writes `read-write` exactly when the array is non-empty. The fixture used
   * to serve `patScopes: []` ALONGSIDE `read-write`, and once the package
   * started reading the families that combination registered zero write tools
   * — a state no real token can be in.
   *
   * Pass `null` to omit the field, which is what a backend older than
   * ENG-2211 answers.
   */
  patScopes?: string[] | null;
}

const ALL_WRITE_CAPABILITIES = [
  'comments:write',
  'reviews:write',
  'versions:write',
  'files:write',
];

export function handleMockRockhopperRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options?: MockApiOptions,
): void {
  void (async () => {
    const { url = '', method = 'GET' } = req;
    const [path, queryString = ''] = url.split('?');

    // --- Users ---
    if (method === 'GET' && path === '/users/me') {
      const patScope =
        options?.patScope === undefined ? 'read-write' : options.patScope;
      const patScopes =
        options?.patScopes === undefined
          ? patScope === 'read-write'
            ? ALL_WRITE_CAPABILITIES
            : []
          : options.patScopes;
      sendJson(res, 200, {
        internalId: 1,
        firstName: 'Alice',
        lastName: 'Liddell',
        // ENG-2205 serves these only for a PAT-authenticated caller; every
        // e2e launch here presents `rh_pat_test_token`.
        ...(patScope === null
          ? {}
          : {
              patScope,
              patExpiresAt: null,
              ...(patScopes === null ? {} : { patScopes }),
            }),
      });
      return;
    }

    // --- Teams ---
    // ENG-2230: a team is keyed on a version-7 uuid. The pre-fix resource
    // handler did `Number(teamId)`, which requested `/teams/NaN` — this route
    // only answers the uuid spelled correctly, so the e2e read fails if the
    // coercion ever comes back.
    if (
      method === 'GET' &&
      path === '/teams/0198f3a1-2b4c-7d8e-9f01-23456789abcd'
    ) {
      sendJson(res, 200, {
        id: '0198f3a1-2b4c-7d8e-9f01-23456789abcd',
        internalId: 10,
        name: 'Finance',
        members: [
          {
            id: '0198f3a1-2b4c-7d8e-9f01-0000000000a1',
            internalId: 1,
            firstName: 'Alice',
            lastName: 'Liddell',
            role: 'owner',
          },
        ],
      });
      return;
    }

    if (method === 'GET' && path === '/teams/10') {
      sendJson(res, 200, {
        internalId: 10,
        name: 'Finance',
        members: [
          { internalId: 1, firstName: 'Alice', lastName: 'Liddell', role: 'owner' },
        ],
      });
      return;
    }

    // --- Enrolled Files ---
    if (method === 'GET' && path === '/enrolled-files') {
      const params = new URLSearchParams(queryString);
      const search = params.get('search');
      if (search === 'FAIL') {
        sendJson(res, 500, { message: 'boom' });
        return;
      }
      const files = [sampleFile].filter(
        (f) => !search || f.name.toLowerCase().includes(search.toLowerCase()),
      );
      sendJson(res, 200, files);
      return;
    }

    if (method === 'GET' && path === '/enrolled-files/file-1') {
      sendJson(res, 200, sampleFile);
      return;
    }

    if (method === 'GET' && path === '/enrolled-files/no-changes-file') {
      sendJson(res, 200, { ...sampleFile, platformId: 'no-changes-file', hasUncommittedChanges: false });
      return;
    }

    if (method === 'GET' && path === '/enrolled-files/new-file') {
      sendJson(res, 200, { ...sampleFile, platformId: 'new-file', name: 'New.xlsx', hasUncommittedChanges: true });
      return;
    }

    if (method === 'PATCH' && path === '/enrolled-files/file-1') {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}') as { name?: string };
      sendJson(res, 200, { ...sampleFile, name: name ?? sampleFile.name });
      return;
    }

    // --- File Versions ---
    if (method === 'GET' && path === '/file-versions/file/empty-file') {
      sendJson(res, 200, []);
      return;
    }

    if (method === 'GET' && path === '/file-versions/file/new-file') {
      sendJson(res, 200, []);
      return;
    }

    if (method === 'GET' && path === '/file-versions/file/file-1') {
      sendJson(res, 200, [sampleVersion]);
      return;
    }

    if (method === 'GET' && path === '/file-versions/file/version/101') {
      sendJson(res, 200, sampleVersion);
      return;
    }

    // Plan 02 ruling 5 — the completeness probe every change-history surface
    // consults before serving a row. `file-fold-pending` is the strict-refusal
    // fixture; every other known file is complete.
    if (method === 'GET' && /^\/file-versions\/file\/[^/]+\/fold-status$/.test(path)) {
      const pending = path.includes('file-fold-pending');
      sendJson(res, 200, {
        fileMsId: path.split('/')[3],
        foldPending: pending,
        foldTargetVersionId: pending ? 909 : null,
        checkedAt: '2026-08-04T00:00:00.000Z',
      });
      return;
    }

    if (
      method === 'GET' &&
      path === '/file-versions/file/file-1/cell-history'
    ) {
      const params = new URLSearchParams(queryString);
      if (params.get('cell') === 'ZZ999') {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 200, [
        {
          // KI-096: backend's `?format=mcp` projection returns
          // versionId as a semver string ("v<major>.<minor>.<patch>"),
          // not a number.
          versionId: 'v1.0.1',
          value: 1234,
          changedBy: 'Alice',
          changedAt: '2026-01-04T00:00:00Z',
        },
      ]);
      return;
    }

    // --- File Chat (Comments) ---
    if (method === 'GET' && path === '/file-chat/empty-file') {
      sendJson(res, 200, []);
      return;
    }

    if (method === 'GET' && path === '/file-chat/file-1') {
      sendJson(res, 200, [sampleComment]);
      return;
    }

    if (method === 'GET' && path === '/file-chat/single/900') {
      sendJson(res, 200, sampleComment);
      return;
    }

    if (method === 'POST' && path === '/file-chat') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as {
        fileMsId?: string;
        message?: string;
        cellReference?: string;
      };
      if (parsed.fileMsId === 'fail-file') {
        sendJson(res, 500, { message: 'boom' });
        return;
      }
      sendJson(res, 200, {
        internalId: 910,
        message: parsed.message ?? 'created',
        cellReference: parsed.cellReference,
        createdAt: '2026-01-05T00:00:00Z',
        resolved: false,
      });
      return;
    }

    if (method === 'POST' && path === '/file-chat/900/replies') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as { message?: string };
      sendJson(res, 200, {
        internalId: 911,
        message: parsed.message ?? 'reply',
        createdAt: '2026-01-05T00:05:00Z',
        resolved: false,
      });
      return;
    }

    if (method === 'PATCH' && path === '/file-chat/900') {
      sendJson(res, 200, { ...sampleComment, resolved: true });
      return;
    }

    // --- Reviews ---
    if (method === 'GET' && path === '/reviews/versions/999/requests') {
      sendJson(res, 200, []);
      return;
    }

    if (method === 'GET' && path === '/reviews/versions/101/requests') {
      sendJson(res, 200, [sampleReview]);
      return;
    }

    if (
      method === 'GET' &&
      path === '/reviews/files/file-1/latest-version/requests'
    ) {
      sendJson(res, 200, [sampleReview]);
      return;
    }

    if (method === 'GET' && path === '/reviews/requests/500') {
      sendJson(res, 200, sampleReview);
      return;
    }

    if (method === 'GET' && path === '/reviews/requests/500/activities') {
      sendJson(res, 200, [
        {
          internalId: 1,
          type: 'created',
          createdAt: '2026-01-03T00:00:00Z',
          byUserPlatformId: 'u-1',
        },
      ]);
      return;
    }

    if (method === 'POST' && path === '/reviews/requests') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as {
        subject?: string;
        description?: string;
      };
      if (parsed.subject === 'FAIL') {
        sendJson(res, 500, { message: 'boom' });
        return;
      }
      sendJson(res, 200, {
        id: 501,
        subject: parsed.subject ?? 'Review',
        description: parsed.description,
        status: 'PENDING',
        createdAt: '2026-01-06T00:00:00Z',
      });
      return;
    }

    if (method === 'POST' && path === '/reviews/requests/500/approve') {
      sendJson(res, 200, { ...sampleReview, status: 'APPROVED' });
      return;
    }

    if (method === 'PUT' && path === '/reviews/requests/500') {
      sendJson(res, 200, { ...sampleReview, status: 'CANCELLED' });
      return;
    }

    // --- File Version lifecycle ---
    if (method === 'POST' && path === '/file-versions') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as {
        enrolledFileMsId?: string;
        version?: {
          majorVersion?: number;
          minorVersion?: number;
          patchVersion?: number;
          description?: string;
        };
      };
      sendJson(res, 200, {
        internalId: 102,
        majorVersion: parsed.version?.majorVersion ?? 1,
        minorVersion: parsed.version?.minorVersion ?? 0,
        patchVersion: parsed.version?.patchVersion ?? 0,
        description: parsed.version?.description ?? 'created',
        createdAt: '2026-01-10T00:00:00Z',
        wasDiscarded: false,
        wasReverted: false,
      });
      return;
    }

    if (method === 'POST' && path === '/file-versions/file/discard-live/file-1') {
      sendJson(res, 200, {
        ...sampleVersion,
        internalId: 103,
        wasDiscarded: true,
        description: 'Discarded',
      });
      return;
    }

    // --- Unattributed Changes ---
    if (method === 'GET' && path === '/unattributed-changes/file-1/EmptySheet') {
      sendJson(res, 200, []);
      return;
    }

    if (
      method === 'GET' &&
      path === '/unattributed-changes/file-1/Sheet1'
    ) {
      sendJson(res, 200, [
        {
          sheetName: 'Sheet1',
          cellAddress: 'A1',
          oldValue: 100,
          newValue: 200,
          changeType: 'update',
          createdAt: '2026-01-07T00:00:00Z',
          byUserPlatformId: 'u-1',
        },
      ]);
      return;
    }

    // KI-097: dedicated paginated route added by backend PR #475 (KI-102).
    if (
      method === 'GET' &&
      path.startsWith('/unattributed-changes/paginated/file-1')
    ) {
      sendJson(res, 200, {
        changes: [
          {
            sheetName: 'Sheet1',
            cellAddress: 'A1',
            oldValue: 100,
            newValue: 200,
            changeType: 'update',
            createdAt: '2026-01-07T00:00:00Z',
            byUserPlatformId: 'u-1',
          },
        ],
        nextCursor: null,
        totalCount: 1,
        snapshotId: '1700000000000',
        snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
      });
      return;
    }

    sendJson(res, 404, { message: `No fixture for ${method} ${url}` });
  })().catch((error) => {
    sendJson(res, 500, { message: (error as Error).message });
  });
}
