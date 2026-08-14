import { afterEach, describe, expect, it, vi } from 'vitest';

// Phase 1.5 / KI-225 (#78) — the observability additions in cli.ts the
// bootstrap suite doesn't reach:
//   - the `uncaughtException` / `unhandledRejection` crash handlers (cli.ts
//     30-37) — registered but never invoked, so cli.ts shows 0% functions, the
//     biggest single drag on the global function threshold, and
//   - the two terminal error branches in the auth catch: the generic
//     AuthResolutionError message (line 64) plus the non-AuthResolutionError
//     branch (66-69), and the post-catch `!resolved` guard exit (line 78).
//
// Ordering matches cli.bootstrap.test.ts: the test that relies on the REAL
// resolve-auth (PAT path) runs FIRST; the `vi.doMock('../../auth/resolve-auth.js')`
// tests run LAST (doMock registrations can leak past afterEach).

describe('cli observability (#78 / KI-225)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('registers crash handlers: uncaughtException logs fatal + flushes + exits 1; unhandledRejection logs error', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const logMock = {
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const flushLoggerSyncMock = vi.fn();
    vi.doMock('../../logger.js', () => ({
      log: logMock,
      initLogger: vi.fn().mockResolvedValue(undefined),
      flushLoggerSync: flushLoggerSyncMock,
      serviceVersion: '9.9.9',
    }));

    const connectMock = vi.fn().mockResolvedValue(undefined);
    const createServerMock = vi.fn().mockReturnValue({ connect: connectMock });
    const getMeMock = vi.fn().mockResolvedValue({ internalId: 1 });
    const apiClientMock = vi.fn().mockImplementation(function () {
      return {
        getMe: getMeMock,
        setDrivingHuman: vi.fn(),
        // ENG-2208: the CLI registers a one-shot mid-session 401 notice once
        // the preflight has succeeded.
        setAuthExpiredHandler: vi.fn(),
      };
    });
    vi.doMock('../../server.js', () => ({ createServer: createServerMock }));
    vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      StdioServerTransport: vi.fn(),
    }));

    // Capture (don't really register) the process-level handlers cli.ts installs.
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      cb: (...args: unknown[]) => unknown,
    ) => {
      handlers[event] = cb;
      return process;
    }) as never);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await import('../../cli.js');
    onSpy.mockRestore(); // narrow the window in which process.on is stubbed

    expect(typeof handlers.uncaughtException).toBe('function');
    expect(typeof handlers.unhandledRejection).toBe('function');
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(logMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_server_start',
        version: '9.9.9',
      }),
      'mcp_server_start',
    );

    // Drive the uncaughtException handler (cli.ts 30-34).
    handlers.uncaughtException(new Error('boom'));
    expect(logMock.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'uncaught_exception' }),
      'uncaught_exception',
    );
    expect(flushLoggerSyncMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Drive the unhandledRejection handler (cli.ts 35-37) — logs, no exit.
    handlers.unhandledRejection('some-reason');
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unhandled_rejection' }),
      'unhandled_rejection',
    );

    vi.doUnmock('../../logger.js');
    vi.doUnmock('../../server.js');
    vi.doUnmock('../../api-client.js');
    vi.doUnmock('@modelcontextprotocol/server/stdio');
  });

  it('prints the generic message for an AuthResolutionError with an unmapped code, then the !resolved guard re-exits (line 78)', async () => {
    vi.stubEnv('ROCKHOPPER_MCP_LOG_DISABLE', '1');

    class AuthResolutionError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = 'AuthResolutionError';
        this.code = code;
      }
    }
    vi.doMock('../../auth/resolve-auth.js', () => ({
      resolveAuth: vi
        .fn()
        .mockRejectedValue(
          new AuthResolutionError('some_unmapped_code', 'totally novel failure'),
        ),
      AuthResolutionError,
    }));

    // First exit (line 71) is a no-op so control falls through to the
    // `if (!resolved)` guard, whose exit (line 78) throws to end the module.
    let calls = 0;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => {
      calls += 1;
      if (calls >= 2) throw new Error('exit');
      return undefined;
    }) as never));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('totally novel failure'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(calls).toBeGreaterThanOrEqual(2);

    vi.doUnmock('../../auth/resolve-auth.js');
  });

  it('prints a generic error and exits when resolveAuth throws a non-AuthResolutionError', async () => {
    vi.stubEnv('ROCKHOPPER_MCP_LOG_DISABLE', '1');

    vi.doMock('../../auth/resolve-auth.js', () => ({
      resolveAuth: vi.fn().mockRejectedValue(new Error('kaboom unexpected')),
      AuthResolutionError: class AuthResolutionError extends Error {},
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('kaboom unexpected'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    vi.doUnmock('../../auth/resolve-auth.js');
  });
});
