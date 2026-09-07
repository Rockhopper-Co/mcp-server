import { afterEach, describe, expect, it, vi } from 'vitest';
import { remediationFor } from '../../auth/remediation.js';

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
        // ENG-4220: `msId` is load-bearing here even though this spec is about
        // the 401 handler. The fixture used to be a bare `{ internalId: 1 }`,
        // which is what an account linked to NEITHER provider looks like — and
        // that now prints its own stderr warning, so `not.toHaveBeenCalled()`
        // below would fail for a reason this test does not care about. A linked
        // account is also the honest fixture for "a successful start".
        getMe: vi.fn().mockResolvedValue({ internalId: 1, msId: 'ms-oid-1' }),
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
    // ENG-4222: this launch resolved a PAT, so the handler must still carry the
    // PAT remediation. `stringContaining('401')` alone passed both before and
    // after the branch existed and could not tell them apart.
    const message = errorSpy.mock.calls[0][0] as string;
    expect(message).toContain('401');
    expect(message).toContain(remediationFor('pat'));
  });

  /**
   * ENG-1756 — the driving human is read off the preflight with a THREE-arm
   * fallback and only the first arm was exercised.
   *
   * A Rockhopper account can be Google-side, in which case `/users/me` carries
   * `googleId` and no `msId`; dropping that arm sends `undefined` into
   * `setDrivingHuman`, which is neither the id nor the explicit `null` the API
   * client is typed for.
   *
   * ENG-4220 corrected what the third arm MEANS. It used to be described here
   * as "the deliberate 'let the backend resolve the PAT owner' signal" — the
   * backend does no such thing (`user.entity.ts:371-373` makes its fallback
   * the same `msId || googleId`), so that `null` is a total write outage, not
   * a handoff. The assertion is unchanged on purpose: sending an internal id
   * instead would write an unresolvable attribution, so the client still sends
   * `null` and now WARNS about it — see the two ENG-4220 specs below.
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

  /**
   * ENG-4220 — an account with neither provider id cannot perform ANY write,
   * and nothing told the person who installed this server.
   *
   * `setDrivingHuman(null)` omits `X-Driving-Human` (`api-client.ts:288-290`),
   * and the backend guard's fallback is `request.userPlatformId`
   * (`jwt-or-api-key.guard.ts:233`), which `User.getPlatformId()` defines as
   * the SAME `msId || googleId` pair this preflight already read
   * (`user.entity.ts:371-373`). Both null on both sides, so the guard 403s
   * every write. The arm above asserts the `null` is still sent; this asserts
   * the client no longer stays SILENT about what that null means.
   *
   * Asserted on stderr because that is the only channel a stdio server has to
   * a human — a 403 rendered into a tool result is read by the model and by
   * nobody else. Same shape as the mid-session-expiry notice below it.
   */
  it('warns on stderr when the account carries no linkable provider id (ENG-4220)', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const apiClientMock = vi.fn().mockImplementation(function () {
      return {
        getMe: vi
          .fn()
          .mockResolvedValue({ internalId: 1, msId: null, googleId: null }),
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

    // The remediation, not just "something went wrong": name the action that
    // fixes it (link an account) and the fact that reads keep working, so the
    // reader can tell a degraded server from a broken one.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Microsoft or Google'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reads still work'),
    );
  });

  /**
   * ENG-4220 — the negative half. A linked account must NOT get the warning:
   * a notice that fires for everybody is noise the reader learns to skip, and
   * it would be indistinguishable from the real thing when it matters.
   */
  it('stays silent about the driving human when a provider id IS present (ENG-4220)', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const apiClientMock = vi.fn().mockImplementation(function () {
      return {
        getMe: vi.fn().mockResolvedValue({ internalId: 1, googleId: 'g-oid-1' }),
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

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Microsoft or Google'),
    );
  });

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
