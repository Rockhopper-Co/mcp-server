import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { createServer } from '../../server.js';
import { ANCHORED_DOC_FILE } from './fixtures/anchored-comments-fixture.js';
import {
  startMockRockhopperApiServer,
  stopMockRockhopperApiServer,
} from './harness/mock-rockhopper-api-server.js';

/**
 * ENG-6435 — an assistant pins a comment to a paragraph through `add_comment`
 * and reads it back, WITH its location, through `get_file_comments`, over the
 * real MCP protocol against the fixture API. Same in-memory harness as
 * `mcp-in-memory.e2e.test.ts`, kept in its own file for the 300-line cap.
 */
describe('comment anchors over MCP (in-memory e2e)', () => {
  let apiServerHandle: Awaited<ReturnType<typeof startMockRockhopperApiServer>>;
  let client: Client;

  beforeAll(async () => {
    apiServerHandle = await startMockRockhopperApiServer();
    const server = createServer(
      new ApiClient({
        baseUrl: apiServerHandle.baseUrl,
        token: 'rh_pat_test_token',
      }),
      { scope: 'read-write' },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: 'comment-anchor-e2e', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await stopMockRockhopperApiServer(apiServerHandle.server);
  });

  it('writes a paragraph-anchored comment and reads its location back', async () => {
    const written = await client.callTool({
      name: 'add_comment',
      arguments: {
        fileMsId: ANCHORED_DOC_FILE,
        message: 'Tighten the indemnity clause',
        versionInternalId: 77,
        anchor: {
          anchorKind: 'block',
          providerAnchorId: '1A2B3C4D',
          observedVersionInternalId: 77,
        },
      },
    });
    expect(written.isError).toBeFalsy();
    expect(JSON.stringify(written.content)).toContain('[paragraph 1A2B3C4D]');

    const read = await client.callTool({
      name: 'get_file_comments',
      arguments: { fileMsId: ANCHORED_DOC_FILE },
    });
    expect(JSON.stringify(read.content)).toContain(
      '**Assistant** [paragraph 1A2B3C4D]: Tighten the indemnity clause',
    );
  });

  it('an anchor on a spreadsheet comes back as an error naming cellReference', async () => {
    const result = await client.callTool({
      name: 'add_comment',
      arguments: {
        fileMsId: 'file-1',
        message: 'm',
        versionInternalId: 42,
        anchor: { anchorKind: 'block', providerAnchorId: '1A2B3C4D' },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('cellReference');
  });
});
