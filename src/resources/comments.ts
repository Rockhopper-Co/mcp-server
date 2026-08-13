import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';

export function registerCommentResources(
  server: McpServer,
  api: ApiClient,
): void {
  // KI-078 (ENG-1381): template only, no per-file expansion into resources/list.
  server.registerResource(
    'file-comments',
    new ResourceTemplate('rockhopper://files/{fileMsId}/comments', {
      list: undefined,
    }),
    {
      title: 'File Comments',
      description:
        'All comments and chat threads on a specific enrolled file',
      mimeType: 'application/json',
    },
    async (uri, { fileMsId }) => {
      const comments = await api.getFileComments(fileMsId as string);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(comments, null, 2),
          },
        ],
      };
    },
  );
}
