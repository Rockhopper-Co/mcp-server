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
  status: 'pending',
  createdAt: '2026-01-03T00:00:00Z',
  requester: {
    internalId: 1,
    firstName: 'Alice',
    lastName: 'Liddell',
  },
};

export function handleMockRockhopperRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  void (async () => {
    const { url = '', method = 'GET' } = req;
    const [path, queryString = ''] = url.split('?');

    // --- Users ---
    if (method === 'GET' && path === '/users/me') {
      sendJson(res, 200, { internalId: 1, firstName: 'Alice', lastName: 'Liddell' });
      return;
    }

    // --- Teams ---
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

    if (method === 'GET' && path === '/file-versions/file/file-1') {
      sendJson(res, 200, [sampleVersion]);
      return;
    }

    if (method === 'GET' && path === '/file-versions/file/version/101') {
      sendJson(res, 200, sampleVersion);
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
          versionId: 101,
          value: 1234,
          changedBy: 'Alice',
          changedAt: '2026-01-04T00:00:00Z',
          sheetName: params.get('sheetName'),
          cellAddress: params.get('cell'),
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
        status: 'pending',
        createdAt: '2026-01-06T00:00:00Z',
      });
      return;
    }

    if (method === 'POST' && path === '/reviews/requests/500/approve') {
      sendJson(res, 200, { ...sampleReview, status: 'approved' });
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
      (path === '/unattributed-changes/file-1' ||
        path === '/unattributed-changes/file-1/Sheet1')
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

    sendJson(res, 404, { message: `No fixture for ${method} ${url}` });
  })().catch((error) => {
    sendJson(res, 500, { message: (error as Error).message });
  });
}
