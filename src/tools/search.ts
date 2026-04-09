import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerSearchTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'search_files',
    {
      title: 'Search Files',
      description:
        'Search enrolled files by name. Returns matching files with their ' +
        'metadata including uncommitted change status.',
      inputSchema: {
        query: z.string().describe('Search query to match against file names'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      try {
        const files = await api.listEnrolledFiles({ search: query });
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
                ? `Found ${files.length} file(s) matching "${query}":\n\n${summary}`
                : `No files match "${query}".`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_unattributed_changes',
    {
      title: 'Get Unattributed Changes',
      description:
        'Get pending cell-level changes that have not been attributed to a ' +
        'committed version yet. Optionally filter by sheet name.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        sheetName: z
          .string()
          .optional()
          .describe('Filter to a specific worksheet'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileMsId, sheetName }) => {
      try {
        const changes = await api.getUnattributedChanges(fileMsId, {
          sheetName,
        });

        const summary = changes
          .map(
            (c) =>
              `- **${c.sheetName}!${c.cellAddress}** (${c.changeType}): ` +
              `${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}` +
              (c.byUserPlatformId ? ` — by ${c.byUserPlatformId}` : '') +
              ` — ${c.createdAt}`,
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: changes.length
                ? `${changes.length} unattributed change(s):\n\n${summary}`
                : 'No unattributed changes found.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get changes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
