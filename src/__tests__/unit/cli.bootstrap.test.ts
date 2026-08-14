import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cli bootstrap', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should exit when ROCKHOPPER_TOKEN is malformed (ENG-1444)', async () => {
    // Pre-ENG-1444 behavior was "missing ROCKHOPPER_TOKEN → immediate
    // exit". Post-ENG-1444, missing token triggers the device-grant
    // flow (no longer an exit), so this test instead exercises the
    // adjacent "malformed PAT" failure mode: ROCKHOPPER_TOKEN set but
    // not starting with `rh_pat_` → resolveAuth throws
    // AuthResolutionError(pat_malformed) → cli.ts catches and exits.
    // Uses a real failure mode rather than mocking resolveAuth to
    // avoid vi.doMock module-registry pollution into sibling tests.
    vi.stubEnv('ROCKHOPPER_TOKEN', 'not-a-valid-pat-token');

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('exit');
      }) as never);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should construct client/server and connect transport when token is valid', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const connectMock = vi.fn().mockResolvedValue(undefined);
    const createServerMock = vi.fn().mockReturnValue({ connect: connectMock });
    const getMeMock = vi
      .fn()
      .mockResolvedValue({ internalId: 1, msId: 'ms-oid-1' });
    // ENG-1756: the CLI declares the PAT owner as the driving human off the
    // getMe preflight.
    const setDrivingHumanMock = vi.fn();
    // vitest 4 invokes a mock's implementation with `new` when used as a
    // constructor; an arrow fn can't be constructed, so use a function expr.
    const apiClientMock = vi
      .fn()
      .mockImplementation(function () {
        return {
          getMe: getMeMock,
          setDrivingHuman: setDrivingHumanMock,
          setAuthExpiredHandler: vi.fn(),
        };
      });
    const transportMock = vi.fn();

    vi.doMock('../../server.js', () => ({
      createServer: createServerMock,
    }));
    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      StdioServerTransport: transportMock,
    }));

    await import('../../cli.js');

    expect(getMeMock).toHaveBeenCalledTimes(1);
    expect(setDrivingHumanMock).toHaveBeenCalledWith('ms-oid-1');
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  // ENG-2208: the preflight already runs, and post-ENG-2205 it carries
  // `patScope`. Before this, `createServer(apiClient)` took one argument, so
  // every stdio launch registered all nine write tools whatever the token was
  // scoped to.
  it.each([
    ['read-write', 'read-write'],
    ['read-only', 'read-only'],
    // An unrecognised value is forwarded verbatim; the allow-list in
    // `tools/index.ts` is the one place that decides what it grants.
    ['some-future-scope', 'some-future-scope'],
    // An older backend that does not serve the field yields `undefined`,
    // which the allow-list denies.
    [undefined, undefined],
  ])(
    'passes the preflight scope %s through to createServer',
    async (patScope, expected) => {
      vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
      vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

      const connectMock = vi.fn().mockResolvedValue(undefined);
      const createServerMock = vi
        .fn()
        .mockReturnValue({ connect: connectMock });
      const getMeMock = vi
        .fn()
        .mockResolvedValue({ internalId: 1, msId: 'ms-oid-1', patScope });
      const apiClientMock = vi.fn().mockImplementation(function () {
        return {
          getMe: getMeMock,
          setDrivingHuman: vi.fn(),
          setAuthExpiredHandler: vi.fn(),
        };
      });

      vi.doMock('../../server.js', () => ({ createServer: createServerMock }));
      vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
      vi.doMock('@modelcontextprotocol/server/stdio', () => ({
        StdioServerTransport: vi.fn(),
      }));

      await import('../../cli.js');

      expect(createServerMock).toHaveBeenCalledWith(expect.anything(), {
        scope: expected,
      });
    },
  );

  // ENG-2208: a token that expires mid-session is silent today — the 401 is
  // rendered into tool text for the model, and the human watching the client
  // sees only a tool that stopped working.
  it('prints one stderr line on the first 401 after a successful start', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const setAuthExpiredHandlerMock = vi.fn();
    const apiClientMock = vi.fn().mockImplementation(function () {
      return {
        getMe: vi.fn().mockResolvedValue({ internalId: 1 }),
        setDrivingHuman: vi.fn(),
        setAuthExpiredHandler: setAuthExpiredHandlerMock,
      };
    });

    vi.doMock('../../server.js', () => ({
      createServer: vi.fn().mockReturnValue({ connect: vi.fn() }),
    }));
    vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      StdioServerTransport: vi.fn(),
    }));

    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await import('../../cli.js');

    // Registered AFTER the preflight succeeded, so a preflight rejection
    // (which exits with its own message) can never reach it.
    expect(setAuthExpiredHandlerMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();

    const handler = setAuthExpiredHandlerMock.mock.calls[0][0] as () => void;
    handler();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
  });

  it('should exit when token is invalid or expired (401/403)', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_expired');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const getMeMock = vi.fn().mockRejectedValue(
      new Error('Rockhopper API 401: Unauthorized — Invalid or expired token'),
    );
    // vitest 4 invokes a mock's implementation with `new` when used as a
    // constructor; an arrow fn can't be constructed, so use a function expr.
    const apiClientMock = vi
      .fn()
      .mockImplementation(function () {
        return { getMe: getMeMock };
      });

    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('../../server.js', () => ({
      createServer: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      StdioServerTransport: vi.fn(),
    }));

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('exit');
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid or expired'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should exit when API is unreachable', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:9999');

    const getMeMock = vi.fn().mockRejectedValue(
      new Error('fetch failed: ECONNREFUSED'),
    );
    // vitest 4 invokes a mock's implementation with `new` when used as a
    // constructor; an arrow fn can't be constructed, so use a function expr.
    const apiClientMock = vi
      .fn()
      .mockImplementation(function () {
        return { getMe: getMeMock };
      });

    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('../../server.js', () => ({
      createServer: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      StdioServerTransport: vi.fn(),
    }));

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('exit');
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach Rockhopper API'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // The two tests below mock `resolve-auth.js` and are placed LAST in
  // the file because vi.doMock registrations leak past afterEach (see
  // memory project_vitest_doMock_pollutes_siblings). Earlier tests rely
  // on the REAL resolve-auth taking the PAT path on ROCKHOPPER_TOKEN
  // env — any vi.doMock here would break them if it ran first.

  it('should print device_grant_failed message and exit when OAuth flow fails (ENG-1444)', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', '');

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
          new AuthResolutionError(
            'device_grant_failed',
            'Device-grant flow failed (network_error): backend unreachable',
          ),
        ),
      AuthResolutionError,
    }));

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('exit');
      }) as never);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not complete sign-in'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should print OAuth-source remediation on 401 when token came from stored OAuth (ENG-1444)', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', '');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    vi.doMock('../../auth/resolve-auth.js', () => ({
      resolveAuth: vi.fn().mockResolvedValue({
        accessToken: 'rh_pat_from_oauth_flow',
        source: 'stored-oauth',
      }),
      AuthResolutionError: class extends Error {},
    }));

    const getMeMock = vi.fn().mockRejectedValue(
      new Error('Rockhopper API 401: Unauthorized — Invalid or expired token'),
    );
    const apiClientMock = vi
      .fn()
      .mockImplementation(function () {
        return { getMe: getMeMock };
      });

    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('../../server.js', () => ({
      createServer: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      StdioServerTransport: vi.fn(),
    }));

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('exit');
      }) as never);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stored OAuth token is invalid'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
