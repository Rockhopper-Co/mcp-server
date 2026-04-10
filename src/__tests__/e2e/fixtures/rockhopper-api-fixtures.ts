import { IncomingMessage, ServerResponse } from 'node:http';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function handleMockRockhopperRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { url = '', method = 'GET' } = req;

  if (method === 'GET' && url === '/enrolled-files') {
    sendJson(res, 200, [
      {
        internalId: 1,
        platformId: 'file-1',
        fileType: 'microsoft_xlsx',
        driveMsId: 'drive-1',
        name: 'Budget.xlsx',
        hasUncommittedChanges: true,
      },
    ]);
    return;
  }

  if (method === 'GET' && url === '/enrolled-files/file-1') {
    sendJson(res, 200, {
      internalId: 1,
      platformId: 'file-1',
      fileType: 'microsoft_xlsx',
      driveMsId: 'drive-1',
      name: 'Budget.xlsx',
      hasUncommittedChanges: true,
    });
    return;
  }

  if (method === 'GET' && url === '/file-versions/file/file-1') {
    sendJson(res, 200, [
      {
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
      },
    ]);
    return;
  }

  if (method === 'GET' && url === '/file-chat/file-1') {
    sendJson(res, 200, []);
    return;
  }

  if (method === 'GET' && url === '/unattributed-changes/file-1') {
    sendJson(res, 200, []);
    return;
  }

  if (method === 'GET' && url === '/reviews/versions/101/requests') {
    sendJson(res, 200, []);
    return;
  }

  if (method === 'POST' && url === '/file-chat') {
    sendJson(res, 200, {
      internalId: 900,
      message: 'created',
    });
    return;
  }

  sendJson(res, 404, { message: `No fixture for ${method} ${url}` });
}
