import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerListFilesTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'list_files',
    {
      title: 'List Enrolled Files',
      description:
        'List all Excel files enrolled in the user\'s Rockhopper workspace. ' +
        'Optionally filter by search term matching file names.',
      inputSchema: {
        search: z.string().optional().describe('Search term to filter file names'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ search }) => {
      try {
        const files = await api.listEnrolledFiles({ search });
        const summary = files
          .map(
            (f) =>
              `- **${f.name}** (id: ${f.platformId}, type: ${f.fileType})` +
              (f.hasUncommittedChanges ? ' [uncommitted changes]' : ''),
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: files.length
                ? `Found ${files.length} file(s):\n\n${summary}`
                : 'No enrolled files found.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list files: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
