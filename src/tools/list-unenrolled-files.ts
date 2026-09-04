import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import {
  GRAPH_LINK_FAILURE_TEXT,
  graphLinkFailureFrom,
} from '../graph-link-failure.js';
import type {
  DriveInventoryFreshness,
  DriveInventoryItem,
} from '../types.js';

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
      title: 'List Workbooks Not Yet in Rockhopper',
      description:
        'List the spreadsheets Rockhopper has seen for this user that are ' +
        'NOT enrolled — the answer to "what could I add?". Use this for ' +
        'browsing, when the user cannot name a specific file; use ' +
        '`search_drive_files` when they can. Read-only: it enrolls nothing ' +
        'and asks nothing. The answer comes from stored records rather than a ' +
        'live Microsoft read, so it is dated — pass a listed file\'s `msId` ' +
        'and `driveMsId` to `enroll_file` to add it. ' +
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

/**
 * ENG-2814 — the "there is more" line, and it is never optional when a cursor
 * came back.
 *
 * Written to the MODEL, not the user: it names the exact next call, because a
 * hint that only says "more available" gets summarised away and the walk stops
 * one page in.
 */
function moreToCome(nextCursor: string | null): string {
  if (!nextCursor) return '';
  return (
    `\n\nMORE FILES REMAIN — this is not the whole list. Call ` +
    `\`list_unenrolled_files\` again with \`cursor="${nextCursor}"\`, and ` +
    'keep going until a response comes back with no cursor. Do not tell the ' +
    'user what they do or do not have until then. The cursor stops working 30 ' +
    'minutes after the first page; if it is refused as expired, start again ' +
    'from the first page rather than retrying it.'
  );
}

function renderFound(
  items: readonly DriveInventoryItem[],
  freshness: DriveInventoryFreshness,
  nextCursor: string | null = null,
): string {
  const lines = items.map((item) => {
    const where = item.parentPath ? ` in ${item.parentPath}` : '';
    const modified = item.lastModifiedAt
      ? `, modified ${item.lastModifiedAt}`
      : '';
    // `hidden` means the user REMOVED this file from Rockhopper before. Its
    // history is still held, so enrolling restores rather than duplicates —
    // a different next step from a file that was never added, and the only
    // thing distinguishing the two.
    const previously =
      item.enrollmentState === 'hidden' ? ' [previously removed]' : '';
    return (
      `- **${item.name}**${where}${modified}${previously}\n` +
      `  msId: ${item.msId}, driveMsId: ${item.driveMsId}`
    );
  });

  // "on this page", never a bare count: with a cursor outstanding the number is
  // a page size, and calling it a total is the same lie as the old 200-row
  // ceiling that reported nothing about itself.
  const counted = nextCursor
    ? `${items.length} workbook(s) not yet in Rockhopper on this page:`
    : `${items.length} workbook(s) not yet in Rockhopper:`;

  return (
    `${counted}\n\n` +
    `${lines.join('\n')}\n\n${dateline(freshness)}${moreToCome(nextCursor)}`
  );
}

function renderEmpty(
  freshness: DriveInventoryFreshness,
  nextCursor: string | null = null,
): string {
  // ORDER IS LOAD-BEARING. A broken link and a first refresh that has not
  // finished both mean there is nothing to page THROUGH, so sending the model
  // after another page instead of `connect_microsoft` starts a loop that cannot
  // end. Those two branches come first and keep their own instruction.
  //
  // ENG-4311 — this used to compare `lastFailureReason === 'no_delegated_token'`
  // against a producer that writes the SCREAMING_SNAKE `GraphLinkFailure` enum,
  // so it never matched and this branch was dead: a user with no working link
  // fell through to the never-refreshed message below and was told a scan had
  // been started and to try again shortly. Neither was true. The four codes are
  // kept APART rather than collapsed, because three of them name a different
  // person who has to act — see `graph-link-failure.ts`.
  const linkFailure = graphLinkFailureFrom(freshness.lastFailureReason);
  if (linkFailure) return GRAPH_LINK_FAILURE_TEXT[linkFailure];

  if (!freshness.asOf) {
    return (
      'No answer yet — the first scan of this user\'s drive has not finished. ' +
      `${freshness.refreshing ? 'One is running now.' : 'One has been started.'} ` +
      'Try again shortly. This is NOT evidence that every workbook is already ' +
      `in Rockhopper.${failureNote(freshness)}`
    );
  }

  /**
   * ENG-2814 — AN EMPTY PAGE WITH A CURSOR IS THE MIDDLE OF A WALK.
   *
   * The backend filters enrolled rows out AFTER cutting a chunk and stops at a
   * per-request scan budget, so "this page had none" is routine and says
   * nothing about the drive. Reporting it as "everything is already covered" is
   * the exact failure this whole tool was written against — an empty list that
   * reads as reassurance — and pagination gives it a brand new way to happen.
   */
  if (nextCursor) {
    return (
      'No un-enrolled workbooks on this page — but the search is NOT ' +
      'finished, and this says nothing yet about what the user has.' +
      `${moreToCome(nextCursor)}`
    );
  }

  if (freshness.consecutiveFailures > 0) {
    return (
      'No un-enrolled workbooks in the stored list, but the list is not ' +
      `trustworthy right now.${failureNote(freshness)}\n\n${dateline(freshness)}`
    );
  }

  return (
    'Every workbook Rockhopper has seen for this user is already in ' +
    `Rockhopper.\n\n${dateline(freshness)}`
  );
}

/**
 * How old the answer is, on every branch that has an answer.
 *
 * Never omitted: the rows are stored, so a surface that does not date them
 * invites a user to conclude a file is absent from their drive when it is only
 * absent from our last refresh.
 */
function dateline(freshness: DriveInventoryFreshness): string {
  const asOf = freshness.asOf
    ? `As of ${freshness.asOf}`
    : 'Never successfully refreshed';
  const stale = freshness.stale ? ' (stale)' : '';
  const refreshing = freshness.refreshing
    ? ' A refresh is running; call again for a newer answer.'
    : '';
  return (
    `${asOf}${stale} — from Rockhopper's stored records, not a live ` +
    `Microsoft read.${refreshing}${failureNote(freshness)}`
  );
}

function failureNote(freshness: DriveInventoryFreshness): string {
  if (!freshness.consecutiveFailures || !freshness.lastFailureAt) return '';
  return (
    ` Refresh has failed ${freshness.consecutiveFailures} time(s) in a row, ` +
    `last at ${freshness.lastFailureAt}` +
    `${freshness.lastFailureReason ? ` (${freshness.lastFailureReason})` : ''}.`
  );
}
