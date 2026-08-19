import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
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
        'and `driveMsId` to `enroll_file` to add it.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'How many files to return, most recently modified first. ' +
              'Defaults to the server\'s page size.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }) => {
      try {
        const { items, freshness } = await api.listDriveInventory({
          enrollment: 'not_enrolled',
          limit,
        });

        return {
          content: [
            {
              type: 'text',
              text: items.length
                ? renderFound(items, freshness)
                : renderEmpty(freshness),
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

function renderFound(
  items: readonly DriveInventoryItem[],
  freshness: DriveInventoryFreshness,
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

  return (
    `${items.length} workbook(s) not yet in Rockhopper:\n\n` +
    `${lines.join('\n')}\n\n${dateline(freshness)}`
  );
}

function renderEmpty(freshness: DriveInventoryFreshness): string {
  if (freshness.lastFailureReason === 'no_delegated_token') {
    return (
      'Rockhopper cannot see this user\'s workbooks: their Microsoft account ' +
      'is not linked. Run `connect_microsoft` first — this list will be empty ' +
      'until it is, which is not the same as having nothing to add.'
    );
  }

  if (!freshness.asOf) {
    return (
      'No answer yet — the first scan of this user\'s drive has not finished. ' +
      `${freshness.refreshing ? 'One is running now.' : 'One has been started.'} ` +
      'Try again shortly. This is NOT evidence that every workbook is already ' +
      `in Rockhopper.${failureNote(freshness)}`
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
