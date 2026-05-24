/**
 * ENG-1444 / KI-081 — RFC 8628 device-grant client.
 *
 * Talks to the backend's `POST /auth/device/{code,token}` endpoints
 * (introduced in ENG-1384 PR 1, `Rockhopper-Co/backend#473`). Used by
 * the mcp-server CLI when no PAT env var is set and no OAuth bundle
 * is stored in the OS keychain.
 *
 * Surfaces a single entrypoint, `runDeviceGrantFlow`, that:
 *
 *   1. Calls `/auth/device/code` to get a (deviceCode, userCode) pair.
 *   2. Emits the user-facing `userCode` + verification URI to stderr
 *      (LLM clients pick this up via stdout's stderr passthrough).
 *   3. Polls `/auth/device/token` at the server-specified interval,
 *      respecting RFC 8628 § 3.5 `slow_down` (bumps interval +5s) and
 *      `authorization_pending` (continues polling).
 *   4. Resolves with the access-token bundle on success, rejects on
 *      `access_denied` / `expired_token` / network failure.
 *
 * No external HTTP dependency — uses globalThis.fetch (Node 18+).
 * `fetchImpl` + `sleep` + `onUserCode` are injectable for tests.
 */

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken?: string;
}

export interface DeviceGrantFlowOptions {
  baseUrl: string;
  clientId: string;
  /** Override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once with the user code + verification URI. Defaults to stderr. */
  onUserCode?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
  }) => void;
}

export class DeviceGrantError extends Error {
  constructor(
    public readonly code:
      | 'access_denied'
      | 'expired_token'
      | 'network_error'
      | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceGrantError';
  }
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEFAULT_ON_USER_CODE = (info: {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}) => {
  process.stderr.write(
    '\nRockhopper — sign in to authorize this MCP client.\n' +
      `Open: ${info.verificationUriComplete}\n` +
      `(or visit ${info.verificationUri} and enter code: ${info.userCode})\n\n`,
  );
};

/**
 * Issue a fresh device code + user code pair.
 */
export async function requestDeviceCode(
  opts: Pick<DeviceGrantFlowOptions, 'baseUrl' | 'clientId' | 'fetchImpl'>,
): Promise<DeviceCodeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/auth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: opts.clientId }),
    });
  } catch (e) {
    throw new DeviceGrantError(
      'network_error',
      `Failed to reach ${opts.baseUrl}/auth/device/code: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    throw new DeviceGrantError(
      'unknown',
      `Device-code request failed with HTTP ${res.status}`,
    );
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Internal: one polling round-trip. Returns the token bundle on
 * success, or a sentinel describing why the server isn't ready yet.
 */
export async function pollOnce(
  opts: Pick<DeviceGrantFlowOptions, 'baseUrl' | 'clientId' | 'fetchImpl'>,
  deviceCode: string,
): Promise<
  | { kind: 'success'; bundle: DeviceTokenSuccess }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode, clientId: opts.clientId }),
    });
  } catch (e) {
    throw new DeviceGrantError(
      'network_error',
      `Failed to reach ${opts.baseUrl}/auth/device/token: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.ok) {
    return {
      kind: 'success',
      bundle: (await res.json()) as DeviceTokenSuccess,
    };
  }

  // RFC 8628 error mapping. Body shape is `{ error, error_description }`
  // per the backend (Rockhopper's exception filter unwraps it — see
  // memory `project_backend_badrequest_unwraps_payload`).
  let body: { error?: string; error_description?: string } = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body — fall through to 'unknown'.
  }

  switch (body.error) {
    case 'authorization_pending':
      return { kind: 'pending' };
    case 'slow_down':
      return { kind: 'slow_down' };
    case 'access_denied':
      throw new DeviceGrantError(
        'access_denied',
        body.error_description ?? 'Device code denied.',
      );
    case 'expired_token':
      throw new DeviceGrantError(
        'expired_token',
        body.error_description ?? 'Device code expired before approval.',
      );
    default:
      throw new DeviceGrantError(
        'unknown',
        `Unexpected device-grant error (HTTP ${res.status}): ${body.error ?? 'no error code'}`,
      );
  }
}

/**
 * Full flow — request code, print to stderr, poll until success or
 * fatal error. Returns the access-token bundle on success.
 *
 * `interval` (seconds, server-supplied) becomes the poll cadence.
 * `slow_down` responses bump the interval by RFC's recommended +5s.
 * Total wall time is bounded by the server-supplied `expiresIn`.
 */
export async function runDeviceGrantFlow(
  opts: DeviceGrantFlowOptions,
): Promise<DeviceTokenSuccess> {
  const sleep = opts.sleep ?? DEFAULT_SLEEP;
  const onUserCode = opts.onUserCode ?? DEFAULT_ON_USER_CODE;

  const code = await requestDeviceCode(opts);
  onUserCode({
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    verificationUriComplete: code.verificationUriComplete,
  });

  let intervalMs = code.interval * 1000;
  const deadline = Date.now() + code.expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await pollOnce(opts, code.deviceCode);

    if (result.kind === 'success') {
      return result.bundle;
    }
    if (result.kind === 'slow_down') {
      // RFC 8628 § 3.5 — increase interval by 5s and retry.
      intervalMs += 5_000;
    }
    // 'pending' just continues at the current interval.
  }

  throw new DeviceGrantError(
    'expired_token',
    `Device code expired (waited ${code.expiresIn}s without approval).`,
  );
}
