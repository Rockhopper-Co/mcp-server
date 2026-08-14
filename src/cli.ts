#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ApiClient } from './api-client.js';
import {
  AuthResolutionError,
  resolveAuth,
  type ResolvedAuth,
} from './auth/resolve-auth.js';
import {
  flushLoggerSync,
  initLogger,
  log,
  serviceVersion,
} from './logger.js';
import { createServer } from './server.js';

const ROCKHOPPER_API_URL =
  process.env.ROCKHOPPER_API_URL || 'https://api.rockhopper.co';

// KI-225: start the local rotating diagnostic logfile before anything else,
// so startup-path failures (auth, preflight, crashes) are captured. Never
// throws and never writes to stdout — falls back to a no-op logger.
await initLogger();

// Capture client-side crashes that would otherwise vanish (the backend can't
// see them). Registering these handlers suppresses Node's default crash, so
// uncaughtException re-exits 1 to PRESERVE the existing exit behavior; the
// fatal line is flushed to disk synchronously first.
process.on('uncaughtException', (err) => {
  log.fatal({ event: 'uncaught_exception', err }, 'uncaught_exception');
  flushLoggerSync();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error({ event: 'unhandled_rejection', err: reason }, 'unhandled_rejection');
});

// ENG-1444: auth resolution order is
//   1. ROCKHOPPER_TOKEN env var (Personal Access Token — headless / CI)
//   2. Stored OAuth bundle in the OS keychain (prior device-grant flow)
//   3. Device-grant flow (prints code to stderr, polls for approval)
let resolved: ResolvedAuth | undefined;
try {
  resolved = await resolveAuth({
    baseUrl: ROCKHOPPER_API_URL,
    patFromEnv: process.env.ROCKHOPPER_TOKEN,
  });
} catch (err) {
  if (err instanceof AuthResolutionError) {
    // KI-225: local auth failure before any API call (bad token / sign-in).
    log.warn({ event: 'auth_failed', reason: err.code }, 'auth_failed');
    if (err.code === 'pat_malformed') {
      console.error(`Error: ${err.message}`);
      console.error(
        'Tokens start with "rh_pat_". Check that the full token was copied correctly.',
      );
    } else if (err.code === 'device_grant_failed') {
      console.error(`Error: Could not complete sign-in.\n${err.message}`);
      console.error(
        'You can also set ROCKHOPPER_TOKEN to a Personal Access Token (Settings → Personal Access Tokens) and re-launch.',
      );
    } else {
      console.error(`Error: ${err.message}`);
    }
  } else {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.exit(1);
}

// Every catch branch above ends in `process.exit(1)`, so `resolved` is always
// assigned past this point. TS 6.0's stricter control-flow analysis can't prove
// that across the implicit-typed `let`, so narrow it explicitly here.
if (!resolved) {
  process.exit(1);
}

const apiClient = new ApiClient({
  baseUrl: ROCKHOPPER_API_URL,
  token: resolved.accessToken,
});

// ENG-2208: the scope the token reports about ITSELF (ENG-2205 put it on the
// preflight response). Left undefined by a backend older than that, and by any
// non-PAT principal — both of which the allow-list in `tools/index.ts` denies.
let patScope: string | undefined;
// ENG-2212: the write families the token actually holds. Absent against a
// backend older than ENG-2211, which is why `patScope` is still read — absent
// means "the backend said nothing", and the coarse scope decides.
let patCapabilities: string[] | undefined;

try {
  const me = await apiClient.getMe();
  patScope = me?.patScope;
  patCapabilities = me?.patScopes;
  // ENG-1756 (plan §9 decision 15): the PAT owner IS the human driving this
  // local agent — reuse the preflight to declare them, so every write carries
  // `X-Driving-Human` and the backend's anonymous-agent-write admission
  // never fires for this client. Best-effort: while unset, the backend
  // resolves the PAT owner server-side (same human).
  apiClient.setDrivingHuman(me?.msId ?? me?.googleId ?? null);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('401') || msg.includes('403')) {
    // KI-225: preflight token rejection — the local auth-fail signal.
    log.warn(
      {
        event: 'auth_failed',
        reason: resolved.source === 'pat' ? 'pat_invalid' : 'oauth_invalid',
      },
      'auth_failed',
    );
    if (resolved.source === 'pat') {
      console.error(
        'Error: ROCKHOPPER_TOKEN is invalid or expired.\n' +
          'Create a new Personal Access Token in Rockhopper Settings and set it as ROCKHOPPER_TOKEN.',
      );
    } else {
      console.error(
        `Error: Stored OAuth token is invalid (source: ${resolved.source}).\n` +
          'Re-launch the MCP server — it will run the device-grant flow again.',
      );
    }
  } else {
    console.error(
      `Error: Could not reach Rockhopper API at ${ROCKHOPPER_API_URL}.\n` +
        `Details: ${msg}`,
    );
  }
  process.exit(1);
}

// ENG-2208: the preflight succeeded, so from here a 401 means the token died
// mid-session. Report it once on stderr — the only channel a stdio server has
// to the human — instead of leaving it as an error string inside a tool result
// that only the model ever reads.
apiClient.setAuthExpiredHandler(() => {
  log.warn({ event: 'auth_failed', reason: 'expired_mid_session' }, 'auth_failed');
  console.error(
    'Error: Rockhopper rejected the token (401) — it expired or was revoked after this server started. ' +
      'Create a new Personal Access Token in Rockhopper Settings and restart this MCP server.',
  );
});

// ENG-2208: register only what this token may do. `createServer(apiClient)` —
// one argument — used to register all nine write tools for every launch, so a
// read-only token advertised writes it could not perform and the customer's
// scope choice surfaced as a 403 rendered into tool text.
//
// ENG-2176: a FACTORY now, not one instance. `serveStdio` owns the era
// decision for the connection and calls this per connection — plus once more
// for a `server/discover` probe it discards if the client falls back to
// `initialize`. Each call must therefore hand back a fresh server.
//
// ENG-2212: the FAMILIES ride along. When the backend serves them they decide
// which registrars run, one per family, so a token granted `comments:write`
// alone no longer receives `discard_changes`.
const buildServer = () =>
  createServer(apiClient, { scope: patScope, capabilities: patCapabilities });

// KI-225: one line per launch — anchors a session in the file.
log.info(
  {
    event: 'mcp_server_start',
    version: serviceVersion,
    scope: patScope ?? 'unknown',
    capabilities: patCapabilities ?? 'unknown',
  },
  'mcp_server_start',
);

// ENG-2176: `serveStdio`, not `new StdioServerTransport()` + `connect`. The
// modern (2026-07-28) handlers — `server/discover`, and adding `2026-07-28`
// to the instance's supported-versions list — are installed by the SERVING
// ENTRY, never by the server object: the SDK's default
// `SUPPORTED_PROTOCOL_VERSIONS` names only 2025-era revisions, so a
// hand-connected server answers `server/discover` with `-32601` forever.
// `legacy: 'serve'` (the default) keeps a 2025-era client working unchanged —
// it pins the connection to a 2025 instance from this same factory.
serveStdio(buildServer, {
  onerror: (err) => {
    log.error({ event: 'stdio_serving_error', err }, 'stdio_serving_error');
  },
});
