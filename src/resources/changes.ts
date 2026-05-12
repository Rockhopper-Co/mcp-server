import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../api-client.js';

export function registerChangeResources(
  server: McpServer,
  api: ApiClient,
): void {
  // KI-078 (ENG-1381): template only, no per-file expansion into resources/list.
  // Previously this enumerated only files with `hasUncommittedChanges === true` —
  // a per-call API request that scaled linearly with file count.
  server.registerResource(
    'unattributed-changes',
    new ResourceTemplate('rockhopper://files/{fileMsId}/changes', {
      list: undefined,
    }),
    {
      title: 'Unattributed Changes',
      description:
        'Pending cell-level changes not yet attributed to a version for a file',
      mimeType: 'application/json',
    },
    async (uri, { fileMsId }) => {
      const changes = await api.getUnattributedChanges(fileMsId as string);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(changes, null, 2),
          },
        ],
      };
    },
  );
}
