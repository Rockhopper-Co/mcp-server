import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

import { registerEnrollFileTool } from './enroll-file.js';

export function registerWriteFileTool(
  server: McpServer,
  api: ApiClient,
): void {
  // ENG-2200 — `enroll_file` rides the same `files:write` family as
  // `rename_file`: both are file-lifecycle operations, and a token narrowed to
  // comments must not be able to add a workbook to the workspace.
  registerEnrollFileTool(server, api);

  server.registerTool(
    'rename_file',
    {
      title: 'Rename File',
      description:
        'Rename an enrolled file. The new name is the display name shown across Rockhopper.',
      inputSchema: z.object({
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        name: z.string().min(1).max(255).describe('New name for the file'),
      }),
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
