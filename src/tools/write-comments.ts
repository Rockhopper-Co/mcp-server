import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import { renderMentions } from '../mentions.js';
import {
  commentLocation,
  isTaskPanePresentationId,
} from '../comment-location.js';

/**
 * ENG-6435 — the kinds backend `comment-anchor.ts!COMMENT_ANCHOR_KINDS`
 * admits for a comment: Word's text units, then PowerPoint's slide and shape.
 * A spreadsheet admits none and keeps `cellReference`.
 */
const COMMENT_ANCHOR_KINDS = [
  'block',
  'run',
  'section',
  'table',
  'image',
  'document',
  'slide',
  'shape',
] as const;

// ENG-5892: `.min(1)`, never `.positive()` — the latter renders a numeric
// exclusiveMinimum, which Copilot Studio crashes on.
const commentAnchorSchema = z
  .object({
    anchorKind: z
      .enum(COMMENT_ANCHOR_KINDS)
      .describe(
        'block for a Word paragraph; slide or shape for PowerPoint. ' +
          'Use the row kind get_unattributed_changes returned.',
      ),
    providerAnchorId: z
      .string()
      .min(1)
      .describe(
        'The anchorProviderId from a get_unattributed_changes row, echoed ' +
          'verbatim. Never build or edit one.',
      ),
    observedVersionInternalId: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Internal ID of the committed file version you read this paragraph, ' +
          'slide or shape in. Recorded once and never changed, so send it ' +
          'whenever you know it.',
      ),
  })
  .optional()
  .describe(
    'Pins the comment to a paragraph, slide or shape of a Word or PowerPoint ' +
      'file. Spreadsheets use cellReference instead.',
  );

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
      inputSchema: z.object({
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
        anchor: commentAnchorSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ fileMsId, message, cellReference, versionInternalId, anchor }) => {
      if (anchor && isTaskPanePresentationId(anchor.providerAnchorId)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Failed to add comment: "${anchor.providerAnchorId}" is not a ` +
                'slide or shape id a comment can be pinned to. Add the comment ' +
                'without an anchor instead.',
            },
          ],
          isError: true,
        };
      }
      try {
        const comment = await api.createComment({
          fileMsId,
          message,
          cellReference,
          versionInternalId,
          ...(anchor ? { anchor } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text:
                `Comment created (id: ${comment.internalId}):\n` +
                `"${renderMentions(comment.message)}"` +
                (comment.cellReference
                  ? ` at ${comment.cellReference}`
                  : commentLocation(comment)),
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
      inputSchema: z.object({
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
      }),
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
              text: `Reply created (id: ${reply.internalId}): "${renderMentions(reply.message)}"`,
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
      inputSchema: z.object({
        chatId: z.number().describe('Internal ID of the comment to resolve'),
      }),
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
