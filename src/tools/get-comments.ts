import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import type { FileChat } from '../types.js';
import { renderMentions } from '../mentions.js';
import { commentLocation } from '../comment-location.js';
import type { ToolAnnotations } from './tool-annotations.js';

function formatComment(c: FileChat, indent = 0, fileType?: string): string {
  const prefix = '  '.repeat(indent);
  const author = c.authorName || c.authorEmail || 'Unknown';
  const cell = commentLocation(c, fileType);
  const resolved = c.resolved ? ' (resolved)' : '';
  // ENG-4345 — `reply_to_comment` and `resolve_comment` take this id as their
  // `chatId`, and this is the only place a caller can read one for a thread it
  // did not create itself. Same `(id: N)` shape `add_comment` answers with.
  let line = `${prefix}- **${author}**${cell}${resolved}: ${renderMentions(c.message)} — ${c.createdAt} (id: ${c.internalId})`;
  if (c.replies?.length) {
    line += '\n' + c.replies.map((r) => formatComment(r, indent + 1, fileType)).join('\n');
  }
  return line;
}

export function registerGetCommentsTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_file_comments',
    {
      title: 'Get File Comments',
      description:
        'Get all comments and discussion threads on an enrolled file. ' +
        'Includes cell references, resolution status, and threaded replies.',
      inputSchema: z.object({
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // Every read starts a native-comment import from Graph or Drive:
        // backend file-chat.service.ts!triggerNativeCommentImport.
        openWorldHint: true,
      } satisfies ToolAnnotations,
    },
    async ({ fileMsId }) => {
      try {
        const comments = await api.getFileComments(fileMsId);
        // The file type decides how a location reads (a Smartsheet comment
        // sits on a row). Best effort: without it the generic label is used.
        const fileType = await api
          .getEnrolledFile(fileMsId)
          .then((f) => f.fileType)
          .catch(() => undefined);
        const summary = comments
          .map((c) => formatComment(c, 0, fileType))
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: comments.length
                ? `${comments.length} comment thread(s):\n\n${summary}`
                : 'No comments on this file.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get comments: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
