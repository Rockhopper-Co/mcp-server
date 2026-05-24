import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceGrantError,
  pollOnce,
  requestDeviceCode,
  runDeviceGrantFlow,
} from '../../../auth/device-grant-client.js';

const BASE = 'https://api.test.rockhopper.co';
const CLIENT_ID = 'mcp-stdio';

/** Build a Response-like object for the mocked fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('device-grant-client (ENG-1444)', () => {
  describe('requestDeviceCode', () => {
    it('POSTs clientId and returns the parsed body', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          deviceCode: 'dev-1',
          userCode: 'ABCD2345',
          verificationUri: 'https://app.rockhopper.co/device',
          verificationUriComplete:
            'https://app.rockhopper.co/device?user_code=ABCD2345',
          expiresIn: 600,
          interval: 5,
        }),
      );

      const res = await requestDeviceCode({
        baseUrl: BASE,
        clientId: CLIENT_ID,
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/auth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
      expect(res.deviceCode).toBe('dev-1');
      expect(res.userCode).toBe('ABCD2345');
    });

    it('wraps network failures as DeviceGrantError(network_error)', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(
        requestDeviceCode({ baseUrl: BASE, clientId: CLIENT_ID, fetchImpl }),
      ).rejects.toMatchObject({
        name: 'DeviceGrantError',
        code: 'network_error',
      });
    });

    it('rejects on non-2xx HTTP', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
      await expect(
        requestDeviceCode({ baseUrl: BASE, clientId: CLIENT_ID, fetchImpl }),
      ).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('pollOnce', () => {
    it('returns kind: success with the token bundle on 200', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          accessToken: 'rh_pat_abc',
          tokenType: 'Bearer',
          expiresIn: 3600,
        }),
      );
      const result = await pollOnce(
        { baseUrl: BASE, clientId: CLIENT_ID, fetchImpl },
        'dev-1',
      );
      expect(result).toMatchObject({
        kind: 'success',
        bundle: { accessToken: 'rh_pat_abc' },
      });
    });

    it('returns kind: pending on authorization_pending', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'authorization_pending' }, 400),
        );
      const result = await pollOnce(
        { baseUrl: BASE, clientId: CLIENT_ID, fetchImpl },
        'dev-1',
      );
      expect(result).toEqual({ kind: 'pending' });
    });

    it('returns kind: slow_down on slow_down', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'slow_down' }, 400));
      const result = await pollOnce(
        { baseUrl: BASE, clientId: CLIENT_ID, fetchImpl },
        'dev-1',
      );
      expect(result).toEqual({ kind: 'slow_down' });
    });

    it('throws DeviceGrantError(access_denied) on access_denied', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(
          { error: 'access_denied', error_description: 'Wrong client' },
          400,
        ),
      );
      await expect(
        pollOnce(
          { baseUrl: BASE, clientId: CLIENT_ID, fetchImpl },
          'dev-1',
        ),
      ).rejects.toMatchObject({
        name: 'DeviceGrantError',
        code: 'access_denied',
        message: 'Wrong client',
      });
    });

    it('throws DeviceGrantError(expired_token) on expired_token', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'expired_token' }, 400));
      await expect(
        pollOnce(
          { baseUrl: BASE, clientId: CLIENT_ID, fetchImpl },
          'dev-1',
        ),
      ).rejects.toMatchObject({
        code: 'expired_token',
      });
    });

    it('throws DeviceGrantError(unknown) on unrecognized error', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'martian_attack' }, 400));
      await expect(
        pollOnce(
          { baseUrl: BASE, clientId: CLIENT_ID, fetchImpl },
          'dev-1',
        ),
      ).rejects.toMatchObject({
        code: 'unknown',
      });
    });
  });

  describe('runDeviceGrantFlow (orchestration)', () => {
    let sleepCalls: number[];
    let sleep: (ms: number) => Promise<void>;

    beforeEach(() => {
      sleepCalls = [];
      sleep = async (ms: number) => {
        sleepCalls.push(ms);
      };
    });

    it('happy path: request → pending → success returns the bundle', async () => {
      const fetchImpl = vi.fn();
      // 1. /auth/device/code
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({
          deviceCode: 'dev-1',
          userCode: 'ABCD2345',
          verificationUri: 'https://example/device',
          verificationUriComplete: 'https://example/device?user_code=ABCD2345',
          expiresIn: 600,
          interval: 5,
        }),
      );
      // 2. first poll → pending
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: 'authorization_pending' }, 400),
      );
      // 3. second poll → success
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({
          accessToken: 'rh_pat_xyz',
          tokenType: 'Bearer',
          expiresIn: 3600,
        }),
      );

      const onUserCode = vi.fn();
      const result = await runDeviceGrantFlow({
        baseUrl: BASE,
        clientId: CLIENT_ID,
        fetchImpl,
        sleep,
        onUserCode,
      });

      expect(result).toMatchObject({
        accessToken: 'rh_pat_xyz',
        tokenType: 'Bearer',
      });
      expect(onUserCode).toHaveBeenCalledWith(
        expect.objectContaining({ userCode: 'ABCD2345' }),
      );
      // Polled with 5s interval on the first attempt.
      expect(sleepCalls).toEqual([5_000, 5_000]);
    });

    it('slow_down bumps the interval by 5s', async () => {
      const fetchImpl = vi.fn();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({
          deviceCode: 'dev-1',
          userCode: 'ABCD2345',
          verificationUri: 'https://example/device',
          verificationUriComplete: 'https://example/device?user_code=ABCD2345',
          expiresIn: 600,
          interval: 5,
        }),
      );
      // poll 1 → slow_down (interval becomes 10s)
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: 'slow_down' }, 400),
      );
      // poll 2 → success
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({
          accessToken: 'rh_pat_xyz',
          tokenType: 'Bearer',
          expiresIn: 3600,
        }),
      );

      await runDeviceGrantFlow({
        baseUrl: BASE,
        clientId: CLIENT_ID,
        fetchImpl,
        sleep,
        onUserCode: () => undefined,
      });

      // First sleep is the initial 5s; second is bumped to 10s after slow_down.
      expect(sleepCalls).toEqual([5_000, 10_000]);
    });

    it('access_denied during poll terminates the flow', async () => {
      const fetchImpl = vi.fn();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({
          deviceCode: 'dev-1',
          userCode: 'ABCD2345',
          verificationUri: 'https://example/device',
          verificationUriComplete: 'https://example/device?user_code=ABCD2345',
          expiresIn: 600,
          interval: 5,
        }),
      );
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: 'access_denied' }, 400),
      );

      await expect(
        runDeviceGrantFlow({
          baseUrl: BASE,
          clientId: CLIENT_ID,
          fetchImpl,
          sleep,
          onUserCode: () => undefined,
        }),
      ).rejects.toMatchObject({
        name: 'DeviceGrantError',
        code: 'access_denied',
      });
    });

    it('expired deadline terminates with DeviceGrantError(expired_token)', async () => {
      // expiresIn: 0 → deadline === now → loop body never runs → throw.
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          deviceCode: 'dev-1',
          userCode: 'ABCD2345',
          verificationUri: 'https://example/device',
          verificationUriComplete: 'https://example/device?user_code=ABCD2345',
          expiresIn: 0,
          interval: 5,
        }),
      );

      await expect(
        runDeviceGrantFlow({
          baseUrl: BASE,
          clientId: CLIENT_ID,
          fetchImpl,
          sleep,
          onUserCode: () => undefined,
        }),
      ).rejects.toMatchObject({
        code: 'expired_token',
      });
    });
  });

  describe('DeviceGrantError', () => {
    it('carries the error code on .code', () => {
      const err = new DeviceGrantError('access_denied', 'nope');
      expect(err.code).toBe('access_denied');
      expect(err.message).toBe('nope');
      expect(err.name).toBe('DeviceGrantError');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
