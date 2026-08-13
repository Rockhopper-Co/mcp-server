import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const packageVersion = (
  JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

const registerResourcesMock = vi.fn();
const registerToolsMock = vi.fn();
const registerPromptsMock = vi.fn();

const mcpServerInstance = { _type: 'mockServer', registerTool: vi.fn() };
// vitest 4 invokes a mock's implementation with `new` when the mock is used as
// a constructor; an arrow function can't be constructed, so use a function
// expression. Returning an object from a constructor yields that object.
const mcpServerConstructor = vi.fn(function () {
  return mcpServerInstance;
});

vi.mock('../../resources/index.js', () => ({
  registerResources: registerResourcesMock,
}));

vi.mock('../../tools/index.js', () => ({
  registerTools: registerToolsMock,
}));

vi.mock('../../prompts/index.js', () => ({
  registerPrompts: registerPromptsMock,
}));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: mcpServerConstructor,
}));

describe('createServer wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should instantiate McpServer and register resources/tools/prompts', async () => {
    const { createServer } = await import('../../server.js');
    const apiClient = { any: 'client' } as any;

    const server = createServer(apiClient);

    expect(mcpServerConstructor).toHaveBeenCalledTimes(1);
    expect(registerResourcesMock).toHaveBeenCalledWith(mcpServerInstance, apiClient);
    expect(registerToolsMock).toHaveBeenCalledWith(mcpServerInstance, apiClient, undefined);
    expect(registerPromptsMock).toHaveBeenCalledWith(mcpServerInstance, apiClient);
    expect(server).toBe(mcpServerInstance);
  });

  // ENG-1955. The version declared here is the only handle a client has on
  // which build it is talking to — it comes back in the MCP `initialize`
  // response, for the locally installed server and for every web client that
  // reaches the same tools through mcp-gateway. It was a literal, unchanged
  // since the initial commit, so 0.2.0 through 0.8.0 all announced 0.1.0.
  it('should declare the package version rather than a literal', async () => {
    const { createServer } = await import('../../server.js');
    const apiClient = { any: 'client' } as unknown as Parameters<
      typeof createServer
    >[0];

    createServer(apiClient);

    // The mock constructor declares no parameters, so its recorded call is
    // typed as an empty tuple; assert the shape createServer actually passes.
    const [declared] = mcpServerConstructor.mock.calls[0] as unknown as [
      { name: string; version: string },
    ];
    expect(declared.name).toBe('rockhopper');
    expect(declared.version).toBe(packageVersion);
  });

  it('should pass scope options to registerTools', async () => {
    const { createServer } = await import('../../server.js');
    const apiClient = { any: 'client' } as any;

    createServer(apiClient, { scope: 'read-only' });

    expect(registerToolsMock).toHaveBeenCalledWith(
      mcpServerInstance,
      apiClient,
      { scope: 'read-only' },
    );
  });
});
