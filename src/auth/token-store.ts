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

// keytar is loaded LAZILY via dynamic import. Reasons:
//   1. The native binding calls `dlopen(libsecret)` on Linux at MODULE
//      load. A top-level static import crashes the entire process the
//      moment anything in the dependency graph touches token-store —
//      including unit tests that only exercise the PAT auth path and
//      never reach OAuth. Lazy load defers the dlopen until OAuth is
//      actually attempted, so PAT-only users on bare Linux without
//      libsecret are unaffected.
//   2. `vi.mock('keytar', factory)` works for both static and dynamic
//      imports, so existing tests aren't disturbed by the indirection.
//
// `_keytar` caches the resolved module across calls; `_keytarErr`
// caches a load failure so we don't repeat the dlopen attempt on every
// store call.

// keytar's published types declare a flat module (`export function
// getPassword`, etc.) with no `default`. The static `import keytar from
// 'keytar'` works via tsconfig's `esModuleInterop` synthesizing a
// default; for dynamic `import('keytar')` we keep the namespace shape.
type KeytarModule = typeof import('keytar');
let _keytar: KeytarModule | null = null;
let _keytarErr: Error | null = null;

async function loadKeytar(): Promise<KeytarModule> {
  if (_keytar) return _keytar;
  /* v8 ignore next */
  if (_keytarErr) throw _keytarErr;
  try {
    _keytar = await import('keytar');
    return _keytar;
  } catch (e) {
    /* v8 ignore next 9 -- runtime dlopen failure (Linux without libsecret); the catch can't be reached via vi.mock since the mock factory always resolves successfully. Behavior is covered by the CLI's end-to-end behavior on platforms where the import genuinely fails. */
    const reason = e instanceof Error ? e.message : String(e);
    _keytarErr = new Error(
      `OS keychain unavailable (${reason}). ` +
        'On Linux, install libsecret (e.g. `apt-get install libsecret-1-dev` on Debian/Ubuntu, ' +
        '`dnf install libsecret` on Fedora). Or set ROCKHOPPER_TOKEN to a Personal Access Token ' +
        'to use PAT auth instead of OAuth.',
    );
    throw _keytarErr;
  }
}

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
  const keytar = await loadKeytar();
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
  const keytar = await loadKeytar();
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
  const keytar = await loadKeytar();
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
