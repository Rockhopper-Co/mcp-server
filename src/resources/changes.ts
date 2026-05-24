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
      // KI-097: switched to cursor-paginated route. Resource returns the
      // full envelope (`{changes, nextCursor, totalCount, snapshotId, ...}`)
      // so consumers can paginate by re-reading the resource with a
      // different cursor — though most clients will treat this as a
      // single read. Resource shape is now the paginated envelope, not
      // a bare array.
      const page = await api.getUnattributedChangesPaginated(
        fileMsId as string,
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  );
}
