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
    const getMeMock = vi.fn().mockResolvedValue({ internalId: 1 });
    const apiClientMock = vi.fn().mockImplementation(() => ({ getMe: getMeMock }));
    const transportMock = vi.fn();

    vi.doMock('../../server.js', () => ({
      createServer: createServerMock,
    }));
    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: transportMock,
    }));

    await import('../../cli.js');

    expect(getMeMock).toHaveBeenCalledTimes(1);
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('should exit when token is invalid or expired (401/403)', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_expired');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const getMeMock = vi.fn().mockRejectedValue(
      new Error('Rockhopper API 401: Unauthorized — Invalid or expired token'),
    );
    const apiClientMock = vi.fn().mockImplementation(() => ({ getMe: getMeMock }));

    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('../../server.js', () => ({
      createServer: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
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
    const apiClientMock = vi.fn().mockImplementation(() => ({ getMe: getMeMock }));

    vi.doMock('../../api-client.js', () => ({
      ApiClient: apiClientMock,
    }));
    vi.doMock('../../server.js', () => ({
      createServer: vi.fn(),
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
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
});
