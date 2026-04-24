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
        expect(JSON.stringify(resourcesList.result)).toContain('rockhopper://files');

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
});
