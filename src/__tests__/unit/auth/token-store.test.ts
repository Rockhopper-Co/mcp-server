import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted to the top of the file, so the factory cannot
// close over a normal top-level const. vi.hoisted hoists the mock
// declaration alongside the mock() call so they resolve in order.
const { keytarMock } = vi.hoisted(() => ({
  keytarMock: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
    findPassword: vi.fn(),
    findCredentials: vi.fn(),
  },
}));
// token-store dynamic-imports keytar (lazy load — see token-store.ts).
// The mock factory must return the module-namespace shape — so the
// keytar exports live at the top level AND under `default` (handles
// both `await import('keytar')` namespace access and any
// esModuleInterop-synthesized default import).
vi.mock('keytar', () => ({ ...keytarMock, default: keytarMock }));

import {
  clearTokens,
  getTokens,
  isExpired,
  setTokens,
} from '../../../auth/token-store.js';

describe('token-store (ENG-1444)', () => {
  beforeEach(() => {
    keytarMock.getPassword.mockReset();
    keytarMock.setPassword.mockReset();
    keytarMock.deletePassword.mockReset();
  });

  describe('getTokens', () => {
    it('returns null when keytar has no entry', async () => {
      keytarMock.getPassword.mockResolvedValue(null);
      expect(await getTokens()).toBeNull();
    });

    it('parses a valid stored bundle', async () => {
      keytarMock.getPassword.mockResolvedValue(
        JSON.stringify({
          accessToken: 'rh_pat_abc',
          refreshToken: 'rh_pat_refresh_xyz',
          expiresAt: 1717000000000,
        }),
      );
      expect(await getTokens()).toEqual({
        accessToken: 'rh_pat_abc',
        refreshToken: 'rh_pat_refresh_xyz',
        expiresAt: 1717000000000,
      });
    });

    it('returns null on malformed JSON', async () => {
      keytarMock.getPassword.mockResolvedValue('{not-json');
      expect(await getTokens()).toBeNull();
    });

    it('returns null when accessToken is missing', async () => {
      keytarMock.getPassword.mockResolvedValue(
        JSON.stringify({ refreshToken: 'x' }),
      );
      expect(await getTokens()).toBeNull();
    });

    it('coerces missing optional fields to undefined/null', async () => {
      keytarMock.getPassword.mockResolvedValue(
        JSON.stringify({ accessToken: 'rh_pat_only' }),
      );
      expect(await getTokens()).toEqual({
        accessToken: 'rh_pat_only',
        refreshToken: undefined,
        expiresAt: null,
      });
    });
  });

  describe('setTokens', () => {
    it('writes the JSON-serialized bundle to keytar', async () => {
      keytarMock.setPassword.mockResolvedValue(undefined);
      await setTokens({
        accessToken: 'rh_pat_abc',
        expiresAt: 1717000000000,
      });
      expect(keytarMock.setPassword).toHaveBeenCalledWith(
        'rockhopper-mcp',
        'oauth-tokens',
        JSON.stringify({
          accessToken: 'rh_pat_abc',
          expiresAt: 1717000000000,
        }),
      );
    });
  });

  describe('clearTokens', () => {
    it('calls keytar.deletePassword', async () => {
      keytarMock.deletePassword.mockResolvedValue(true);
      await clearTokens();
      expect(keytarMock.deletePassword).toHaveBeenCalledWith(
        'rockhopper-mcp',
        'oauth-tokens',
      );
    });
  });

  describe('isExpired', () => {
    it('treats null expiresAt as expired', () => {
      expect(
        isExpired({ accessToken: 'x', expiresAt: null }, 0, 1000),
      ).toBe(true);
    });

    it('returns true when expiresAt is in the past', () => {
      expect(
        isExpired({ accessToken: 'x', expiresAt: 900 }, 0, 1000),
      ).toBe(true);
    });

    it('returns false when expiresAt is comfortably in the future', () => {
      // expiresAt 100_000, margin 60_000, now 1000 → 100_000 - 60_000 = 40_000 > 1000 → not expired
      expect(
        isExpired({ accessToken: 'x', expiresAt: 100_000 }, 60_000, 1000),
      ).toBe(false);
    });

    it('treats tokens within the safety margin as expired', () => {
      // expiresAt 1500, margin 1000, now 600 → 1500 - 1000 = 500 <= 600 → expired
      expect(
        isExpired({ accessToken: 'x', expiresAt: 1500 }, 1000, 600),
      ).toBe(true);
    });
  });

  describe('underlying keytar call failure (keychain locked / OS denies)', () => {
    it('propagates the error from getTokens', async () => {
      keytarMock.getPassword.mockRejectedValue(
        new Error('User canceled the operation.'),
      );
      await expect(getTokens()).rejects.toThrow(/canceled/);
    });
  });
});
