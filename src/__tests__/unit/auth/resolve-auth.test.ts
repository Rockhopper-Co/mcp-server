import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceGrantError } from '../../../auth/device-grant-client.js';
import {
  AuthResolutionError,
  resolveAuth,
} from '../../../auth/resolve-auth.js';

const BASE = 'https://api.test.rockhopper.co';

describe('resolve-auth (ENG-1444)', () => {
  let tokenStoreGet: ReturnType<typeof vi.fn>;
  let tokenStoreSet: ReturnType<typeof vi.fn>;
  let tokenStoreClear: ReturnType<typeof vi.fn>;
  let isExpiredFn: ReturnType<typeof vi.fn>;
  let deviceGrantFlow: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tokenStoreGet = vi.fn().mockResolvedValue(null);
    tokenStoreSet = vi.fn().mockResolvedValue(undefined);
    tokenStoreClear = vi.fn().mockResolvedValue(undefined);
    isExpiredFn = vi.fn().mockReturnValue(false);
    deviceGrantFlow = vi.fn();
    log = vi.fn();
  });

  function call(overrides: Parameters<typeof resolveAuth>[0] = { baseUrl: BASE }) {
    return resolveAuth({
      baseUrl: BASE,
      tokenStoreGet,
      tokenStoreSet,
      tokenStoreClear,
      isExpiredFn,
      deviceGrantFlow,
      log,
      ...overrides,
    });
  }

  describe('PAT env path', () => {
    it('returns the PAT when env var is set and well-formed', async () => {
      const res = await call({
        baseUrl: BASE,
        patFromEnv: 'rh_pat_abcdef1234',
      });
      expect(res).toEqual({
        accessToken: 'rh_pat_abcdef1234',
        source: 'pat',
      });
      // Should NOT touch token store or device-grant when PAT is provided.
      expect(tokenStoreGet).not.toHaveBeenCalled();
      expect(deviceGrantFlow).not.toHaveBeenCalled();
    });

    it('throws AuthResolutionError(pat_malformed) when prefix is wrong', async () => {
      await expect(
        call({ baseUrl: BASE, patFromEnv: 'oauth-token-xyz' }),
      ).rejects.toMatchObject({
        name: 'AuthResolutionError',
        code: 'pat_malformed',
      });
    });
  });

  describe('stored OAuth path', () => {
    it('returns the stored access token when present and not expired', async () => {
      tokenStoreGet.mockResolvedValue({
        accessToken: 'rh_pat_stored',
        expiresAt: 9999999999999,
      });
      isExpiredFn.mockReturnValue(false);

      const res = await call();

      expect(res).toEqual({
        accessToken: 'rh_pat_stored',
        source: 'stored-oauth',
      });
      expect(deviceGrantFlow).not.toHaveBeenCalled();
      expect(tokenStoreClear).not.toHaveBeenCalled();
    });

    it('clears expired bundle and runs device-grant', async () => {
      tokenStoreGet.mockResolvedValue({
        accessToken: 'rh_pat_stale',
        expiresAt: 1,
      });
      isExpiredFn.mockReturnValue(true);
      deviceGrantFlow.mockResolvedValue({
        accessToken: 'rh_pat_fresh',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      const res = await call();

      expect(tokenStoreClear).toHaveBeenCalled();
      expect(deviceGrantFlow).toHaveBeenCalled();
      expect(res).toEqual({
        accessToken: 'rh_pat_fresh',
        source: 'device-grant',
      });
    });

    it('logs and falls through when keychain read throws', async () => {
      tokenStoreGet.mockRejectedValue(new Error('libsecret not installed'));
      deviceGrantFlow.mockResolvedValue({
        accessToken: 'rh_pat_fresh',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      const res = await call();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('libsecret not installed'),
      );
      expect(res.source).toBe('device-grant');
    });
  });

  describe('device-grant path', () => {
    beforeEach(() => {
      tokenStoreGet.mockResolvedValue(null);
    });

    it('runs the flow and persists the resulting bundle', async () => {
      deviceGrantFlow.mockResolvedValue({
        accessToken: 'rh_pat_oauth',
        refreshToken: 'rh_pat_refresh',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      const before = Date.now();
      const res = await call();
      const after = Date.now();

      expect(res).toEqual({
        accessToken: 'rh_pat_oauth',
        source: 'device-grant',
      });
      // Persisted with computed expiresAt.
      expect(tokenStoreSet).toHaveBeenCalledTimes(1);
      const persisted = tokenStoreSet.mock.calls[0][0];
      expect(persisted.accessToken).toBe('rh_pat_oauth');
      expect(persisted.refreshToken).toBe('rh_pat_refresh');
      // expiresAt = now + 3600s
      expect(persisted.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
      expect(persisted.expiresAt).toBeLessThanOrEqual(after + 3600_000);
    });

    it('wraps DeviceGrantError as AuthResolutionError(device_grant_failed)', async () => {
      deviceGrantFlow.mockRejectedValue(
        new DeviceGrantError('access_denied', 'user said no'),
      );

      await expect(call()).rejects.toMatchObject({
        name: 'AuthResolutionError',
        code: 'device_grant_failed',
        message: expect.stringContaining('access_denied'),
      });
    });

    it('wraps non-DeviceGrantError as AuthResolutionError(device_grant_failed)', async () => {
      deviceGrantFlow.mockRejectedValue(new Error('weird crash'));
      await expect(call()).rejects.toMatchObject({
        code: 'device_grant_failed',
      });
    });

    it('non-fatal warning when token-store write fails (still returns)', async () => {
      deviceGrantFlow.mockResolvedValue({
        accessToken: 'rh_pat_oauth',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });
      tokenStoreSet.mockRejectedValue(new Error('keychain locked'));

      const res = await call();

      expect(res.source).toBe('device-grant');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Warning'),
      );
    });

    it('passes clientId override through to the flow', async () => {
      deviceGrantFlow.mockResolvedValue({
        accessToken: 'rh_pat_oauth',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      await call({ baseUrl: BASE, clientId: 'mcp-cursor' });

      expect(deviceGrantFlow).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'mcp-cursor' }),
      );
    });

    it('defaults clientId to mcp-stdio', async () => {
      deviceGrantFlow.mockResolvedValue({
        accessToken: 'rh_pat_oauth',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      await call();

      expect(deviceGrantFlow).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'mcp-stdio' }),
      );
    });
  });

  describe('AuthResolutionError', () => {
    it('carries the code on .code', () => {
      const err = new AuthResolutionError('pat_malformed', 'bad');
      expect(err.code).toBe('pat_malformed');
      expect(err.message).toBe('bad');
      expect(err.name).toBe('AuthResolutionError');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
