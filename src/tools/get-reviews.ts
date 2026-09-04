import type { McpServer } from '@modelcontextprotocol/server';
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
        'Provide EXACTLY ONE of versionId or fileMsId (for latest version reviews) — ' +
        'sending both is refused, because they can name different files.',
      inputSchema: z.object({
        versionId: z
          .number()
          .optional()
          .describe(
            'Internal ID of the file version. Mutually exclusive with ' +
              '`fileMsId` — never send both.',
          ),
        fileMsId: z
          .string()
          .optional()
          .describe(
            'Platform ID of the enrolled file (returns reviews for latest ' +
              'version). Mutually exclusive with `versionId` — never send both.',
          ),
      }),
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

        // ENG-4339 — REFUSE both-present rather than picking one. The two
        // identifiers can name DIFFERENT files (a caller holds `fileMsId` from
        // `list_files` and `versionId` from `get_file_versions`, and filling in
        // everything it knows is the natural move), and the old ternary took
        // `versionId` while discarding `fileMsId` without a word. That renders
        // one file's reviews under another file's handle — a wrong answer
        // attributed to the wrong file, which is worse than an error.
        //
        // A silent precedence rule is invisible to a caller who did not know
        // there was a conflict, so this mirrors the both-absent guard above and
        // the same exclusion `enroll_file` already enforces
        // (`src/tools/enroll-file.ts` — "not both").
        if (versionId && fileMsId) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Provide versionId or fileMsId, not both — they can name ' +
                  'different files and this tool will not guess which one you ' +
                  'meant. Use versionId for one specific version, or fileMsId ' +
                  "for that file's latest version.",
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
