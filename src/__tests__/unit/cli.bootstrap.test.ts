import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cli bootstrap', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // ENG-4222 — `vi.resetModules()` clears the module CACHE but leaves
    // `vi.doMock` registrations standing, so a test that stubs auth resolution
    // silently re-answers it for every sibling that imports the CLI
    // afterwards. Unmocked here rather than at the end of the mocking test: a
    // failure there would skip the cleanup and the leak would surface as an
    // unrelated test failing further down the file.
    vi.doUnmock('../../auth/resolve-auth.js');
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

  it('should construct client/server and start serving when token is valid', async () => {
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
    const serveStdioMock = vi.fn().mockReturnValue({ close: vi.fn() });

    vi.doMock('../../server.js', () => ({
      createServer: createServerMock,
    }));
    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      serveStdio: serveStdioMock,
    }));

    await import('../../cli.js');

    expect(getMeMock).toHaveBeenCalledTimes(1);
    expect(setDrivingHumanMock).toHaveBeenCalledWith('ms-oid-1');
    expect(serveStdioMock).toHaveBeenCalledTimes(1);
    // ENG-2176: the server is built by the factory the entry holds, so it is
    // constructed on demand rather than eagerly at bootstrap.
    expect(createServerMock).not.toHaveBeenCalled();
    (serveStdioMock.mock.calls[0][0] as () => unknown)();
    expect(createServerMock).toHaveBeenCalledTimes(1);
    // The entry owns connecting; the CLI never does it itself.
    expect(connectMock).not.toHaveBeenCalled();
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

      const serveStdioMock = vi.fn().mockReturnValue({ close: vi.fn() });
      vi.doMock('../../server.js', () => ({ createServer: createServerMock }));
      vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
      vi.doMock('@modelcontextprotocol/server/stdio', () => ({
        serveStdio: serveStdioMock,
      }));

      await import('../../cli.js');

      // ENG-2176: the scope is now captured by the factory the serving entry
      // holds, so build one server the way the entry would.
      (serveStdioMock.mock.calls[0][0] as () => unknown)();
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
      serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
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

  /**
   * ENG-4222 — THE MID-SESSION 401 MUST NAME THE CREDENTIAL THE USER HOLDS.
   *
   * The handler above branched on nothing and told everybody to "Create a new
   * Personal Access Token in Rockhopper Settings". A user who set the server
   * up the way the README recommends never created one — they signed in
   * through a browser, and the device grant's token is minted with a 60-minute
   * life and has no refresh endpoint, so ANY session outliving an hour reaches
   * this message by design. It sent them to mint a credential they do not need
   * instead of restarting to re-approve.
   *
   * Asserting on the EMITTED STRING per source, not on "something was written
   * to stderr" — the assertion twenty lines up is exactly that weaker shape and
   * passes against the broken code. The negative assertion is the load-bearing
   * one: a device-grant user must not be pointed at a Personal Access Token.
   */
  it.each([
    ['device-grant', 'device-grant'],
    ['stored-oauth', 'stored-oauth'],
  ])(
    'tells a %s user to restart and re-approve, never to mint a token',
    async (_label, source) => {
      vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');
      vi.stubEnv('ROCKHOPPER_TOKEN', '');

      const setAuthExpiredHandlerMock = vi.fn();
      vi.doMock('../../auth/resolve-auth.js', () => ({
        resolveAuth: vi
          .fn()
          .mockResolvedValue({ accessToken: 'oauth-access-token', source }),
        AuthResolutionError: class extends Error {},
      }));
      vi.doMock('../../api-client.js', () => ({
        ApiClient: vi.fn().mockImplementation(function () {
          return {
            getMe: vi.fn().mockResolvedValue({ internalId: 1 }),
            setDrivingHuman: vi.fn(),
            setAuthExpiredHandler: setAuthExpiredHandlerMock,
          };
        }),
      }));
      vi.doMock('../../server.js', () => ({
        createServer: vi.fn().mockReturnValue({ connect: vi.fn() }),
      }));
      vi.doMock('@modelcontextprotocol/server/stdio', () => ({
        serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
      }));

      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await import('../../cli.js');
      const handler = setAuthExpiredHandlerMock.mock.calls[0][0] as () => void;
      handler();

      const message = errorSpy.mock.calls[0][0] as string;
      expect(message).toContain('401');
      expect(message).not.toContain('Personal Access Token');
      expect(message).toMatch(/restart|re-launch/i);
    },
  );

  // The PAT message is CORRECT today and must survive the branch above. A
  // change that fixes the device-grant wording by making every message generic
  // would pass the assertions above and quietly lose the one instruction that
  // was already right.
  it('still tells a PAT user to mint a new token on a mid-session 401', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const setAuthExpiredHandlerMock = vi.fn();
    vi.doMock('../../api-client.js', () => ({
      ApiClient: vi.fn().mockImplementation(function () {
        return {
          getMe: vi.fn().mockResolvedValue({ internalId: 1 }),
          setDrivingHuman: vi.fn(),
          setAuthExpiredHandler: setAuthExpiredHandlerMock,
        };
      }),
    }));
    vi.doMock('../../server.js', () => ({
      createServer: vi.fn().mockReturnValue({ connect: vi.fn() }),
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
    }));

    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await import('../../cli.js');
    const handler = setAuthExpiredHandlerMock.mock.calls[0][0] as () => void;
    handler();

    const message = errorSpy.mock.calls[0][0] as string;
    expect(message).toContain('401');
    expect(message).toContain('Personal Access Token');
  });

  /**
   * ENG-1756 — the driving human is read off the preflight with a THREE-arm
   * fallback and only the first arm was exercised.
   *
   * A Rockhopper account can be Google-side, in which case `/users/me` carries
   * `googleId` and no `msId`; dropping that arm sends `undefined` into
   * `setDrivingHuman`, which is neither the id nor the explicit `null` the API
   * client is typed for. The third arm matters for the same reason in reverse:
   * `null` is the deliberate "let the backend resolve the PAT owner" signal.
   */
  it.each([
    ['a Microsoft account', { msId: 'ms-oid-1', googleId: 'g-oid-1' }, 'ms-oid-1'],
    ['a Google-only account', { googleId: 'g-oid-1' }, 'g-oid-1'],
    ['an account with neither id', {}, null],
  ])(
    'declares the driving human from %s',
    async (_label, ids, expected) => {
      vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
      vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

      const setDrivingHumanMock = vi.fn();
      const apiClientMock = vi.fn().mockImplementation(function () {
        return {
          getMe: vi.fn().mockResolvedValue({ internalId: 1, ...ids }),
          setDrivingHuman: setDrivingHumanMock,
          setAuthExpiredHandler: vi.fn(),
        };
      });

      vi.doMock('../../server.js', () => ({
        createServer: vi.fn().mockReturnValue({ connect: vi.fn() }),
      }));
      vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
      vi.doMock('@modelcontextprotocol/server/stdio', () => ({
        serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
      }));

      await import('../../cli.js');

      expect(setDrivingHumanMock).toHaveBeenCalledWith(expected);
    },
  );

  it('talks to production when ROCKHOPPER_API_URL is not set', async () => {
    // The default every `npx rockhopper-mcp` launch depends on, and the one
    // thing in this file no other spec can catch: a wrong host here points
    // every customer at the wrong backend and nothing else goes red. Stubbed
    // to the empty string rather than deleted so the assertion does not depend
    // on the developer's own environment — and `||` treats both the same,
    // which is why it is `||` and not `??`.
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', '');

    const apiClientMock = vi.fn().mockImplementation(function () {
      return {
        getMe: vi.fn().mockResolvedValue({ internalId: 1, msId: 'ms-oid-1' }),
        setDrivingHuman: vi.fn(),
        setAuthExpiredHandler: vi.fn(),
      };
    });

    vi.doMock('../../server.js', () => ({
      createServer: vi.fn().mockReturnValue({ connect: vi.fn() }),
    }));
    vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
    }));

    await import('../../cli.js');

    expect(apiClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://api.rockhopper.co' }),
    );
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
      serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
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
      serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
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
      serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
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

  // ENG-2176: WHICH SDK entry the CLI uses is the whole 2026-07-28 contract
  // for the stdio surface, not an implementation detail. `serveStdio` is what
  // calls `installModernOnlyHandlers` — the step that registers
  // `server/discover` and adds `2026-07-28` to the instance's supported
  // versions. A bare `new StdioServerTransport()` + `server.connect(...)`
  // leaves the SDK's 2025-only default list in place, so every locally
  // spawned server answers `server/discover` with `-32601` forever.
  // `stdio-2026-07-28.e2e.test.ts` proves what `serveStdio` then serves.
  it('serves stdio through the SDK entry that installs the modern handlers', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const serveStdioMock = vi.fn().mockReturnValue({ close: vi.fn() });
    const transportMock = vi.fn();
    const serverStub = { connect: vi.fn().mockResolvedValue(undefined) };
    const createServerMock = vi.fn().mockReturnValue(serverStub);
    const apiClientMock = vi.fn().mockImplementation(function () {
      return {
        getMe: vi
          .fn()
          .mockResolvedValue({ internalId: 1, msId: 'ms-oid-1', patScope: 'read-only' }),
        setDrivingHuman: vi.fn(),
        setAuthExpiredHandler: vi.fn(),
      };
    });

    vi.doMock('../../server.js', () => ({ createServer: createServerMock }));
    vi.doMock('../../api-client.js', () => ({ ApiClient: apiClientMock }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      serveStdio: serveStdioMock,
      StdioServerTransport: transportMock,
    }));

    await import('../../cli.js');

    expect(serveStdioMock).toHaveBeenCalledTimes(1);
    // The entry owns the transport; constructing one ourselves and connecting
    // to it is exactly the wiring that skips the modern handlers.
    expect(transportMock).not.toHaveBeenCalled();
    expect(serverStub.connect).not.toHaveBeenCalled();

    // It must be handed a FACTORY, and that factory must build our server —
    // the entry calls it per connection and again for a discover probe.
    const factory = serveStdioMock.mock.calls[0][0] as () => unknown;
    expect(typeof factory).toBe('function');
    expect(factory()).toBe(serverStub);
    expect(createServerMock).toHaveBeenCalledWith(expect.anything(), {
      scope: 'read-only',
    });
  });
});
