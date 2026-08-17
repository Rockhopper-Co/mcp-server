import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runWithCorrelationId } from '../correlation.js';
import {
  createDiagnosticLogger,
  flushLoggerSync,
  initLogger,
  log,
  serviceVersion,
} from '../logger.js';

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-logger-'));
  tmpDirs.push(dir);
  return dir;
}

/** Reads every rotated `mcp-server.*.log` line in `dir` as parsed JSON. */
function readLogLines(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => /^mcp-server\..*log$/.test(n))) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A line still mid-write — skip; the poll loop retries.
      }
    }
  }
  return out;
}

/** Polls until `predicate` is satisfied (writes are async) or the deadline. */
async function waitForLines(
  dir: string,
  predicate: (lines: Record<string, unknown>[]) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  let lines = readLogLines(dir);
  while (!predicate(lines) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
    lines = readLogLines(dir);
  }
  return lines;
}

const byEvent =
  (event: string) => (lines: Record<string, unknown>[]) =>
    lines.some((l) => l.event === event);

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('createDiagnosticLogger', () => {
  it('writes structured JSON lines to a rotating file (never stdout)', async () => {
    const dir = mkTmp();
    const { logger } = await createDiagnosticLogger({ dir });

    logger.info(
      { event: 'api_request', method: 'GET', path: '/enrolled-files', status: 200, durationMs: 12 },
      'api_request',
    );

    const lines = await waitForLines(dir, byEvent('api_request'));
    const entry = lines.find((l) => l.event === 'api_request');
    expect(entry).toMatchObject({
      event: 'api_request',
      method: 'GET',
      path: '/enrolled-files',
      status: 200,
      durationMs: 12,
      service: 'mcp-server',
    });
    expect(entry?.version).toBe(serviceVersion);
    // Sanity: the file actually exists on disk.
    expect(fs.readdirSync(dir).some((n) => /^mcp-server\..*log$/.test(n))).toBe(true);
  });

  it('stamps the active correlationId on each line via the ALS mixin', async () => {
    const dir = mkTmp();
    const { logger } = await createDiagnosticLogger({ dir });

    runWithCorrelationId(() => {
      logger.info({ event: 'tool_call', tool: 'list_files' }, 'tool_call');
    }, 'fixed-correlation-id');

    const lines = await waitForLines(dir, byEvent('tool_call'));
    expect(lines.find((l) => l.event === 'tool_call')?.correlationId).toBe(
      'fixed-correlation-id',
    );
  });

  it('omits correlationId when no scope is active', async () => {
    const dir = mkTmp();
    const { logger } = await createDiagnosticLogger({ dir });

    logger.info({ event: 'mcp_server_start' }, 'mcp_server_start');

    const lines = await waitForLines(dir, byEvent('mcp_server_start'));
    const entry = lines.find((l) => l.event === 'mcp_server_start');
    expect(entry).toBeDefined();
    expect(entry?.correlationId).toBeUndefined();
  });

  it('never writes a token / Authorization value to the file', async () => {
    const dir = mkTmp();
    const { logger } = await createDiagnosticLogger({ dir });
    const token = 'rh_pat_supersecret_DO_NOT_LOG';

    // Mirror the api-client call sites — only safe fields are ever passed.
    logger.info(
      { event: 'api_request', method: 'GET', path: '/enrolled-files', status: 200, durationMs: 5 },
      'api_request',
    );
    logger.error(
      { event: 'api_unreachable', method: 'GET', path: '/users/me', durationMs: 3, err: new Error('fetch failed') },
      'api_unreachable',
    );

    // Wait until both lines are flushed, then scan the raw bytes.
    await waitForLines(
      dir,
      (lines) => byEvent('api_request')(lines) && byEvent('api_unreachable')(lines),
    );
    const raw = fs
      .readdirSync(dir)
      .filter((n) => /^mcp-server\..*log$/.test(n))
      .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
      .join('');
    expect(raw).not.toContain(token);
    expect(raw.toLowerCase()).not.toContain('authorization');
    expect(raw).not.toContain('Bearer ');
  });

  it('honors a valid level and falls back to info for an invalid one', async () => {
    const invalidDir = mkTmp();
    const { logger: l1 } = await createDiagnosticLogger({ dir: invalidDir, level: 'not-a-level' });
    l1.info({ event: 'kept' }, 'kept');
    l1.debug({ event: 'dropped' }, 'dropped'); // below fallback 'info'
    const lines1 = await waitForLines(invalidDir, byEvent('kept'));
    expect(lines1.find((l) => l.event === 'kept')).toBeDefined();
    expect(lines1.find((l) => l.event === 'dropped')).toBeUndefined();

    const debugDir = mkTmp();
    const { logger: l2 } = await createDiagnosticLogger({ dir: debugDir, level: 'debug' });
    l2.debug({ event: 'debug_line' }, 'debug_line');
    const lines2 = await waitForLines(debugDir, byEvent('debug_line'));
    expect(lines2.find((l) => l.event === 'debug_line')).toBeDefined();
  });

  it('disabled via opts is a no-op and creates no file', async () => {
    const dir = mkTmp();
    const { logger } = await createDiagnosticLogger({ dir, disable: true });

    logger.debug({ a: 1 }, 'x');
    logger.info({ a: 1 }, 'x');
    logger.warn({ a: 1 }, 'x');
    logger.error({ a: 1 }, 'x');
    logger.fatal({ a: 1 }, 'x');

    expect(fs.readdirSync(dir).filter((n) => /mcp-server/.test(n))).toHaveLength(0);
  });

  // ENG-2597: the disabled branch returns its own no-op flush, and nothing
  // ever called it — one of four uncovered functions in the package. Shutdown
  // awaits this promise, so a flush that never resolved would hang the
  // process on exit for any user who set ROCKHOPPER_MCP_LOG_DISABLE.
  it('disabled flush() resolves rather than hanging shutdown', async () => {
    const dir = mkTmp();
    const { flush } = await createDiagnosticLogger({ dir, disable: true });
    await expect(flush()).resolves.toBeUndefined();
  });

  it('disabled via ROCKHOPPER_MCP_LOG_DISABLE env is a no-op', async () => {
    const dir = mkTmp();
    const prev = process.env.ROCKHOPPER_MCP_LOG_DISABLE;
    process.env.ROCKHOPPER_MCP_LOG_DISABLE = '1';
    try {
      const { logger } = await createDiagnosticLogger({ dir });
      logger.info({ event: 'x' }, 'x');
      expect(fs.readdirSync(dir).filter((n) => /mcp-server/.test(n))).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ROCKHOPPER_MCP_LOG_DISABLE;
      else process.env.ROCKHOPPER_MCP_LOG_DISABLE = prev;
    }
  });

  it('swallows a destination error event without crashing', async () => {
    const dir = mkTmp();
    const { destination } = await createDiagnosticLogger({ dir });
    expect(destination).toBeDefined();
    expect(() => destination?.emit('error', new Error('disk full'))).not.toThrow();
  });
});

describe('initLogger singleton', () => {
  it('wires the singleton + flushLoggerSync persists to the env dir', async () => {
    const dir = mkTmp();
    const prev = process.env.ROCKHOPPER_MCP_LOG_DIR;
    process.env.ROCKHOPPER_MCP_LOG_DIR = dir;
    try {
      await initLogger();
      await initLogger(); // idempotent — second call must not re-init or throw

      log.info({ event: 'mcp_server_start', version: serviceVersion }, 'mcp_server_start');
      flushLoggerSync();

      const lines = await waitForLines(dir, byEvent('mcp_server_start'));
      const entry = lines.find((l) => l.event === 'mcp_server_start');
      expect(entry).toBeDefined();
      expect(entry?.service).toBe('mcp-server');
      expect(entry?.version).toBe(serviceVersion);
    } finally {
      if (prev === undefined) delete process.env.ROCKHOPPER_MCP_LOG_DIR;
      else process.env.ROCKHOPPER_MCP_LOG_DIR = prev;
    }
  });
});
