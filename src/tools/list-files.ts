import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

/**
 * ENG-3402 (plan 28 / REVIEW F20) — what this list is NOT.
 *
 * Plan 28's archive predicate lands inside the shared `GET /enrolled-files`
 * query, beside the `unenrolledAt IS NULL` that already sits there
 * (`backend enrolled-files.service.ts:2008`). One predicate, four readers: the
 * web file list, this tool, `search_files`, and the `rockhopper://files`
 * resource. So the moment it ships, an archived file drops out of the agent
 * surface with no tool able to see it or put it back — David ruled archive a
 * WEB-ONLY affordance (2026-08-25, REVIEW decision 6(a)), which is a fine
 * ruling and leaves this package holding the disclosure.
 *
 * The defect was never the exclusion. It was the copy: this description used
 * to open "List **all** Excel files enrolled", which is how a model tells a
 * customer they have no such file about a file that exists, is enrolled, is
 * still being tended, and is on every teammate's list. Same shape as ENG-1647,
 * where a confident negative sent a customer away.
 *
 * The wire response cannot tell the two apart — an archived file and a file
 * nobody ever added are both simply absent — so the copy below names BOTH and
 * gives each its own way back. Neither is a dead end and the model must not
 * pick one and assert it.
 */
const ARCHIVE_DISCLOSURE =
  'This list is scoped to this ONE person and is not everything the team ' +
  'tracks: files this person has archived are excluded from it, and so are ' +
  'files nobody has added to Rockhopper yet. An archived file is still ' +
  'enrolled, still tracked, and still visible to teammates — archive only ' +
  'hides it from this person\'s own list, and it is restored from the ' +
  'archived list in the Rockhopper web app. There is no archive or restore ' +
  'tool here. Never report a file as missing, deleted or un-enrolled on the ' +
  'strength of its absence from this list.';

/** The empty answer, which is the only ambiguous one. See above. */
function emptyAnswer(search?: string): string {
  return (
    (search
      ? `No enrolled files match "${search}".`
      : 'No enrolled files found.') +
    ' That is not proof the file does not exist. Two things are hidden from ' +
    'this list: files this person ARCHIVED (still enrolled, still visible to ' +
    'teammates — restored from the archived list in the Rockhopper web app, ' +
    'which is the only place archive and restore live), and files never added ' +
    'to Rockhopper at all (call `list_unenrolled_files`, or ' +
    '`search_drive_files` with the name the user gave, then `enroll_file`). ' +
    'Ask the user which it is rather than reporting an absence.'
  );
}

export function registerListFilesTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'list_files',
    {
      title: 'List Enrolled Files',
      description:
        'List the Excel files enrolled in the user\'s Rockhopper workspace. ' +
        'Optionally filter by search term matching file names. ' +
        ARCHIVE_DISCLOSURE,
      inputSchema: z.object({
        search: z.string().optional().describe('Search term to filter file names'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ search }) => {
      try {
        const files = await api.listEnrolledFiles({ search });
        const summary = files
          .map(
            (f) =>
              `- **${f.name}** (id: ${f.platformId}, type: ${f.fileType})` +
              (f.hasUncommittedChanges ? ' [uncommitted changes]' : ''),
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: files.length
                ? `Found ${files.length} file(s):\n\n${summary}`
                : emptyAnswer(search),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list files: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
