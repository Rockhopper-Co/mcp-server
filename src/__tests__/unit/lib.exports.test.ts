import { describe, expect, it, vi } from 'vitest';

/**
 * The library entry point (`./index.js` → `./lib.js`) must be
 * **side-effect free**. Library consumers (e.g. the remote MCP gateway
 * at `mcp-gateway`) need to be able to `import { createServer, ApiClient }`
 * from the package without:
 *
 *   - reading `ROCKHOPPER_TOKEN` from `process.env`
 *   - calling `process.exit(1)` if the token is missing
 *   - opening an MCP stdio transport
 *
 * If anyone re-introduces top-level CLI bootstrap code into `index.ts`
 * or `lib.ts`, this test fails.
 */
describe('library entry side-effect freedom', () => {
  it('importing the package with NO env set does not exit, does not connect a transport', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', '');
    vi.stubEnv('ROCKHOPPER_API_URL', '');

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error(
          'process.exit called from library entry — side effect leaked',
        );
      }) as never);

    const mod = await import('../../index.js');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(typeof mod.createServer).toBe('function');
    expect(typeof mod.ApiClient).toBe('function');

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('importing ./lib directly is also side-effect free', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', '');

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called from ./lib');
      }) as never);

    const mod = await import('../../lib.js');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mod).toHaveProperty('createServer');
    expect(mod).toHaveProperty('ApiClient');

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('createServer + ApiClient construct without throwing', async () => {
    vi.stubEnv('ROCKHOPPER_TOKEN', '');

    const { createServer, ApiClient } = await import('../../index.js');
    const apiClient = new ApiClient({
      baseUrl: 'http://localhost:3100',
      token: 'rh_pat_test_token',
    });
    const server = createServer(apiClient);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');

    vi.unstubAllEnvs();
  });
});
