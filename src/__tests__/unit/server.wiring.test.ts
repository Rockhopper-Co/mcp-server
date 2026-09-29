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

// ENG-2208: `createServer` now asks the tools module whether a scope grants
// the write tools, so this mock must carry that export too — the real
// allow-list is exercised in `tools.scope-gate.test.ts`.
vi.mock('../../tools/index.js', () => ({
  registerTools: registerToolsMock,
  grantsWriteTools: (scope?: string) => scope === 'read-write',
  // ENG-2212: `createServer` resolves the granted families and builds the
  // instructions from them. The real resolution is exercised in
  // `tools.capability-gate.test.ts`; this stands in for it.
  resolveCapabilities: (options?: { scope?: string; capabilities?: string[] }) =>
    options?.capabilities !== undefined
      ? options.capabilities
      : options?.scope === 'read-write'
        ? ['comments:write', 'reviews:write', 'versions:write', 'files:write']
        : [],
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
    const apiClient = { any: 'client', setClientToolProvider: () => {} } as any;

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
    const apiClient = { any: 'client', setClientToolProvider: () => {} } as unknown as Parameters<
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
    const apiClient = { any: 'client', setClientToolProvider: () => {} } as any;

    createServer(apiClient, { scope: 'read-only' });

    expect(registerToolsMock).toHaveBeenCalledWith(
      mcpServerInstance,
      apiClient,
      { scope: 'read-only' },
    );
  });

  // ENG-2208: the instructions text is the model's only description of what it
  // may do. It has to agree with the gate — a scope that gets 7 tools must not
  // be told nine write tools exist, or the model plans work it cannot perform.
  it.each([
    ['read-only', true],
    ['admin', true],
    [undefined, true],
    ['read-write', false],
  ])(
    'declares read-only instructions for scope %s: %s',
    async (scope, expectReadOnly) => {
      const { createServer } = await import('../../server.js');
      const apiClient = { any: 'client', setClientToolProvider: () => {} } as any;

      createServer(apiClient, scope === undefined ? undefined : { scope });

      const [, opts] = mcpServerConstructor.mock.calls[0] as unknown as [
        unknown,
        { instructions: string },
      ];
      expect(opts.instructions.includes('token is read-only')).toBe(
        expectReadOnly,
      );
      expect(opts.instructions.includes('add_comment')).toBe(!expectReadOnly);
    },
  );
});
