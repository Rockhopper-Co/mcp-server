import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { createServer } from '../../server.js';
import {
  startMockRockhopperApiServer,
  stopMockRockhopperApiServer,
} from './harness/mock-rockhopper-api-server.js';

/**
 * ENG-2176 — the cache metadata this server puts on 2026-07-28 results.
 *
 * Driven through `createMcpHandler`, because that entry is the only thing
 * that reaches the 2026-era encode seam where `ttlMs` / `cacheScope` are
 * resolved. The in-memory e2e next door connects a `Client` over
 * `InMemoryTransport`, which is a 2025-era handshake — it can never observe
 * these fields, by design (the 2025 codec has no cache path at all).
 *
 * The values are a decision, not a default. See `server.ts` for the
 * reasoning; this file pins it so a later edit has to argue with a test.
 */

const PROTOCOL_VERSION = '2026-07-28';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

describe('2026-07-28 cache metadata', () => {
  let apiServerHandle: Awaited<ReturnType<typeof startMockRockhopperApiServer>>;
  let handler: ReturnType<typeof createMcpHandler>;

  beforeAll(async () => {
    apiServerHandle = await startMockRockhopperApiServer();
    const apiClient = new ApiClient({
      baseUrl: apiServerHandle.baseUrl,
      token: 'rh_pat_test_token',
    });
    handler = createMcpHandler(() =>
      createServer(apiClient, { scope: 'read-write' }),
    );
  });

  afterAll(async () => {
    await handler?.close();
    await stopMockRockhopperApiServer(apiServerHandle.server);
  });

  async function call(
    method: string,
    params: Record<string, unknown> = {},
    nameHeader?: string,
  ): Promise<Record<string, unknown>> {
    const res = await handler.fetch(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'Mcp-Method': method,
          ...(nameHeader === undefined ? {} : { 'Mcp-Name': nameHeader }),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      }),
    );
    const text = await res.text();
    const framed = text.includes('data: ')
      ? (text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length) ?? '')
      : text;
    const body = JSON.parse(framed) as {
      result?: Record<string, unknown>;
      error?: unknown;
    };
    if (body.result === undefined) {
      throw new Error(`${method} returned an error: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }

  it('caches tools/list for five minutes, privately — the tool set is scope-gated', async () => {
    const result = await call('tools/list');
    expect(result.ttlMs).toBe(FIVE_MINUTES_MS);
    // MUST be private: `registerTools` withholds the nine write tools from a
    // read-only token, so this list differs per principal and a shared cache
    // keyed on the URL alone would serve one token's surface to another.
    expect(result.cacheScope).toBe('private');
  });

  it('caches the static registration lists for an hour, privately', async () => {
    for (const method of [
      'prompts/list',
      'resources/list',
      'resources/templates/list',
    ]) {
      const result = await call(method);
      expect(result.ttlMs, method).toBe(ONE_HOUR_MS);
      expect(result.cacheScope, method).toBe('private');
    }
  });

  it('caches server/discover for an hour, privately — instructions vary by scope', async () => {
    const result = await call('server/discover');
    expect(result.ttlMs).toBe(ONE_HOUR_MS);
    expect(result.cacheScope).toBe('private');
    expect(result.supportedVersions).toEqual([PROTOCOL_VERSION]);
  });

  it('never caches resources/read — it is live collaborative data', async () => {
    const result = await call(
      'resources/read',
      { uri: 'rockhopper://files' },
      'rockhopper://files',
    );
    // The SDK's conservative default, kept ON PURPOSE. Another user editing a
    // workbook changes this answer and we have no invalidation signal to
    // publish, so any non-zero TTL here serves a stale review surface.
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
  });

  it('reports the read-only tool surface with the same cache policy', async () => {
    const readOnly = createMcpHandler(() =>
      createServer(
        new ApiClient({
          baseUrl: apiServerHandle.baseUrl,
          token: 'rh_pat_test_token',
        }),
        { scope: 'read-only' },
      ),
    );
    try {
      const res = await readOnly.fetch(
        new Request('https://mcp.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': PROTOCOL_VERSION,
            'Mcp-Method': 'tools/list',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
                [CLIENT_CAPABILITIES_META_KEY]: {},
              },
            },
          }),
        }),
      );
      const text = await res.text();
      const framed = text.includes('data: ')
        ? (text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length) ?? '')
        : text;
      const result = (JSON.parse(framed) as { result: Record<string, unknown> })
        .result;
      expect(result.ttlMs).toBe(FIVE_MINUTES_MS);
      expect(result.cacheScope).toBe('private');
      // The very reason this is `private`: a read-only token sees a strictly
      // smaller tool set than the read-write one asserted above.
      const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).not.toContain('add_comment');
    } finally {
      await readOnly.close();
    }
  });
});
