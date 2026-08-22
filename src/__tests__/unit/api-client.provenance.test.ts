import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';

/**
 * ENG-1756 (B6 / plan §9 decision 15) — the provenance-context client EMIT.
 * Every WRITE call (POST/PUT/PATCH/DELETE) carries the capture-context
 * headers the backend's decision-15 admission + provenance sidecar consume:
 * `X-Rockhopper-Surface` ('mcp' by default), a per-client
 * `X-Rockhopper-Session-Id`, and — once the driving human is known —
 * `X-Driving-Human`.
 *
 * ENG-3054 (plan 24, SP13) NARROWS that: `X-Rockhopper-Surface` now travels on
 * EVERY method, reads included. Reads are most of what an AI client does, so a
 * write-only surface header makes MCP time look rare — a wrong number, not an
 * absent one. The two admission-bearing headers stay write-only, because
 * decision 15's admission only ever fires on a write.
 */
describe('ApiClient provenance-context emit (ENG-1756)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const headersOfCall = (n = 0): Record<string, string> =>
    (fetchSpy.mock.calls[n][1] as { headers: Record<string, string> })
      .headers;

  const client = () =>
    new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });

  it('stamps surface + session headers on write calls', async () => {
    const c = client();
    await c.createComment({ fileMsId: 'f1', message: 'hi', versionInternalId: 1 });

    const headers = headersOfCall();
    expect(headers['X-Rockhopper-Surface']).toBe('mcp');
    expect(headers['X-Rockhopper-Session-Id']).toEqual(expect.any(String));
    expect(headers['X-Rockhopper-Session-Id'].length).toBeGreaterThan(0);
  });

  it('keeps ONE stable session id per client instance', async () => {
    const c = client();
    await c.createComment({ fileMsId: 'f1', message: 'a', versionInternalId: 1 });
    await c.createComment({ fileMsId: 'f2', message: 'b', versionInternalId: 2 });

    expect(headersOfCall(0)['X-Rockhopper-Session-Id']).toBe(
      headersOfCall(1)['X-Rockhopper-Session-Id'],
    );
  });

  // ENG-3054 — the widening, and its exact edge.
  it('stamps the surface header on READS too', async () => {
    const c = client();
    await c.getMe();

    expect(headersOfCall()['X-Rockhopper-Surface']).toBe('mcp');
  });

  it('honours a caller-supplied surface on a READ, not only on a write', async () => {
    // This is the path mcp-gateway takes: it constructs this same ApiClient
    // with `surface: 'gateway'`. Testing only the constructor default would
    // leave the gateway's real wire value unexercised.
    const c = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
      provenanceContext: { surface: 'gateway', sessionId: 'gw-session-1' },
    });
    await c.getMe();

    expect(headersOfCall()['X-Rockhopper-Surface']).toBe('gateway');
  });

  it('still withholds the admission headers on reads', async () => {
    // The widening is the surface header ALONE. Decision 15's admission fires
    // on writes only, so the session id and the driving human stay there.
    const c = client();
    c.setDrivingHuman('ms-oid-123');
    await c.getMe();

    const headers = headersOfCall();
    expect(headers['X-Rockhopper-Session-Id']).toBeUndefined();
    expect(headers['X-Driving-Human']).toBeUndefined();
  });

  it('omits X-Driving-Human until the driving human is known, then emits it', async () => {
    const c = client();
    await c.createComment({ fileMsId: 'f1', message: 'a', versionInternalId: 1 });
    expect(headersOfCall(0)['X-Driving-Human']).toBeUndefined();

    c.setDrivingHuman('ms-oid-123');
    await c.createComment({ fileMsId: 'f2', message: 'b', versionInternalId: 2 });
    expect(headersOfCall(1)['X-Driving-Human']).toBe('ms-oid-123');
  });

  it('honours a configured surface + session id (gateway wiring)', async () => {
    const c = new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
      provenanceContext: {
        surface: 'gateway',
        sessionId: 'gw-session-1',
        drivingHumanPlatformId: 'ms-oid-456',
      },
    });
    await c.createComment({ fileMsId: 'f1', message: 'a', versionInternalId: 1 });

    const headers = headersOfCall();
    expect(headers['X-Rockhopper-Surface']).toBe('gateway');
    expect(headers['X-Rockhopper-Session-Id']).toBe('gw-session-1');
    expect(headers['X-Driving-Human']).toBe('ms-oid-456');
  });

  it('setDrivingHuman(null) clears the header again', async () => {
    const c = client();
    c.setDrivingHuman('ms-oid-123');
    c.setDrivingHuman(null);
    await c.createComment({ fileMsId: 'f1', message: 'a', versionInternalId: 1 });
    expect(headersOfCall()['X-Driving-Human']).toBeUndefined();
  });
});
