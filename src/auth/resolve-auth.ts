/**
 * ENG-1444 / KI-081 — auth resolution for the mcp-server CLI.
 *
 * Decides where the bearer token comes from on each launch, in order:
 *
 *   1. `ROCKHOPPER_TOKEN` env var — Personal Access Token. Headless /
 *      CI / scripted scenarios. Same path as pre-OAuth releases.
 *   2. Stored OAuth bundle in the OS keychain (token-store). The user
 *      previously completed the device-grant flow; if the access
 *      token is still valid, use it.
 *   3. Device-grant flow — issues a fresh code, prints the user code
 *      + verification URI to stderr, polls for approval, persists the
 *      resulting bundle to the keychain for next time.
 *
 * Returns `{ accessToken, source }` where `source` is one of
 * `'pat' | 'stored-oauth' | 'device-grant'` for logging / debugging.
 *
 * Heavy dependencies (token store, device-grant flow, env reads) are
 * injectable for tests.
 */

import {
  DeviceGrantError,
  runDeviceGrantFlow,
  type DeviceTokenSuccess,
} from './device-grant-client.js';
import {
  clearTokens as defaultClearTokens,
  getTokens as defaultGetTokens,
  isExpired as defaultIsExpired,
  setTokens as defaultSetTokens,
  type OAuthTokenBundle,
} from './token-store.js';

const PAT_PREFIX = 'rh_pat_';

export type AuthSource = 'pat' | 'stored-oauth' | 'device-grant';

export interface ResolvedAuth {
  accessToken: string;
  source: AuthSource;
}

export interface ResolveAuthOptions {
  baseUrl: string;
  /** Defaults to `'mcp-stdio'`. */
  clientId?: string;
  /** Typically `process.env.ROCKHOPPER_TOKEN`. */
  patFromEnv?: string;
  /** Override for tests. */
  tokenStoreGet?: () => Promise<OAuthTokenBundle | null>;
  /** Override for tests. */
  tokenStoreSet?: (bundle: OAuthTokenBundle) => Promise<void>;
  /** Override for tests. */
  tokenStoreClear?: () => Promise<void>;
  /** Override for tests. */
  isExpiredFn?: typeof defaultIsExpired;
  /** Override for tests. Defaults to `runDeviceGrantFlow`. */
  deviceGrantFlow?: typeof runDeviceGrantFlow;
  /** Optional stderr logger; defaults to `process.stderr.write` line-suffixed. */
  log?: (msg: string) => void;
}

export class AuthResolutionError extends Error {
  constructor(
    public readonly code:
      | 'pat_malformed'
      | 'device_grant_failed'
      | 'token_store_failure',
    message: string,
  ) {
    super(message);
    this.name = 'AuthResolutionError';
  }
}

/* v8 ignore next -- trivial stderr wrapper; tests inject a log stub via `opts.log` */
const DEFAULT_LOG = (msg: string) => process.stderr.write(`${msg}\n`);

export async function resolveAuth(
  opts: ResolveAuthOptions,
): Promise<ResolvedAuth> {
  const clientId = opts.clientId ?? 'mcp-stdio';
  const log = opts.log ?? DEFAULT_LOG;
  const tokenStoreGet = opts.tokenStoreGet ?? defaultGetTokens;
  const tokenStoreSet = opts.tokenStoreSet ?? defaultSetTokens;
  const tokenStoreClear = opts.tokenStoreClear ?? defaultClearTokens;
  const isExpiredFn = opts.isExpiredFn ?? defaultIsExpired;
  const deviceGrantFlow = opts.deviceGrantFlow ?? runDeviceGrantFlow;

  // 1. PAT env var — takes precedence; matches pre-OAuth behavior.
  if (opts.patFromEnv) {
    if (!opts.patFromEnv.startsWith(PAT_PREFIX)) {
      throw new AuthResolutionError(
        'pat_malformed',
        `ROCKHOPPER_TOKEN does not look like a valid Personal Access Token. Tokens start with "${PAT_PREFIX}".`,
      );
    }
    return { accessToken: opts.patFromEnv, source: 'pat' };
  }

  // 2. Stored OAuth bundle.
  let stored: OAuthTokenBundle | null = null;
  try {
    stored = await tokenStoreGet();
  } catch (e) {
    // Keychain backend missing or locked. Don't abort yet — fall through
    // to device-grant. If THAT fails too, surface a combined error.
    log(
      `Could not read OS keychain (${e instanceof Error ? e.message : String(e)}). Falling back to device-grant flow.`,
    );
  }

  if (stored && !isExpiredFn(stored)) {
    return { accessToken: stored.accessToken, source: 'stored-oauth' };
  }
  if (stored) {
    // Expired bundle — clear it and proceed.
    try {
      await tokenStoreClear();
    } catch {
      // Non-fatal — overwrite on the upcoming setTokens.
    }
  }

  // 3. Device-grant flow.
  let bundle: DeviceTokenSuccess;
  try {
    bundle = await deviceGrantFlow({
      baseUrl: opts.baseUrl,
      clientId,
    });
  } catch (e) {
    if (e instanceof DeviceGrantError) {
      throw new AuthResolutionError(
        'device_grant_failed',
        `Device-grant flow failed (${e.code}): ${e.message}`,
      );
    }
    throw new AuthResolutionError(
      'device_grant_failed',
      `Device-grant flow failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Persist for next launch. Storage failure is non-fatal — the
  // current token still works, the user just re-runs the flow next
  // time.
  try {
    await tokenStoreSet({
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt: Date.now() + bundle.expiresIn * 1000,
    });
  } catch (e) {
    log(
      `Warning: could not persist OAuth token to OS keychain (${e instanceof Error ? e.message : String(e)}). You may need to re-authenticate on the next launch.`,
    );
  }

  return { accessToken: bundle.accessToken, source: 'device-grant' };
}
