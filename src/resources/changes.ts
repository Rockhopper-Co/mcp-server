import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import {
  assertChangeHistoryComplete,
  assertEnrollmentComplete,
} from '../not-ready.js';

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
      // Plan 02 ruling 5 (STRICT) — a resource read has no `isError` channel,
      // so an incomplete window must THROW. The SDK renders that as a protocol
      // error, which is the only shape here that cannot be mistaken for an
      // empty change set.
      await assertChangeHistoryComplete(api, fileMsId as string);

      const page = await api.getUnattributedChangesPaginated(
        fileMsId as string,
      );
      // ENG-2824 — the fold probe above cannot see a file that is still being
      // read for the first time (enrolment enqueues no fold), so an empty
      // envelope is checked against the version list before it is served.
      if (page.totalCount === 0) {
        assertEnrollmentComplete(
          fileMsId as string,
          await api.getFileVersions(fileMsId as string),
        );
      }
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
