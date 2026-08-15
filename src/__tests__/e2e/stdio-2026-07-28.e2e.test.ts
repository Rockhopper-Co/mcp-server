import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { createServer } from '../../server.js';
import {
  startMockRockhopperApiServer,
  stopMockRockhopperApiServer,
} from './harness/mock-rockhopper-api-server.js';

/**
 * ENG-2176 — the locally-spawned (stdio) server must serve 2026-07-28 too.
 *
 * The gateway is not the only surface: customers run this package directly
 * from Cursor / Claude Desktop over stdio, and `cli.ts` is what wires it.
 * A hand-constructed `McpServer` connected straight to a transport answers
 * `server/discover` with `-32601` forever, because the SDK's default
 * `SUPPORTED_PROTOCOL_VERSIONS` names only 2025-era revisions — the modern
 * handlers are installed by the SERVING ENTRY (`serveStdio`), not by the
 * server object. This pins that the entry is what we use.
 *
 * `serveStdio` owns the transport, so the test brings its own linked pair
 * rather than the process's real stdin/stdout.
 */

const PROTOCOL_VERSION = '2026-07-28';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';

describe('stdio serving on protocol revision 2026-07-28', () => {
  let apiServerHandle: Awaited<ReturnType<typeof startMockRockhopperApiServer>>;
  let handle: ReturnType<typeof serveStdio>;
  let clientSide: InMemoryTransport;

  beforeAll(async () => {
    apiServerHandle = await startMockRockhopperApiServer();
    const apiClient = new ApiClient({
      baseUrl: apiServerHandle.baseUrl,
      token: 'rh_pat_test_token',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    clientSide = a;
    handle = serveStdio(() => createServer(apiClient, { scope: 'read-write' }), {
      transport: b,
    });
    await clientSide.start();
  });

  afterAll(async () => {
    await handle?.close();
    await clientSide?.close();
    await stopMockRockhopperApiServer(apiServerHandle.server);
  });

  /** Send one modern request and resolve with the matching response. */
  async function call(
    id: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
      const prior = clientSide.onmessage;
      clientSide.onmessage = (message: JSONRPCMessage) => {
        const msg = message as unknown as {
          id?: number;
          result?: Record<string, unknown>;
          error?: unknown;
        };
        if (msg.id !== id) return;
        clearTimeout(timer);
        clientSide.onmessage = prior;
        if (msg.result === undefined) {
          reject(new Error(`${method} errored: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result);
      };
    });
    await clientSide.send({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    } as unknown as JSONRPCMessage);
    return response;
  }

  it('answers server/discover with our supported versions and cache metadata', async () => {
    const result = await call(1, 'server/discover');
    expect(result.supportedVersions).toEqual([PROTOCOL_VERSION]);
    expect(result.capabilities).toBeTruthy();
    expect(result.ttlMs).toBe(60 * 60 * 1000);
    expect(result.cacheScope).toBe('private');
  });

  it('completes a tool call on the 2026-07-28 envelope', async () => {
    const list = await call(2, 'tools/list');
    expect((list.tools as Array<{ name: string }>).map((t) => t.name)).toContain(
      'list_files',
    );
    expect(list.ttlMs).toBe(5 * 60 * 1000);

    const call1 = await call(3, 'tools/call', {
      name: 'list_files',
      arguments: {},
    });
    const content = call1.content as Array<{ type: string; text: string }>;
    expect(content.find((c) => c.type === 'text')?.text).toBeTruthy();
    expect(call1.resultType).toBe('complete');
  });
});
