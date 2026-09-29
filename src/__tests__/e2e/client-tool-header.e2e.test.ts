import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { createServer } from '../../server.js';
import { handleMockRockhopperRequest } from './fixtures/rockhopper-api-fixtures.js';

/**
 * ENG-6517 — every WRITE tool names the app that connected, over the real
 * protocol.
 *
 * The unit spec proves the header on one hand-picked `ApiClient` call. This one
 * proves the thing the backend relies on: the name comes from the MCP
 * `initialize` handshake (`clientInfo.name`), and it rides EVERY write request
 * every write tool puts on the wire. The backend reads it as
 * `x-rockhopper-client-tool` (`provenance-context-headers.ts`) through
 * `requestToolIdentity`, at `client_declared` — the weakest class — and only
 * when the credential named no tool.
 *
 * The write set is DERIVED from the tool catalogue's own annotations, not
 * listed here, so a new write tool without an entry in `WRITE_TOOL_ARGS`
 * fails by name instead of silently going unchecked.
 */
const CONNECTED_APP = 'Cursor';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEADER = 'x-rockhopper-client-tool';

const WRITE_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  add_comment: { fileMsId: 'file-1', message: 'hi', versionInternalId: 42 },
  reply_to_comment: { chatId: 900, message: 'ack', versionInternalId: 42 },
  resolve_comment: { chatId: 900 },
  create_review_request: {
    versionId: 101,
    subject: 'Please review',
    reviewerIds: [1],
  },
  approve_review: { reviewId: 500 },
  cancel_review: { reviewId: 500 },
  create_version: {
    fileMsId: 'file-1',
    versionType: 'minor',
    description: 'Updated assumptions',
  },
  discard_changes: { fileMsId: 'file-1', description: 'Wrong assumptions' },
  rename_file: { fileMsId: 'file-1', name: 'Budget-final.xlsx' },
  enroll_file: {
    url: 'https://contoso.sharepoint.com/:x:/r/sites/finance/Doc.aspx',
    share_with: 'me',
  },
  disconnect_microsoft: {},
  disconnect_google: {},
};

interface SeenRequest {
  method: string;
  url: string;
  clientTool: string | undefined;
}

describe('X-Rockhopper-Client-Tool on every write tool (ENG-6517)', () => {
  let api: Server;
  let client: Client;
  let seen: SeenRequest[] = [];

  beforeAll(async () => {
    api = createHttpServer((req, res) => {
      const raw = req.headers[HEADER];
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        clientTool: Array.isArray(raw) ? raw[0] : raw,
      });
      handleMockRockhopperRequest(req, res);
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const { port } = api.address() as AddressInfo;

    const server = createServer(
      new ApiClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'rh_pat_test_token',
      }),
      { scope: 'read-write' },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: CONNECTED_APP, version: '9.9.9' },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  it('has arguments for every write tool the catalogue declares', async () => {
    const { tools } = await client.listTools();
    const writeTools = tools
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name)
      .sort();
    expect(writeTools.length).toBeGreaterThan(0);
    expect(writeTools).toEqual(Object.keys(WRITE_TOOL_ARGS).sort());
  });

  it.each(Object.entries(WRITE_TOOL_ARGS))(
    '%s sends the connected app name on every write request',
    async (name, args) => {
      await client.callTool({ name, arguments: args });
      const writes = seen.filter((r) => WRITE_METHODS.has(r.method));
      expect(writes.length, `${name} made no write request`).toBeGreaterThan(0);
      for (const w of writes) {
        expect(w.clientTool, `${w.method} ${w.url}`).toBe(CONNECTED_APP);
      }
    },
  );

  it('keeps the header off reads', async () => {
    await client.callTool({ name: 'list_files', arguments: {} });
    const reads = seen.filter((r) => r.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.clientTool).toBeUndefined();
  });
});
