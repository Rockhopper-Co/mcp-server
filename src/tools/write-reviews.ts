import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerWriteReviewTools(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'create_review_request',
    {
      title: 'Create Review Request',
      description:
        'Request a review for a specific file version. Assigns reviewers who ' +
        'will be notified to approve or comment on the version. ' +
        'Reviewer IDs are numeric internal user IDs — use list_team_members or ' +
        'the team resource to resolve platform IDs (msId / googleId) to internal IDs first.',
      inputSchema: {
        versionId: z
          .number()
          .describe('Internal ID of the file version to review'),
        subject: z
          .string()
          .min(1)
          .max(500)
          .describe('Subject/title of the review request'),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe('Optional description of what to review'),
        reviewerIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe('Internal user IDs of reviewers to assign'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ versionId, subject, description, reviewerIds }) => {
      try {
        const review = await api.createReviewRequest({
          versionId,
          subject,
          description,
          reviewerIds,
        });

        return {
          content: [
            {
              type: 'text',
              text:
                `Review request created (id: ${review.id}):\n` +
                `Subject: "${review.subject}"\n` +
                `Status: ${review.status}\n` +
                `Assigned to ${reviewerIds.length} reviewer(s)`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create review: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'approve_review',
    {
      title: 'Approve Review',
      description:
        'Approve a review request. Only assigned reviewers can approve.',
      inputSchema: {
        reviewId: z.number().describe('ID of the review request to approve'),
        notes: z
          .string()
          .max(5000)
          .optional()
          .describe('Optional approval notes'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ reviewId, notes }) => {
      try {
        const review = await api.approveReview(reviewId, { notes });

        return {
          content: [
            {
              type: 'text',
              text:
                `Review ${review.id} approved.` +
                (notes ? ` Notes: "${notes}"` : ''),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to approve: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
