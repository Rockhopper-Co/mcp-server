import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 1.1 / KI-226 + Phase 1.5 / KI-225 — exercise the `installCorrelationScope`
// wrapper that `createServer` installs over `McpServer.registerTool`. The
// in-memory e2e suite covers the success path indirectly (every tool call logs
// `tool_call`), but a tool handler never *throws* out to the wrapper there (the
// handlers catch internally and return `{ isError: true }`), so the
// `tool_call_failed` / re-throw branch (server.ts 42-47) stays uncovered. This
// test registers a wrapped tool and invokes its handler for BOTH the resolve and
// reject branches.

const logMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

vi.mock('../../logger.js', () => ({ log: logMock, serviceVersion: '0.0.0-test' }));
vi.mock('../../resources/index.js', () => ({ registerResources: vi.fn() }));
vi.mock('../../tools/index.js', () => ({
  registerTools: vi.fn(),
  // ENG-2208: `createServer` asks the tools module which scopes grant writes.
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
vi.mock('../../prompts/index.js', () => ({ registerPrompts: vi.fn() }));

// Each construction returns a FRESH server whose original `registerTool` records
// `(name, config, cb)`. `installCorrelationScope` rebinds `registerTool` to its
// wrapper; the wrapper calls the recorded base with the WRAPPED handler, so
// `__recorded[i].cb` is the wrapper we then invoke directly. A fresh instance
// per call avoids the "wrapper wraps the previous wrapper" trap a shared
// singleton would hit across `createServer` calls.
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: vi.fn(function () {
    const recorded: Array<{
      name: string;
      config: unknown;
      cb: (...args: unknown[]) => unknown;
    }> = [];
    return {
      __recorded: recorded,
      registerTool(
        name: string,
        config: unknown,
        cb: (...args: unknown[]) => unknown,
      ) {
        recorded.push({ name, config, cb });
      },
    };
  }),
}));

interface RecordingServer {
  __recorded: Array<{
    name: string;
    config: unknown;
    cb: (...args: unknown[]) => unknown;
  }>;
  registerTool: (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => void;
}

describe('installCorrelationScope wrapped registerTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs tool_call (ok) and returns the handler result', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer(
      { setClientToolProvider: () => {} } as never,
    ) as unknown as RecordingServer;

    const handler = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    server.registerTool('list_files', { title: 'List files' }, handler);

    expect(server.__recorded).toHaveLength(1);
    const wrapped = server.__recorded[0].cb;

    const result = await wrapped({ search: 'budget' });

    expect(handler).toHaveBeenCalledWith({ search: 'budget' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(logMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tool_call',
        tool: 'list_files',
        outcome: 'ok',
      }),
      'tool_call',
    );
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('logs tool_call_failed and re-throws when the handler rejects', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer(
      { setClientToolProvider: () => {} } as never,
    ) as unknown as RecordingServer;

    const boom = new Error('handler exploded');
    const handler = vi.fn().mockRejectedValue(boom);
    server.registerTool('add_comment', {}, handler);

    expect(server.__recorded).toHaveLength(1);
    const wrapped = server.__recorded[0].cb;

    await expect(wrapped({ fileMsId: 'file-1' })).rejects.toThrow(
      'handler exploded',
    );

    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tool_call_failed',
        tool: 'add_comment',
      }),
      'tool_call_failed',
    );
    expect(logMock.info).not.toHaveBeenCalled();
  });
});
