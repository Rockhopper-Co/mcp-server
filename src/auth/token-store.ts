/**
 * ENG-1444 / KI-081 — RFC 8628 device-grant token storage.
 *
 * Wraps `keytar` to persist OAuth tokens in the OS-native keychain
 * (Keychain on macOS, Credential Manager on Windows, libsecret on
 * Linux). The mcp-server is spawned by AI clients (Cursor, Claude
 * Desktop) and survives across client launches, so tokens must live
 * outside the process.
 *
 * One bundle per machine — there's no multi-user concept inside a
 * single mcp-server install. If the user re-runs the device-grant
 * flow, the prior bundle is overwritten.
 *
 * Linux without libsecret installed will throw on first keytar call
 * (the native binding loads but the backend lookup fails). The CLI
 * surfaces a clear remediation message ("apt-get install
 * libsecret-tools" etc.) — we do NOT silently fall back to plaintext
 * file storage. Encrypted file fallback may land in a follow-up.
 */

import keytar from 'keytar';

const KEYTAR_SERVICE = 'rockhopper-mcp';
const KEYTAR_ACCOUNT = 'oauth-tokens';

export interface OAuthTokenBundle {
  accessToken: string;
  /** Optional — backend does not currently issue refresh tokens (ENG-1446). */
  refreshToken?: string;
  /** Epoch milliseconds. Null means "no expiry set" — treat as expired. */
  expiresAt: number | null;
}

/**
 * Read the persisted OAuth bundle. Returns null if no bundle is stored
 * OR if the stored value is malformed (corrupted entry — treat as
 * "no tokens" and let the CLI initiate a fresh device flow).
 */
export async function getTokens(): Promise<OAuthTokenBundle | null> {
  const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accessToken !== 'string') return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken:
        typeof parsed.refreshToken === 'string'
          ? parsed.refreshToken
          : undefined,
      expiresAt:
        typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the OAuth bundle, overwriting any prior bundle.
 */
export async function setTokens(bundle: OAuthTokenBundle): Promise<void> {
  await keytar.setPassword(
    KEYTAR_SERVICE,
    KEYTAR_ACCOUNT,
    JSON.stringify(bundle),
  );
}

/**
 * Delete any persisted bundle. Safe to call when nothing is stored
 * (keytar returns false; we ignore the return).
 */
export async function clearTokens(): Promise<void> {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
}

/**
 * `true` if `bundle.expiresAt` is in the past (or null). Pure helper —
 * the device-grant client wires this into its refresh-on-expiry logic.
 *
 * A small safety margin (60s by default) treats tokens about to expire
 * as already expired, so the client refreshes BEFORE the API rejects
 * the next call.
 */
export function isExpired(
  bundle: OAuthTokenBundle,
  marginMs = 60_000,
  now = Date.now(),
): boolean {
  if (bundle.expiresAt === null) return true;
  return bundle.expiresAt - marginMs <= now;
}
