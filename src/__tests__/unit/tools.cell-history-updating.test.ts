// ENG-7243 — `get_cell_history` could not tell an updating history from a
// complete one. The backend (ENG-7039, backend
// `cell-history-pair-coverage.ts!CLIENT_CAPABILITIES_HEADER`) serves a capable
// client the rows it holds plus `X-Ledger-Freshness`; an mcp-server that does
// not announce itself keeps the strict 503. So this server must (a) announce
// the capability on the REQUEST and (b) render the header: a partial list is
// marked UPDATING, and an empty one is never "No history found".
//
// The tool is driven through the REAL ApiClient over a stubbed fetch, so the
// wire header is what is under test — not a fixture of the parsed answer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { freshnessFromHeaders } from '../../ledger-freshness.js';
import { DEFAULT_RETRY_AFTER_SECONDS } from '../../not-ready.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const UPDATING = JSON.stringify({
  state: 'updating',
  reasons: [{ code: 'pair_unrecorded' }],
  awaitingFoldVersionIds: [77],
  liveRefreshQueued: false,
});

const ROWS = [
  { versionId: '101', value: 1, changedBy: 'ms-user-1', changedAt: '2026-10-01T00:00:00Z' },
  { versionId: '102', value: 2, changedBy: 'ms-user-1', changedAt: '2026-10-02T00:00:00Z' },
];

type Wire = { body: unknown; headers?: Record<string, string> };

/** A real ApiClient whose fetch answers every request with `wire`. */
function wired(wire: Wire) {
  const fetchSpy = vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(wire.headers ?? {}),
      json: () => Promise.resolve(wire.body),
      text: () => Promise.resolve(JSON.stringify(wire.body)),
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const real = new ApiClient({ baseUrl: 'https://api.test', token: 't' });
  const api = createMockApiClient();
  api.getCellHistory.mockImplementation((...a: unknown[]) =>
    (real.getCellHistory as (...x: unknown[]) => unknown)(...a),
  );
  api.getAnchorHistory.mockImplementation((...a: unknown[]) =>
    (real.getAnchorHistory as (...x: unknown[]) => unknown)(...a),
  );
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  const handler = server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_cell_history',
  )![2];
  return { handler, fetchSpy, api };
}

const cellArgs = { fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'A1' };

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe('get_cell_history — an updating history says so (ENG-7243)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a partial list with the UPDATING line', async () => {
    const { handler } = wired({ body: ROWS, headers: { 'X-Ledger-Freshness': UPDATING } });
    const out = text(await handler(cellArgs));
    expect(out.startsWith('UPDATING — incomplete:')).toBe(true);
    expect(out).toContain('2 change(s) so far are listed below; more may appear.');
    expect(out).toContain('Do not report this as the complete history.');
    // The rows are still served — never dropped.
    expect(out).toContain('Version 101');
    expect(out).toContain('Version 102');
  });

  it('never prints "No history found" for an empty list while updating', async () => {
    const { handler } = wired({ body: [], headers: { 'X-Ledger-Freshness': UPDATING } });
    const out = text(await handler(cellArgs));
    expect(out).not.toContain('No history found');
    expect(out.startsWith('UPDATING — incomplete:')).toBe(true);
  });

  it('positive control: an empty list WITHOUT the header is still a real zero', async () => {
    const { handler } = wired({ body: [] });
    const out = text(await handler(cellArgs));
    expect(out).toBe('No history found for A1 on "Sheet1".');
  });

  it('a complete list carries no marker', async () => {
    const { handler } = wired({ body: ROWS });
    const out = text(await handler(cellArgs));
    expect(out).not.toContain('UPDATING');
    expect(out.startsWith('Cell A1 on "Sheet1" — 2 change(s):')).toBe(true);
  });

  it('announces the capability on the cell-history REQUEST', async () => {
    const { handler, fetchSpy } = wired({ body: ROWS });
    await handler(cellArgs);
    const call = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/cell-history?'),
    );
    expect(call).toBeDefined();
    const headers = (call![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Rockhopper-Client-Capabilities']).toBe('ledger-freshness');
  });

  it('a pending fold no longer refuses: it serves the rows under the marker', async () => {
    const { handler, api } = wired({ body: ROWS });
    api.getFoldStatus.mockResolvedValue({ foldPending: true, foldTargetVersionId: 9 });
    const result = await handler(cellArgs);
    expect(result.isError).toBeUndefined();
    expect(text(result).startsWith('UPDATING — incomplete:')).toBe(true);
    expect(api.getCellHistory).toHaveBeenCalled();
  });
});

describe('get_cell_history anchor arm — the same marker (ENG-7243)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const envelope = (extra: Record<string, unknown> = {}) => ({
    documentType: 'text',
    anchorId: 'w14-paraId-7A3B',
    anchorLane: 'both',
    anchorIdentity: 'provider_id',
    history: [],
    truncated: false,
    ...extra,
  });
  const anchorArgs = { fileMsId: 'file-1', anchorId: 'w14-paraId-7A3B' };

  it('marks an updating empty element history from the header, never a plain zero', async () => {
    const { handler } = wired({ body: envelope(), headers: { 'X-Ledger-Freshness': UPDATING } });
    const out = text(await handler(anchorArgs));
    expect(out.startsWith('UPDATING — incomplete:')).toBe(true);
    expect(out).not.toContain('No change recorded for element');
  });

  it('marks it from a `ledgerFreshness` body field too', async () => {
    const { handler } = wired({ body: envelope({ ledgerFreshness: JSON.parse(UPDATING) }) });
    const out = text(await handler(anchorArgs));
    expect(out.startsWith('UPDATING — incomplete:')).toBe(true);
  });

  it('positive control: no header, no field — the plain element answer', async () => {
    const { handler, fetchSpy } = wired({ body: envelope() });
    const out = text(await handler(anchorArgs));
    expect(out.startsWith('No change recorded for element')).toBe(true);
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/cell-history?'));
    const headers = (call![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Rockhopper-Client-Capabilities']).toBe('ledger-freshness');
  });
});

describe('freshnessFromHeaders — never reads a present header as complete', () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it('absent header: current', () => {
    expect(freshnessFromHeaders(h({})).state).toBe('current');
    expect(freshnessFromHeaders(undefined).state).toBe('current');
  });

  it('a header naming current: current', () => {
    expect(
      freshnessFromHeaders(h({ 'X-Ledger-Freshness': '{"state":"current"}' })).state,
    ).toBe('current');
  });

  it('an unparseable header: updating, with the server Retry-After', () => {
    const f = freshnessFromHeaders(
      h({ 'X-Ledger-Freshness': 'not json', 'Retry-After': '30' }),
    );
    expect(f).toEqual({ state: 'updating', retryAfterSeconds: 30 });
  });

  it('an updating header without Retry-After: the shared default', () => {
    const f = freshnessFromHeaders(h({ 'X-Ledger-Freshness': UPDATING }));
    expect(f).toEqual({ state: 'updating', retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
  });
});
