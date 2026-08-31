import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';

export function registerFileResources(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerResource(
    'enrolled-files',
    'rockhopper://files',
    {
      title: 'Enrolled Files',
      // ENG-3402 / plan 28 F20 — same shared `GET /enrolled-files` query as
      // `list_files`, so the same archive exclusion applies and the same
      // overclaim ("All Excel files enrolled") was here too. A resource
      // description is read by the model before it ever fetches the JSON.
      description:
        'The Excel files enrolled in the current user\'s Rockhopper ' +
        'workspace, excluding any this person has archived. Archive is a ' +
        'per-person hide — an archived file is still enrolled and still ' +
        'visible to teammates — and it is restored from the archived list in ' +
        'the Rockhopper web app. Same data as the `list_files` tool.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const files = await api.listEnrolledFiles();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(files, null, 2),
          },
        ],
      };
    },
  );

  // KI-078 (ENG-1381): the per-file template no longer enumerates `resources/list`.
  // It is exposed via `resources/templates/list` so AI clients learn the URI pattern;
  // concrete instances are read by URI on demand (e.g. `rockhopper://files/abc123`).
  // The workspace-level `rockhopper://files` listing above is the discovery entry point.
  server.registerResource(
    'enrolled-file',
    new ResourceTemplate('rockhopper://files/{fileMsId}', {
      list: undefined,
    }),
    {
      title: 'Enrolled File Details',
      description: 'Details for a specific enrolled file by its platform ID',
      mimeType: 'application/json',
    },
    async (uri, { fileMsId }) => {
      const file = await api.getEnrolledFile(fileMsId as string);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(file, null, 2),
          },
        ],
      };
    },
  );
}
