import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
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
