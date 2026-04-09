import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../api-client.js';

export function registerCommentResources(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerResource(
    'file-comments',
    new ResourceTemplate('rockhopper://files/{fileMsId}/comments', {
      list: async () => {
        const files = await api.listEnrolledFiles();
        return {
          resources: files.map((f) => ({
            uri: `rockhopper://files/${f.platformId}/comments`,
            name: `Comments on ${f.name}`,
            mimeType: 'application/json',
          })),
        };
      },
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
