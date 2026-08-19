import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import { formatVersion } from '../version-format.js';

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
      inputSchema: z.object({
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      }),
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
            // ENG-2750 — a negative-semver discard marker renders as what it
            // is. The `[discarded]` tag below stays: it reports `wasDiscarded`,
            // a separate field, so a discard recorded WITHOUT the negative
            // marker keeps its flag.
            const ver = formatVersion(v);
            const flags = [
              v.wasDiscarded ? 'discarded' : null,
              v.wasReverted ? 'reverted' : null,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              `- **${ver}** (id: ${v.internalId}) — ${v.createdAt}` +
              (v.description ? ` — ${v.description}` : '') +
              // ENG-2603 — prefer the resolved name; fall back to the
              // platform id only when the backend could not resolve one.
              // A uuid answers "who changed this" with something no human
              // recognises and no model can use.
              (v.byUserName ?? v.byUserPlatformId
                ? ` — by ${v.byUserName ?? v.byUserPlatformId}`
                : '') +
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
