import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import { assertEnrollmentComplete } from '../not-ready.js';

export function registerVersionResources(
  server: McpServer,
  api: ApiClient,
): void {
  // KI-078 (ENG-1381): template only, no per-file expansion into resources/list.
  server.registerResource(
    'file-versions',
    new ResourceTemplate('rockhopper://files/{fileMsId}/versions', {
      list: undefined,
    }),
    {
      title: 'File Version History',
      description: 'All version snapshots for a specific enrolled file',
      mimeType: 'application/json',
    },
    async (uri, { fileMsId }) => {
      const versions = await api.getFileVersions(fileMsId as string);
      // ENG-2824 — a resource read has no `isError` channel, so the
      // freshly-enrolled state THROWS here for the same reason the change
      // resource does: `[]` rendered as JSON is indistinguishable from a file
      // that genuinely has no versions, and no enrolled file ever does.
      assertEnrollmentComplete(fileMsId as string, versions);
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
