import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../api-client.js';

export function registerVersionResources(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerResource(
    'file-versions',
    new ResourceTemplate('rockhopper://files/{fileMsId}/versions', {
      list: async () => {
        const files = await api.listEnrolledFiles();
        return {
          resources: files.map((f) => ({
            uri: `rockhopper://files/${f.platformId}/versions`,
            name: `Versions of ${f.name}`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'File Version History',
      description: 'All version snapshots for a specific enrolled file',
      mimeType: 'application/json',
    },
    async (uri, { fileMsId }) => {
      const versions = await api.getFileVersions(fileMsId as string);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(versions, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'file-version',
    new ResourceTemplate('rockhopper://versions/{versionId}', {
      list: undefined,
    }),
    {
      title: 'Version Details',
      description: 'Details for a specific file version by internal ID',
      mimeType: 'application/json',
    },
    async (uri, { versionId }) => {
      const version = await api.getFileVersion(Number(versionId));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(version, null, 2),
          },
        ],
      };
    },
  );
}
