import { describe, expect, it } from 'vitest';
import { McpStdioClient } from './harness/mcp-client.js';
import {
  startMockRockhopperApiServer,
  stopMockRockhopperApiServer,
} from './harness/mock-rockhopper-api-server.js';

describe('MCP stdio protocol e2e', () => {
  it(
    'should expose tools/resources/prompts and execute representative tool calls',
    async () => {
      const { server, baseUrl } = await startMockRockhopperApiServer();
      const client = new McpStdioClient();

      try {
        await client.start({
          ROCKHOPPER_API_URL: baseUrl,
          ROCKHOPPER_TOKEN: 'rh_pat_test_token',
        });

        const toolsList = await client.listTools();
        expect(toolsList.error).toBeUndefined();
        expect(JSON.stringify(toolsList.result)).toContain('list_files');
        expect(JSON.stringify(toolsList.result)).toContain('add_comment');

        const resourcesList = await client.listResources();
        expect(resourcesList.error).toBeUndefined();
        const resources = (resourcesList.result as {
          resources: Array<{ uri: string }>;
        }).resources;
        const resourceUris = resources.map((r) => r.uri).sort();
        // After KI-078 + KI-079: exactly 2 static resources, never per-file expansions.
        expect(resourceUris).toEqual(
          [
            'rockhopper://files',
            'rockhopper://orchestration-guide',
          ].sort(),
        );

        const templatesList = await client.listResourceTemplates();
        expect(templatesList.error).toBeUndefined();
        const templates = (templatesList.result as {
          resourceTemplates: Array<{ uriTemplate: string }>;
        }).resourceTemplates;
        expect(templates).toHaveLength(8);
        expect(templates.map((t) => t.uriTemplate)).toContain(
          'rockhopper://files/{fileMsId}',
        );

        const promptsList = await client.listPrompts();
        expect(promptsList.error).toBeUndefined();
        expect(JSON.stringify(promptsList.result)).toContain('file-overview');

        const listFilesResult = await client.callTool('list_files', {});
        expect(listFilesResult.error).toBeUndefined();
        expect(JSON.stringify(listFilesResult.result)).toContain('Budget.xlsx');

        const addCommentResult = await client.callTool('add_comment', {
          fileMsId: 'file-1',
          message: 'hello from e2e',
          versionInternalId: 42,
        });
        expect(addCommentResult.error).toBeUndefined();
        expect(JSON.stringify(addCommentResult.result)).toContain(
          'Comment created',
        );
      } finally {
        await client.stop();
        await stopMockRockhopperApiServer(server);
      }
    },
    30_000,
  );

  /**
   * ENG-2175 — the SDK moved from v1 to the v2 split packages. A connected
   * client must see no difference on the wire, so the negotiated protocol
   * version is pinned here: v2's `LATEST_PROTOCOL_VERSION` is `2025-11-25`,
   * the same as v1 1.30.0. Serving 2026-07-28 is ENG-2176, not this move.
   */
  it.each(['2025-11-25', '2024-11-05'])(
    'negotiates %s unchanged on the v2 SDK',
    async (requested) => {
      const { server, baseUrl } = await startMockRockhopperApiServer();
      const client = new McpStdioClient();

      try {
        await client.start(
          {
            ROCKHOPPER_API_URL: baseUrl,
            ROCKHOPPER_TOKEN: 'rh_pat_test_token',
          },
          requested,
        );

        const init = client.initializeResponse;
        expect(init?.error).toBeUndefined();
        const result = init?.result as {
          protocolVersion: string;
          serverInfo: { name: string };
          capabilities: Record<string, unknown>;
        };
        expect(result.protocolVersion).toBe(requested);
        expect(result.serverInfo.name).toBe('rockhopper');
        // Measured on v1 1.30.0 with the same registrations: exactly these
        // three. `completions` is advertised only when a prompt arg is
        // `completable()` or a resource template carries a complete callback,
        // and this server uses neither — same gate in both SDK lines.
        expect(Object.keys(result.capabilities).sort()).toEqual([
          'prompts',
          'resources',
          'tools',
        ]);
      } finally {
        await client.stop();
        await stopMockRockhopperApiServer(server);
      }
    },
    30_000,
  );
});
