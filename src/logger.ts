/**
 * Phase 1.5 / KI-225 — local, rotating diagnostic logfile.
 *
 * Why this exists: the backend already logs everything that *reaches* the
 * API. The unique value of a client-side log is the failures that NEVER
 * reach the backend (network-unreachable, local auth rejection, schema
 * drift, uncaught crashes) plus a local request-latency view. The file is
 * the customer's to keep and hand to support — there is NO remote
 * transmission.
 *
 * 🚨 HARD CONSTRAINT — stdout is the MCP stdio transport. Logs MUST go to
 * the FILE ONLY, never stdout. We therefore:
 *   - build pino against a {@link pino-roll} Sonic-boom file destination
 *     (NOT pino's default stdout destination, NOT a worker transport), and
 *   - fall back to a NO-OP logger on ANY construction failure — never
 *     crash the server, never write to stdout.
 *
 * Redaction (SOC2-adjacent, runs on customer machines): callers must only
 * ever pass safe fields — event, method, URL pathname (no query/token),
 * status, durationMs, tool name, correlationId, version, error
 * type/message. Never tokens, Authorization headers, request/response
 * bodies, tool arguments, file contents, or cell data.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import pinoRoll from 'pino-roll';
import { getCorrelationId } from './correlation.js';

/** The 5 log methods we expose. A real `pino.Logger` satisfies this. */
export interface DiagnosticLogger {
  debug: pino.LogFn;
  info: pino.LogFn;
  warn: pino.LogFn;
  error: pino.LogFn;
  fatal: pino.LogFn;
}

const SERVICE_NAME = 'mcp-server';
const LOG_FILE_BASENAME = 'mcp-server.log';
const LOG_MAX_SIZE = '5m';
const LOG_FILE_COUNT = 5;
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.rockhopper', 'mcp-server');
const VALID_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/** Package version stamped into every line's `base`. Best-effort read. */
const requireJson = createRequire(import.meta.url);
let resolvedVersion = '0.0.0';
try {
  const pkg = requireJson('../package.json') as { version?: string };
  if (pkg.version) resolvedVersion = pkg.version;
} catch {
  // package.json unreadable — keep the sentinel; never crash over a version.
}
export const serviceVersion = resolvedVersion;

/** Shared no-op so disabled/failed logging is a single cheap call site. */
const noopFn = () => {};
const noopLogger: DiagnosticLogger = {
  debug: noopFn,
  info: noopFn,
  warn: noopFn,
  error: noopFn,
  fatal: noopFn,
} as DiagnosticLogger;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

function normalizeLevel(level: string | undefined): string {
  const v = level?.trim().toLowerCase();
  return v && VALID_LEVELS.has(v) ? v : 'info';
}

/**
 * Builds a file-only diagnostic logger. NEVER throws and NEVER writes to
 * stdout — on opt-out or any failure it returns a no-op logger. Exposed
 * (vs. only the {@link log} singleton) so tests can drive an isolated
 * instance pointed at a tmpdir.
 */
export async function createDiagnosticLogger(
  opts: { dir?: string; disable?: boolean; level?: string } = {},
): Promise<{
  logger: DiagnosticLogger;
  flush: () => Promise<void>;
  destination?: Awaited<ReturnType<typeof pinoRoll>>;
}> {
  const disable =
    opts.disable ?? isTruthyEnv(process.env.ROCKHOPPER_MCP_LOG_DISABLE);
  if (disable) {
    return { logger: noopLogger, flush: async () => {} };
  }

  try {
    const envDir = process.env.ROCKHOPPER_MCP_LOG_DIR?.trim();
    const dir = opts.dir ?? (envDir && envDir.length ? envDir : DEFAULT_LOG_DIR);
    fs.mkdirSync(dir, { recursive: true });

    const destination = await pinoRoll({
      file: path.join(dir, LOG_FILE_BASENAME),
      size: LOG_MAX_SIZE,
      limit: { count: LOG_FILE_COUNT },
      mkdir: true,
    });
    // A logging IO error must never crash the server (or escape as an
    // unhandled 'error' event). Swallow it — diagnostics are best-effort.
    destination.on('error', () => {});

    const logger = pino(
      {
        level: normalizeLevel(opts.level ?? process.env.ROCKHOPPER_MCP_LOG_LEVEL),
        base: { service: SERVICE_NAME, version: serviceVersion },
        serializers: { err: pino.stdSerializers.err },
        // Every line auto-carries the per-tool-call correlationId (Phase 1.1
        // ALS scope) when one is active — no call site has to thread it.
        mixin() {
          const id = getCorrelationId();
          return id ? { correlationId: id } : {};
        },
      },
      destination,
    );

    const flush = (): Promise<void> =>
      new Promise((resolve) => {
        try {
          destination.flush(() => resolve());
        } catch {
          resolve();
        }
      });

    return { logger, flush, destination };
  } catch {
    // fs / pino-roll / pino failure — degrade to no-op, never to stdout.
    return { logger: noopLogger, flush: async () => {} };
  }
}

/**
 * Process-wide singleton. Starts as a no-op (so importing this module —
 * including from the library entry / mcp-gateway — has no side effect and
 * opens no file) and is swapped to the real file logger by
 * {@link initLogger}, which the stdio CLI calls at startup.
 */
export let log: DiagnosticLogger = noopLogger;

let activeDestination: Awaited<ReturnType<typeof pinoRoll>> | undefined;
let initPromise: Promise<void> | undefined;

/** Idempotently constructs the singleton from env config. Never rejects. */
export async function initLogger(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const built = await createDiagnosticLogger();
    log = built.logger;
    activeDestination = built.destination;
  })();
  return initPromise;
}

/**
 * Best-effort synchronous flush — for the crash path, where the last
 * `fatal` line must hit disk before {@link process.exit}. No-op when the
 * logger is disabled / not yet ready.
 */
export function flushLoggerSync(): void {
  try {
    activeDestination?.flushSync();
  } catch {
    // Stream not ready or already closed — nothing more we can do pre-exit.
  }
}
