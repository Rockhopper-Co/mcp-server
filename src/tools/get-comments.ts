import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import type { FileChat } from '../types.js';

function formatComment(c: FileChat, indent = 0): string {
  const prefix = '  '.repeat(indent);
  const author = c.authorName || c.authorEmail || 'Unknown';
  const cell = c.cellReference ? ` [${c.cellReference}]` : '';
  const resolved = c.resolved ? ' (resolved)' : '';
  let line = `${prefix}- **${author}**${cell}${resolved}: ${c.message} — ${c.createdAt}`;
  if (c.replies?.length) {
    line += '\n' + c.replies.map((r) => formatComment(r, indent + 1)).join('\n');
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
        const comments = await api.getFileComments(fileMsId);
        const summary = comments.map((c) => formatComment(c)).join('\n');

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
