import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cli bootstrap', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should exit when ROCKHOPPER_TOKEN is missing', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', '');
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('exit');
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(import('../../cli.js')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should construct client/server and connect transport when token is provided', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_test_token');
    vi.stubEnv('ROCKHOPPER_API_URL', 'http://localhost:3100');

    const connectMock = vi.fn().mockResolvedValue(undefined);
    const createServerMock = vi.fn().mockReturnValue({ connect: connectMock });
    const apiClientMock = vi.fn();
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

    expect(apiClientMock).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:3100',
      token: 'rh_pat_test_token',
    });
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(transportMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
