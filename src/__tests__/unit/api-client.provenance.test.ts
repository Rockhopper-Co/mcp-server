import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';

/**
 * ENG-1756 (B6 / plan §9 decision 15) — the provenance-context client EMIT.
 * Every WRITE call (POST/PUT/PATCH/DELETE) carries the capture-context
 * headers the backend's decision-15 admission + provenance sidecar consume:
 * `X-Rockhopper-Surface` ('mcp' by default), a per-client
 * `X-Rockhopper-Session-Id`, and — once the driving human is known —
 * `X-Driving-Human`. Reads stay header-free (no admission on reads).
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

  it('does NOT stamp provenance headers on reads', async () => {
    const c = client();
    await c.getMe();

    const headers = headersOfCall();
    expect(headers['X-Rockhopper-Surface']).toBeUndefined();
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
