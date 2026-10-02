import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import { renderEmpty, renderFound } from './list-unenrolled-render.js';

/**
 * ENG-2785 — "which of my workbooks are NOT in Rockhopper yet?"
 *
 * David, 2026-08-19, after driving the enrolment flow: *"list unenrolled files
 * needs to be a command."* Nothing answered it. `list_files` returns the
 * complement — only what is already enrolled. `search_drive_files` needs a name
 * the user already knows, is capped per session on purpose, and funnels every
 * hit into a pick-exactly-one confirmation aimed at enrolling.
 *
 * ## Why this one has no confirmation and no budget
 *
 * It enrols nothing. The pick-one gate on `search_drive_files` exists because
 * that tool's next step WRITES, and the session cap exists because that tool
 * fans out to Microsoft on every call. Neither applies here: this reads stored
 * rows out of Rockhopper's own tables, so browsing is the intended use and a
 * confirmation would only stand between a user and a list.
 *
 * ## Why the answer is safe to return in bulk
 *
 * Every row is an entitlement (ENG-2788). It exists because Microsoft,
 * answering THIS user's own delegated token, disclosed that file to them —
 * recorded with which delegated call and when. A user who cannot open a file
 * has no row for it and learns nothing about it here. That is what makes a
 * bulk list of names permissible on the route ENG-2548 / ENG-2573 / ENG-2578 /
 * ENG-2638 spent a release making impossible to get wrong.
 *
 * ## The failure this file is mostly written against: the EMPTY answer
 *
 * The rows are served without waiting on Microsoft, so a refresh may never have
 * run, may be running now, or may have been failing for a day. All three
 * produce an empty list, and so does "everything you have is already enrolled".
 * Rendering the four identically tells a user their drive is covered when we
 * have simply never looked. So the empty branches read `freshness` and say
 * which one happened.
 */
export function registerListUnenrolledFilesTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'list_unenrolled_files',
    {
      title: 'List Files Not Yet in Rockhopper',
      description:
        'List the files Rockhopper has seen for this user that are NOT ' +
        'enrolled — the answer to "what could I add?". Use this for browsing, ' +
        'when the user cannot name a specific file; use `search_drive_files` ' +
        'when they can. Read-only: it enrolls nothing and asks nothing. The ' +
        'answer comes from stored records rather than a live read of the ' +
        'user\'s drive, so it is dated. ' +
        // ENG-6410 — scope stated up front, because the model has to know it
        // BEFORE it picks the tool. ENG-4283 made this 'MICROSOFT ONLY' and
        // ENG-4958 sent Google callers to `search_drive_files`; ENG-6409 gave
        // the inventory a Google lane, so both are now false.
        'It covers OneDrive and SharePoint (Microsoft) and Google Drive, for ' +
        'whichever of those the user has connected, and every row names its ' +
        'provider. To add a Microsoft row, pass its `msId` and `driveMsId` to ' +
        '`enroll_file`; to add a Google row, pass its link to `enroll_file` as ' +
        '`url`. An account with neither connected gets nothing from it, which ' +
        'is not a statement about what that user has. ' +
        // ENG-4271: an organisation's automatic-enrollment scope governs only
        // which files its own background sweep enrolls on its own; it never
        // stops `enroll_file` from adding any file listed here by hand.
        'Every file here can be enrolled by hand with `enroll_file` — an ' +
        'organisation\'s automatic-enrollment rules only narrow what its own ' +
        'background sweep picks up on its own, never what you can add. ' +
        // ENG-2814. The model has to know a short page is not an answer, or it
        // will report "nothing to add" from the middle of a walk.
        'PAGINATED: a response ending with a cursor has MORE files past it, ' +
        'even when this page came back empty or shorter than `limit` — the ' +
        'filter and the server\'s scan budget both cut pages short. Keep ' +
        'calling with the cursor until no cursor is returned before saying ' +
        'anything about what the user does or does not have. A cursor stops ' +
        'working 30 minutes after the first page; if one is refused as ' +
        'SNAPSHOT_EXPIRED, RESTART from the first page instead of retrying it.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'How many files to return per page, most recently modified ' +
              'first. Defaults to the server\'s page size. NOT a total — the ' +
              'cursor is what reaches the rest.',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'Opaque cursor from a previous response. Never construct or ' +
              'edit one. The snapshot expires 30 minutes after the first ' +
              'page; an older cursor returns a SNAPSHOT_EXPIRED error and the ' +
              'caller must RESTART from the first page rather than retry.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, cursor }) => {
      try {
        const { items, freshness, nextCursor } = await api.listDriveInventory({
          enrollment: 'not_enrolled',
          limit,
          cursor,
        });

        return {
          content: [
            {
              type: 'text',
              text: items.length
                ? renderFound(items, freshness, nextCursor)
                : renderEmpty(freshness, nextCursor),
            },
          ],
        };
      } catch (error) {
        // A backend that could not answer must never render as an empty drive.
        return {
          content: [
            {
              type: 'text',
              text:
                'Could not read the list of un-enrolled workbooks: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Nothing about this user\'s files is known from this call — ' +
                'do not report that they have none.',
            },
          ],
          isError: true,
        };
      }
    },
  );
}
