import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  advertisesElicitation,
  isModernEra,
  readRequestState,
  selectLane,
} from '../../tools/drive-search-lanes.js';

/**
 * ENG-2204 — which lane a given request can climb, and the one privacy rule
 * that applies to all three.
 *
 * The ladder's whole point is that its BOTTOM rung is universal. A client that
 * advertises nothing must still get a usable question, so every "no capability"
 * case here asserts `tool_result` rather than an error.
 */

const MODERN = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';

function ctxWith(envelope: Record<string, unknown>): ServerContext {
  return { mcpReq: { envelope } } as unknown as ServerContext;
}

describe('isModernEra', () => {
  it('reads the revision off the request envelope', () => {
    expect(isModernEra(ctxWith({ [MODERN]: '2026-07-28' }))).toBe(true);
    expect(isModernEra(ctxWith({ [MODERN]: '2025-11-25' }))).toBe(false);
    expect(isModernEra(ctxWith({}))).toBe(false);
    expect(isModernEra(undefined)).toBe(false);
  });
});

describe('advertisesElicitation', () => {
  it('prefers the request envelope over the connection', () => {
    expect(
      advertisesElicitation(ctxWith({ [CAPS]: { elicitation: {} } }), undefined),
    ).toBe(true);
    // The envelope is the authority for THIS request, so a connection that
    // once advertised elicitation cannot re-widen a request that does not.
    expect(
      advertisesElicitation(ctxWith({ [CAPS]: {} }), { elicitation: {} }),
    ).toBe(false);
  });

  it('falls back to what the connection declared at initialize', () => {
    expect(advertisesElicitation(undefined, { elicitation: {} })).toBe(true);
    expect(advertisesElicitation(undefined, { sampling: {} })).toBe(false);
  });

  it('treats absence as no', () => {
    // Guessing yes costs a call that hangs waiting for an answer nobody will
    // ever be shown.
    expect(advertisesElicitation(undefined, undefined)).toBe(false);
  });
});

describe('selectLane', () => {
  it('puts a 2026-07-28 request on input_required', () => {
    expect(selectLane(ctxWith({ [MODERN]: '2026-07-28' }), undefined)).toBe(
      'input_required',
    );
  });

  it('never routes a modern request to elicitation, even when advertised', () => {
    // `ctx.mcpReq.elicitInput` THROWS on a 2026-07-28 request, so treating the
    // capability as sufficient would make the richest client the only one that
    // fails.
    expect(
      selectLane(
        ctxWith({ [MODERN]: '2026-07-28', [CAPS]: { elicitation: {} } }),
        { elicitation: {} },
      ),
    ).toBe('input_required');
  });

  it('uses elicitation on a legacy session that advertises it', () => {
    expect(selectLane(ctxWith({ [CAPS]: { elicitation: {} } }), undefined)).toBe(
      'elicitation',
    );
  });

  it('degrades to the tool-result question when nothing richer exists', () => {
    expect(selectLane(undefined, undefined)).toBe('tool_result');
    expect(selectLane(ctxWith({}), {})).toBe('tool_result');
  });
});

describe('readRequestState', () => {
  it('returns the echoed nonce as a lookup key', () => {
    const ctx = {
      mcpReq: { requestState: () => 'nonce-1' },
    } as unknown as ServerContext;
    expect(readRequestState(ctx)).toBe('nonce-1');
  });

  it('answers null when a verify hook rejects the state', () => {
    const ctx = {
      mcpReq: {
        requestState: () => {
          throw new Error('state failed verification');
        },
      },
    } as unknown as ServerContext;
    // A refusal, not a crash: the caller treats "no usable nonce" and "a nonce
    // we do not know" the same way, because they mean the same thing.
    expect(readRequestState(ctx)).toBeNull();
  });

  it('answers null when the round carried no state at all', () => {
    expect(readRequestState(undefined)).toBeNull();
    expect(
      readRequestState({ mcpReq: {} } as unknown as ServerContext),
    ).toBeNull();
  });
});

/**
 * The one rule that binds every lane: a customer's private file names, and the
 * words they searched for, never reach the diagnostic log.
 *
 * The backend logs the query's LENGTH for the same reason — enough to tell an
 * empty probe from a real one while reading an incident, and none of the
 * content.
 */
describe('search_drive_files diagnostics', () => {
  const entries: unknown[] = [];

  beforeEach(() => {
    entries.length = 0;
    vi.resetModules();
  });

  it('logs a count and a length, never a query or a file name', async () => {
    vi.doMock('../../logger.js', () => ({
      log: {
        info: (payload: unknown) => entries.push(payload),
        warn: (payload: unknown) => entries.push(payload),
        error: (payload: unknown) => entries.push(payload),
        debug: () => undefined,
      },
    }));

    const [{ registerDriveSearchTool }, { createMockApiClient, createMockMcpServer }] =
      await Promise.all([
        import('../../tools/drive-search.js'),
        import('./test-helpers.js'),
      ]);

    const server = createMockMcpServer();
    registerDriveSearchTool(server as never, createMockApiClient() as never);
    const handler = server.registerTool.mock.calls[0][2] as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;

    await handler({ query: 'Becklar quarterly model' });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('Becklar');
    expect(serialized).not.toContain('quarterly');
    expect(serialized).not.toContain('.xlsx');
    // What IS recorded: enough to read an incident by.
    expect(serialized).toContain('"queryLength":23');
    expect(serialized).toContain('"results":2');
  });
});
