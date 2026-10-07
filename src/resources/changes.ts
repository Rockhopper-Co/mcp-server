import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import { fileChangesUnavailableText, readFileChanges } from '../file-changes.js';

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
        'Changes since the last saved version: cell changes for a workbook ' +
        '(the paginated envelope), paragraph or shape changes for a document ' +
        'or deck (the document-change window).',
      mimeType: 'application/json',
    },
    async (uri, { fileMsId }) => {
      // KI-097: the resource returns the first page's envelope
      // (`{changes, nextCursor, totalCount, snapshotId}`), not a bare array.
      // ENG-6757: read from the ledger compare routes; each row is the legacy
      // row minus the five bookkeeping fields (`ledger-changes.ts`).
      // Plan 02 ruling 5 (STRICT) — a resource read has no `isError` channel,
      // so an incomplete window must THROW. The SDK renders that as a protocol
      // error, which is the only shape here that cannot be mistaken for an
      // empty change set.
      // ENG-2824 (enrolment) is enforced inside the shared read as well.
      // ENG-6431 — the SAME dispatch `get_unattributed_changes` uses, so a
      // document no longer reads the spreadsheet-only lane and serves
      // `totalCount: 0`. A refusal (unknown type, withheld window) THROWS: a
      // resource has no `isError` channel, and an empty body is the one shape
      // that would be read as "nothing changed".
      const read = await readFileChanges(api, fileMsId as string);
      if (read.kind === 'unavailable') {
        throw new Error(fileChangesUnavailableText(read));
      }
      const body =
        read.kind === 'document'
          ? read.response
          : read.kind === 'spreadsheet'
            ? read.page
            : read.changes;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );
}
