import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerGetReviewsTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_reviews',
    {
      title: 'Get Reviews',
      description:
        'Get all review requests for a specific file version, or for the latest version of a file. ' +
        'Provide either a versionId or fileMsId (for latest version reviews).',
      inputSchema: {
        versionId: z
          .number()
          .optional()
          .describe('Internal ID of the file version'),
        fileMsId: z
          .string()
          .optional()
          .describe(
            'Platform ID of the enrolled file (returns reviews for latest version)',
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ versionId, fileMsId }) => {
      try {
        if (!versionId && !fileMsId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Provide either versionId or fileMsId.',
              },
            ],
            isError: true,
          };
        }

        const reviews = versionId
          ? await api.getReviewsForVersion(versionId)
          : await api.getReviewsForLatestVersion(fileMsId!);

        const summary = reviews
          .map((r) => {
            const reviewer = r.requester
              ? `${r.requester.firstName} ${r.requester.lastName}`
              : 'Unknown';
            return (
              `- **${r.subject}** (id: ${r.id}, status: ${r.status})` +
              ` — requested by ${reviewer} on ${r.createdAt}` +
              (r.description ? ` — ${r.description}` : '')
            );
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: reviews.length
                ? `${reviews.length} review(s):\n\n${summary}`
                : 'No reviews found.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get reviews: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
