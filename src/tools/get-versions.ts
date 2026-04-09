import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerGetVersionsTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_file_versions',
    {
      title: 'Get File Versions',
      description:
        'Get the version history for a specific enrolled file. ' +
        'Returns all version snapshots with semver numbering, timestamps, and attribution.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileMsId }) => {
      try {
        const versions = await api.getFileVersions(fileMsId);
        const summary = versions
          .map((v) => {
            const ver = `v${v.majorVersion}.${v.minorVersion}.${v.patchVersion}`;
            const flags = [
              v.wasDiscarded ? 'discarded' : null,
              v.wasReverted ? 'reverted' : null,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              `- **${ver}** (id: ${v.internalId}) — ${v.createdAt}` +
              (v.description ? ` — ${v.description}` : '') +
              (v.byUserPlatformId ? ` — by ${v.byUserPlatformId}` : '') +
              (flags ? ` [${flags}]` : '')
            );
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: versions.length
                ? `${versions.length} version(s):\n\n${summary}`
                : 'No versions found for this file.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get versions: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
