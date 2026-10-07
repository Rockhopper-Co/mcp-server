import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';

/**
 * ENG-6757 — the compare routes choose the ledger read from `X-Client-Surface`
 * and nothing else (backend
 * `file-handler.controller.ts!compareSummaryByEnrolledFileId`). Without it the
 * backend recomputes from the file bytes, where a change with no named editor
 * reads `pending`. Pinned on the REQUEST: a response fixture cannot show a
 * header the client never sent.
 */
const sent = async (surface?: string): Promise<[string, unknown][]> => {
  const body = { sheets: [], snapshotId: 's', cellChanges: [], nextCursor: null };
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  vi.stubGlobal('fetch', fetchSpy);
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    token: 't',
    ...(surface ? { provenanceContext: { surface } } : {}),
  });
  await client.getCompareSummary(42);
  await client.getCompareSheet(42, 0, 'snap');
  await client.listEnrolledFiles();
  return fetchSpy.mock.calls.map(([url, init]) => [
    String(url).split('?')[0],
    (init as { headers: Record<string, string> }).headers['X-Client-Surface'] ?? null,
  ]);
};

const SUMMARY = 'https://api.test/file-handler/compare-summary/by-enrolled-file/42';
const SHEET = 'https://api.test/file-handler/compare-sheet/by-enrolled-file/42/0';
const LIST = 'https://api.test/enrolled-files';

describe('compare calls name the client surface (ENG-6757)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends mcp-server from the local server, on the compare calls only', async () => {
    // `listEnrolledFiles` stays bare: other routes PERSIST this header as the
    // submitting surface, and starting that record is not this change's call.
    expect(await sent()).toEqual([
      [SUMMARY, 'mcp-server'],
      [SHEET, 'mcp-server'],
      [LIST, null],
    ]);
  });

  it('sends mcp-gateway when the remote gateway drives this client', async () => {
    expect(await sent('gateway')).toEqual([
      [SUMMARY, 'mcp-gateway'],
      [SHEET, 'mcp-gateway'],
      [LIST, null],
    ]);
  });

  it('sends nothing for a surface it cannot spell, rather than a guess', async () => {
    for (const surface of ['other', 'constructor']) {
      expect(await sent(surface)).toEqual([
        [SUMMARY, null],
        [SHEET, null],
        [LIST, null],
      ]);
    }
  });
});
