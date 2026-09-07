import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import {
  assertChangeHistoryComplete,
  assertEnrollmentComplete,
  isNotReady,
  notReadyToolResult,
} from '../not-ready.js';

export function registerSearchTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'search_files',
    {
      title: 'Search Files',
      description:
        'Search enrolled files by name (default), comment text, version ' +
        'descriptions, or all of the above. Returns matching files with ' +
        'their metadata including uncommitted change status. ' +
        // ENG-1647 / ENG-2200: this search only sees files ALREADY in
        // Rockhopper, and it matches on substrings — so "no match" means "not
        // enrolled", never "no such workbook", and a single match is not proof
        // it is the file the user meant. The customer in ENG-1647 was told
        // their file was already enrolled when a different file had matched,
        // and then that no tool existed to add the real one.
        'Only files ALREADY added to Rockhopper are searched, and matching is ' +
        'by name substring — so a file that does not appear here is very ' +
        'likely one that has never been added, not one that does not exist. ' +
        // ENG-2204: the named next step, because "ask for a link" is a dead
        // end when the user does not have one to hand — which is the ENG-1647
        // customer exactly.
        'When nothing matches, or when the match does not look like the file ' +
        'the user described, call `search_drive_files` — it looks across the ' +
        "user's whole OneDrive and SharePoint, including files Rockhopper has " +
        'never seen. Confirm the pick with the user there, then `enroll_file`. ' +
        // ENG-3402 / plan 28 F20: plan 28's archive predicate lands in the
        // SHARED `GET /enrolled-files` query this tool reads, so "not enrolled"
        // stopped being the only reason a file is absent. The line above is
        // ENG-1647's fix for a confident wrong negative; leaving it as the only
        // explanation re-creates that failure with a new cause.
        'A file this person ARCHIVED is also absent from these results: ' +
        'archive is a per-person hide, the file is still enrolled and still ' +
        'visible to teammates, and it is restored from the archived list in ' +
        'the Rockhopper web app. No tool here archives or restores.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        matchIn: z
          .enum(['name', 'comments', 'versions', 'all'])
          .optional()
          .describe(
            'Where to search: "name" (default — file-name substring), ' +
              '"comments" (comment text on the file), "versions" (committed ' +
              'version descriptions), or "all" (any of the above).',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, matchIn }) => {
      try {
        const files = await api.listEnrolledFiles({
          search: query,
          matchIn,
        });
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
                ? `Found ${files.length} file(s) matching "${query}":\n\n${summary}`
                : // ENG-2200: never leave this as a bare negative. "No files
                  // match" is true of an un-enrolled workbook and of one that
                  // does not exist, and only one of those is a dead end.
                  `No files match "${query}". This searches only files already ` +
                  'added to Rockhopper AND not archived by this person, so ' +
                  'the workbook may never have been added, or it may be one ' +
                  'this person archived. Archive is a per-person hide — the ' +
                  'file stays enrolled and stays visible to teammates — and ' +
                  'it is restored from the archived list in the Rockhopper ' +
                  'web app, the only place archive and restore exist. ' +
                  'If it was never added, call `search_drive_files` with the ' +
                  "same terms to look through the user's own OneDrive and " +
                  'SharePoint, confirm which file they meant, then ' +
                  '`enroll_file`. Ask the user which case it is instead of ' +
                  'reporting that the file does not exist.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_unattributed_changes',
    {
      title: 'Get Unattributed Changes',
      description:
        'Get pending cell-level changes that have not been attributed to a ' +
        'committed version yet. Two modes: (1) provide `sheetName` to get ' +
        'every change on a single worksheet (no pagination — bounded by ' +
        'sheet size); (2) omit `sheetName` for the file-wide cursor-paginated ' +
        'view (rows are capped per response with a summary line; pass `cursor` ' +
        'returned by the previous call to fetch the next page). ' +
        // Plan 02 ruling 5 — "No unattributed changes" is a factual claim, and
        // it is only made after completeness is proven.
        'Answers CHANGE_HISTORY_NOT_READY (isError) while Rockhopper is still ' +
        "computing this file's changes. That is NOT \"no changes\" — retry " +
        'after the stated interval instead of reporting an absence.',
      inputSchema: z.object({
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        sheetName: z
          .string()
          .optional()
          .describe(
            'Filter to a specific worksheet. When set, ignores `cursor` and ' +
              'returns the unpaginated sheet view.',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'Opaque cursor from a previous response\'s pagination hint. ' +
              'Only valid with no `sheetName` (file-wide paginated mode). ' +
              'Snapshot expires 30 minutes after the first request — older ' +
              'cursors return an SNAPSHOT_EXPIRED error and the caller must ' +
              'restart from the first page.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileMsId, sheetName, cursor }) => {
      try {
        // Plan 02 ruling 5 (STRICT): gate BOTH modes. The commit-diff fold
        // retracts and rewrites the uncommitted window, so a pending fold
        // means this list is mid-rewrite in either shape.
        await assertChangeHistoryComplete(api, fileMsId);

        if (sheetName) {
          // Sheet-filtered mode: bounded by sheet size, no pagination needed.
          // Audit (2026-05-23) measured: `Summary` sheet on a 12 MB file
          // returned 9 rows clean. This is the practical workaround when the
          // caller already knows which sheet to drill into.
          const changes = await api.getUnattributedChangesBySheet(
            fileMsId,
            sheetName,
          );
          // ENG-2824: an empty answer is the only ambiguous one, so it is the
          // only one that pays for the version read. A file still being read
          // for the first time has no versions and no parsed cells, and the
          // fold probe above cannot see that state — enrolment enqueues no
          // fold. See `assertEnrollmentComplete`.
          if (changes.length === 0) {
            assertEnrollmentComplete(
              fileMsId,
              await api.getFileVersions(fileMsId),
            );
          }
          const body = formatChangeRows(changes);
          return {
            content: [
              {
                type: 'text',
                text: changes.length
                  ? `${changes.length} unattributed change(s) on sheet "${sheetName}":\n\n${body}`
                  : `No unattributed changes on sheet "${sheetName}".`,
              },
            ],
          };
        }

        // File-wide mode: paginated. Backend caps each page at 1000 rows;
        // we cap display at MAX_DISPLAYED to keep MCP responses under the
        // 25k-token client limit (audit measured one file at 12.5 MB / 28k
        // rows on the unpaginated route — KI-097).
        const MAX_DISPLAYED = 200;
        const page = await api.getUnattributedChangesPaginated(
          fileMsId,
          cursor,
        );

        if (page.changes.length === 0) {
          // ENG-2824 — same rule as the sheet mode above. `totalCount === 0`
          // over a file whose initial read has not landed is a premature
          // absence, not a fact about the workbook.
          if (page.totalCount === 0) {
            assertEnrollmentComplete(
              fileMsId,
              await api.getFileVersions(fileMsId),
            );
          }
          return {
            content: [
              {
                type: 'text',
                text: page.totalCount === 0
                  ? 'No unattributed changes found for this file.'
                  : `End of pages reached (${describeRemainingCount(page.totalCount, cursor)}).`,
              },
            ],
          };
        }

        const displayed = page.changes.slice(0, MAX_DISPLAYED);
        const body = formatChangeRows(displayed);
        const summary = summarizeBySheet(page.changes);
        const hidden = page.changes.length - displayed.length;
        const lines: string[] = [];

        // Header line: this page's slice + total + per-sheet hint
        lines.push(
          `Showing ${displayed.length} of ${page.changes.length} change(s) on this page (${describeRemainingCount(page.totalCount, cursor)}).`,
        );
        if (summary.length > 0) {
          const topSheets = summary
            .slice(0, 5)
            .map((s) => `${s.sheetName} (${s.count})`)
            .join(', ');
          lines.push(`Top sheets on this page: ${topSheets}.`);
        }
        lines.push('');
        lines.push(body);

        // Pagination hints
        const hints: string[] = [];
        if (hidden > 0) {
          hints.push(
            `${hidden} more row(s) on this page not shown (cap is ${MAX_DISPLAYED}). Pass \`sheetName="<name>"\` to drill into a single sheet.`,
          );
        }
        if (page.nextCursor) {
          hints.push(
            `More pages available. Pass \`cursor="${page.nextCursor}"\` to fetch the next page (snapshot valid for 30 minutes).`,
          );
        }
        if (hints.length > 0) {
          lines.push('');
          lines.push(...hints);
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n'),
            },
          ],
        };
      } catch (error) {
        if (isNotReady(error)) return notReadyToolResult(error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get changes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * ENG-4346 - assemble the sentence that describes `totalCount` from the
 * predicate that actually scoped the query.
 *
 * `totalCount` is the number of rows remaining in the snapshot FROM THE
 * CURSOR POSITION ONWARD, inclusive of the page being rendered - not a count
 * over the file. It coincides with a file total only on the unscoped read,
 * where the cursor sits at the start of the snapshot. Measured on staging
 * 2026-09-03 over one snapshot: page 1 reported 1647 and page 2 of that same
 * snapshot reported 647, both rendered as "total across the file".
 *
 * Per `docs/conventions/metric-descriptions.md` the fragment is selected by
 * the predicate that fired - the presence of a cursor - and never written
 * freehand, so a file-wide phrase is emitted ONLY where the query computed a
 * file-wide number. The number itself is never dropped: the size of the
 * change set is what a caller most needs.
 *
 * NOT covered: whether the backend's `totalCount` is itself correct. That is
 * ENG-4338. This assembler describes the value it is handed, faithfully.
 */
function describeRemainingCount(totalCount: number, cursor?: string): string {
  return cursor
    ? `${totalCount} remaining from this page onward`
    : `${totalCount} in this file`;
}

function formatChangeRows(
  changes: ReadonlyArray<{
    sheetName: string;
    cellAddress: string;
    changeType: string;
    oldValue: unknown;
    newValue: unknown;
    byUserPlatformId: string | null;
    /** ENG-2603 — resolved display name; absent on an older backend. */
    byUserName?: string | null;
    createdAt: string;
  }>,
): string {
  return changes
    .map(
      (c) =>
        `- **${c.sheetName}!${c.cellAddress}** (${c.changeType}): ` +
        `${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}` +
        // ENG-2603 — see get-versions: name first, platform id as fallback.
        (c.byUserName ?? c.byUserPlatformId
          ? ` — by ${c.byUserName ?? c.byUserPlatformId}`
          : '') +
        ` — ${c.createdAt}`,
    )
    .join('\n');
}

function summarizeBySheet(
  changes: ReadonlyArray<{ sheetName: string }>,
): Array<{ sheetName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of changes) {
    counts.set(c.sheetName, (counts.get(c.sheetName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([sheetName, count]) => ({ sheetName, count }))
    .sort((a, b) => b.count - a.count);
}
