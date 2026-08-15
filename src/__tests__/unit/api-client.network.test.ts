import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';

// KI-225 — the failure-detection paths in `ApiClient.request`. The other
// api-client suites always mock `fetch` to RESOLVE (200 / 4xx via a Response),
// so the thrown-`fetch` branch (network unreachable, api-client.ts 86-93) never
// runs. These tests drive a rejecting fetch and an auth-rejection Response.

describe('ApiClient failure logging (KI-225)', () => {
  function makeClient(): ApiClient {
    return new ApiClient({
      baseUrl: 'https://api.rockhopper.co',
      token: 'rh_pat_test',
    });
  }

  it('logs api_unreachable and re-throws when fetch itself rejects', async () => {
    const netErr = new Error('fetch failed: ECONNREFUSED');
    const fetchSpy = vi.fn().mockRejectedValue(netErr);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeClient().getMe()).rejects.toThrow('ECONNREFUSED');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('classifies a 401 as auth_failed and throws the API error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Invalid token'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeClient().getMe()).rejects.toThrow('Rockhopper API 401');

    vi.unstubAllGlobals();
  });

  it('falls back to an empty error body when reading the error response text fails', async () => {
    // Exercises the `.catch(() => '')` on `response.text()` (api-client.ts:116):
    // every other suite resolves text(), so this rejection path never runs.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: () => Promise.resolve({}),
      text: () => Promise.reject(new Error('response stream broke')),
    });
    vi.stubGlobal('fetch', fetchSpy);

    // body resolves to '' → the thrown message ends with the status line + ' — '
    await expect(makeClient().getMe()).rejects.toThrow('Rockhopper API 500');

    vi.unstubAllGlobals();
  });

  // ENG-2208 — the mid-session expiry notice. Once, on the first 401 only:
  // a token that dies during a session otherwise produces a stream of tool
  // errors the human never sees, and repeating the line on every subsequent
  // call would bury the stdio client's own output.
  it('fires the auth-expired handler once, on the first 401 only', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Invalid token'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const onExpired = vi.fn();
    const client = makeClient();
    client.setAuthExpiredHandler(onExpired);

    await expect(client.getMe()).rejects.toThrow('Rockhopper API 401');
    await expect(client.getMe()).rejects.toThrow('Rockhopper API 401');
    await expect(client.getMe()).rejects.toThrow('Rockhopper API 401');

    expect(onExpired).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('does not fire the auth-expired handler for a 403 or a 500', async () => {
    for (const status of [403, 500]) {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: 'Nope',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const onExpired = vi.fn();
      const client = makeClient();
      client.setAuthExpiredHandler(onExpired);

      await expect(client.getMe()).rejects.toThrow(`Rockhopper API ${status}`);
      expect(onExpired, `status=${status}`).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    }
  });

  it('throws the same 401 error when no auth-expired handler is registered', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Invalid token'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeClient().getMe()).rejects.toThrow('Rockhopper API 401');

    vi.unstubAllGlobals();
  });

  it('builds the request path for the read methods (getTeam, listEnrolledFiles)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve('[]'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    // Response shape may not satisfy the per-endpoint schema; we only care that
    // the method runs and builds the right URL, so swallow any schema throw.
    await client.getTeam(7).catch(() => undefined);
    await client
      .listEnrolledFiles({ search: 'budget', matchIn: 'name' })
      .catch(() => undefined);

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/teams/7'))).toBe(true);
    expect(
      urls.some(
        (u) => u.includes('/enrolled-files?') && u.includes('search=budget'),
      ),
    ).toBe(true);

    vi.unstubAllGlobals();
  });
});
