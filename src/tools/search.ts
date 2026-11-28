import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import type { ToolAnnotations } from './tool-annotations.js';
import { registerUnattributedChangesTool } from './unattributed-changes.js';

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
        "user's OneDrive and SharePoint, or their Google Drive, including " +
        'files Rockhopper has never seen. Confirm the pick with the user there, then `enroll_file`. ' +
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
        destructiveHint: false,
        openWorldHint: false,
      } satisfies ToolAnnotations,
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

  // Registered from its own module (file cap); order is unchanged.
  registerUnattributedChangesTool(server, api);
}
