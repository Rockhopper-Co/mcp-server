import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import { assertChangeHistoryComplete } from '../not-ready.js';

export function registerPrompts(server: McpServer, api: ApiClient): void {
  server.registerPrompt(
    'summarize-file-changes',
    {
      title: 'Summarize Recent Changes',
      description:
        'Summarize recent version changes and unattributed edits for an enrolled file.',
      argsSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      },
    },
    async ({ fileMsId }) => {
      // Plan 02 ruling 5 (STRICT) — a prompt is the highest-risk surface: its
      // whole product is a model narrating these rows as fact. Refuse before
      // assembling anything; a prompt has no error channel but its own throw.
      await assertChangeHistoryComplete(api, fileMsId);

      const [file, versions, changesPage] = await Promise.all([
        api.getEnrolledFile(fileMsId),
        api.getFileVersions(fileMsId),
        // KI-097: switched to cursor-paginated route. Top-of-prompt summary
        // uses `totalCount` for the full file count; the per-cell preview
        // uses up to 20 rows from this first page (sufficient for a recap).
        api.getUnattributedChangesPaginated(fileMsId),
      ]);

      const recentVersions = versions.slice(0, 5);
      const versionSummary = recentVersions
        .map(
          (v) =>
            `- v${v.majorVersion}.${v.minorVersion}.${v.patchVersion}: ${v.description || 'No description'} (${v.createdAt})`,
        )
        .join('\n');

      const changeSummary = changesPage.changes.length
        ? changesPage.changes
            .slice(0, 20)
            .map(
              (c) =>
                `- ${c.sheetName}!${c.cellAddress}: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`,
            )
            .join('\n')
        : 'None';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Summarize the recent activity on the file "${file.name}".\n\n` +
                `## Recent Versions (last ${recentVersions.length} of ${versions.length})\n${versionSummary}\n\n` +
                `## Unattributed Changes (${changesPage.totalCount} total)\n${changeSummary}\n\n` +
                `Provide a concise summary of what has changed recently, who made changes, and any notable patterns.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pending-reviews',
    {
      title: 'Pending Reviews',
      description:
        'Show all pending review requests for the latest version of a file.',
      argsSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      },
    },
    async ({ fileMsId }) => {
      const [file, reviews] = await Promise.all([
        api.getEnrolledFile(fileMsId),
        api.getReviewsForLatestVersion(fileMsId),
      ]);

      const reviewSummary = reviews.length
        ? reviews
            .map(
              (r) =>
                `- "${r.subject}" (status: ${r.status}, id: ${r.id})` +
                (r.requester
                  ? ` — requested by ${r.requester.firstName} ${r.requester.lastName}`
                  : '') +
                (r.description ? `\n  Description: ${r.description}` : ''),
            )
            .join('\n')
        : 'No reviews found for the latest version.';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Show me the status of all review requests for "${file.name}".\n\n` +
                `## Reviews on Latest Version\n${reviewSummary}\n\n` +
                `Summarize the review status: how many are pending, approved, or need attention?`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'unresolved-comments',
    {
      title: 'Unresolved Comments',
      description: 'List all unresolved comments on a file for follow-up.',
      argsSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      },
    },
    async ({ fileMsId }) => {
      const [file, comments] = await Promise.all([
        api.getEnrolledFile(fileMsId),
        api.getFileComments(fileMsId),
      ]);

      const unresolved = comments.filter((c) => !c.resolved);
      const commentSummary = unresolved.length
        ? unresolved
            .map((c) => {
              const author = c.authorName || c.authorEmail || 'Unknown';
              const cell = c.cellReference ? ` [${c.cellReference}]` : '';
              const replyCount = c.replies?.length || 0;
              return (
                `- **${author}**${cell}: "${c.message}" (${c.createdAt})` +
                (replyCount ? ` — ${replyCount} replies` : '')
              );
            })
            .join('\n')
        : 'All comments are resolved!';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `List all unresolved comments on "${file.name}" that need follow-up.\n\n` +
                `## Unresolved Comments (${unresolved.length} of ${comments.length} total)\n${commentSummary}\n\n` +
                `Prioritize these comments by urgency and suggest next steps for each.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'file-overview',
    {
      title: 'File Overview',
      description:
        'Get a comprehensive overview of an enrolled file — versions, comments, reviews, and changes.',
      argsSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
      },
    },
    async ({ fileMsId }) => {
      // Plan 02 ruling 5 (STRICT) — this prompt reports a change COUNT, which
      // is the same factual claim in one number instead of many rows.
      await assertChangeHistoryComplete(api, fileMsId);

      const [file, versions, comments, changesPage] = await Promise.all([
        api.getEnrolledFile(fileMsId),
        api.getFileVersions(fileMsId),
        api.getFileComments(fileMsId),
        // KI-097: switched to cursor-paginated route. The file-overview
        // prompt only displays a total count, so we use `totalCount` from
        // the first page — no need to fetch every row.
        api.getUnattributedChangesPaginated(fileMsId),
      ]);

      const latestVersion = versions[0];
      let reviews: Awaited<
        ReturnType<typeof api.getReviewsForLatestVersion>
      > = [];
      if (latestVersion) {
        reviews = await api.getReviewsForVersion(latestVersion.internalId);
      }

      const unresolvedComments = comments.filter((c) => !c.resolved);
      // Backend's ReviewRequestStatus enum is uppercase (PENDING/APPROVED/CANCELLED).
      // Prior code compared against lowercase 'approved' and a nonexistent 'rejected',
      // so APPROVED + CANCELLED reviews were silently classified as pending (sibling
      // of KI-099). Match positive intent — "pending = PENDING" — with defensive
      // .toUpperCase() so the check survives future backend casing flips.
      const pendingReviews = reviews.filter(
        (r) => r.status?.toUpperCase() === 'PENDING',
      );

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Give me a comprehensive overview of "${file.name}".\n\n` +
                `## File Info\n` +
                `- Type: ${file.fileType}\n` +
                `- Platform ID: ${file.platformId}\n` +
                `- Uncommitted changes: ${file.hasUncommittedChanges ? 'Yes' : 'No'}\n\n` +
                `## Versions: ${versions.length} total\n` +
                (latestVersion
                  ? `Latest: v${latestVersion.majorVersion}.${latestVersion.minorVersion}.${latestVersion.patchVersion} (${latestVersion.createdAt})\n`
                  : 'No versions yet.\n') +
                `\n## Comments: ${comments.length} total, ${unresolvedComments.length} unresolved\n` +
                `## Reviews: ${reviews.length} total, ${pendingReviews.length} pending\n` +
                `## Unattributed Changes: ${changesPage.totalCount}\n\n` +
                `Provide a status report highlighting anything that needs attention.`,
            },
          },
        ],
      };
    },
  );
}
