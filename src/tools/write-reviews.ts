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
        'will be notified to approve or comment on the version.',
      inputSchema: {
        fileVersionInternalId: z
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
        reviewerMsIds: z
          .array(z.string())
          .min(1)
          .describe('Platform IDs of users to assign as reviewers'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({
      fileVersionInternalId,
      subject,
      description,
      reviewerMsIds,
    }) => {
      try {
        const review = await api.createReviewRequest({
          fileVersionInternalId,
          subject,
          description,
          reviewerMsIds,
        });

        return {
          content: [
            {
              type: 'text',
              text:
                `Review request created (id: ${review.id}):\n` +
                `Subject: "${review.subject}"\n` +
                `Status: ${review.status}\n` +
                `Assigned to ${reviewerMsIds.length} reviewer(s)`,
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
