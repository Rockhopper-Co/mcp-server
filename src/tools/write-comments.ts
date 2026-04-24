import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerWriteCommentTools(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'add_comment',
    {
      title: 'Add Comment',
      description:
        'Add a new comment to an enrolled file. Every comment is scoped to a ' +
        'specific file version — typically the latest (live) version unless ' +
        'the user explicitly wants to comment on a historical version.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        message: z.string().min(1).max(5000).describe('Comment text'),
        versionInternalId: z
          .number()
          .int()
          .positive()
          .describe(
            'Required. Internal ID of the file version to attach the comment to. ' +
              'Fetch via list_file_versions to find the correct id for the latest or target version.',
          ),
        cellReference: z
          .string()
          .optional()
          .describe('Cell reference (e.g. "Sheet1!A1")'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ fileMsId, message, cellReference, versionInternalId }) => {
      try {
        const comment = await api.createComment({
          fileMsId,
          message,
          cellReference,
          versionInternalId,
        });

        return {
          content: [
            {
              type: 'text',
              text:
                `Comment created (id: ${comment.internalId}):\n` +
                `"${comment.message}"` +
                (comment.cellReference
                  ? ` at ${comment.cellReference}`
                  : ''),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to add comment: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to Comment',
      description:
        'Reply to an existing comment thread. Replies are scoped to a file version ' +
        '— pass the same versionInternalId as the parent thread or the current live version.',
      inputSchema: {
        chatId: z.number().describe('Internal ID of the parent comment'),
        message: z.string().min(1).max(5000).describe('Reply text'),
        versionInternalId: z
          .number()
          .int()
          .positive()
          .describe(
            'Required. Internal ID of the file version the reply is scoped to. ' +
              'Typically the live version or the same version as the parent comment.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ chatId, message, versionInternalId }) => {
      try {
        const reply = await api.replyToComment(chatId, {
          message,
          versionInternalId,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Reply created (id: ${reply.internalId}): "${reply.message}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to reply: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve Comment',
      description:
        'Mark a comment as resolved. Only the comment author can resolve it.',
      inputSchema: {
        chatId: z.number().describe('Internal ID of the comment to resolve'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ chatId }) => {
      try {
        const comment = await api.resolveComment(chatId);

        return {
          content: [
            {
              type: 'text',
              text: `Comment ${comment.internalId} marked as resolved.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to resolve: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
