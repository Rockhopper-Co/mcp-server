import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerWriteFileTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'rename_file',
    {
      title: 'Rename File',
      description:
        'Rename an enrolled file. The new name is the display name shown across Rockhopper.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        name: z.string().min(1).max(255).describe('New name for the file'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ fileMsId, name }) => {
      try {
        const file = await api.updateEnrolledFile(fileMsId, { name });

        return {
          content: [
            {
              type: 'text',
              text: `File renamed to "${file.name}" (id: ${file.platformId}).`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to update file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
