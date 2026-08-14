import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import { registerListFilesTool } from './list-files.js';
import { registerGetVersionsTool } from './get-versions.js';
import { registerGetCommentsTool } from './get-comments.js';
import { registerGetReviewsTool } from './get-reviews.js';
import { registerGetCellHistoryTool } from './get-cell-history.js';
import { registerSearchTool } from './search.js';
import { registerWriteCommentTools } from './write-comments.js';
import { registerWriteReviewTools } from './write-reviews.js';
import { registerWriteVersionTools } from './write-versions.js';
import { registerWriteFileTool } from './write-files.js';

export interface RegisterToolsOptions {
  /**
   * The scope the presenting token reports about itself — `/users/me`'s
   * `patScope` (ENG-2205). Typed as a bare string, not the two-value union,
   * because it arrives off the wire from a `varchar(20)` column: a value this
   * package has never heard of is REACHABLE, and pretending otherwise in the
   * type system is what made the old `!==` test look safe.
   *
   * Known values: `'read-only'` | `'read-write'`. Anything else — including
   * absent — grants no write tools. See {@link grantsWriteTools}.
   */
  scope?: string;
}

/**
 * The scope values that grant the nine write tools.
 *
 * ENG-2208 — an ALLOW-LIST. The previous gate was `scope !== 'read-only'`,
 * which is fail-OPEN: every value except one literal registered every write
 * tool, so `undefined` (the CLI passed no options at all) and any future or
 * mistyped scope string handed an agent the ability to discard a customer's
 * uncommitted work. Adding a scope value to the vocabulary must never be a
 * privilege escalation, and ENG-2211 is about to add four.
 */
const WRITE_SCOPES: ReadonlySet<string> = new Set(['read-write']);

/** Whether `scope` is on the write allow-list. Unknown and absent both deny. */
export function grantsWriteTools(scope: string | undefined): boolean {
  return scope !== undefined && WRITE_SCOPES.has(scope);
}

export function registerTools(
  server: McpServer,
  api: ApiClient,
  options?: RegisterToolsOptions,
): void {
  // Read tools — the floor every scope gets, including an unrecognised one.
  registerListFilesTool(server, api);
  registerGetVersionsTool(server, api);
  registerGetCommentsTool(server, api);
  registerGetReviewsTool(server, api);
  registerGetCellHistoryTool(server, api);
  registerSearchTool(server, api);

  // Write tools — only for a scope on the allow-list.
  if (grantsWriteTools(options?.scope)) {
    registerWriteCommentTools(server, api);
    registerWriteReviewTools(server, api);
    registerWriteVersionTools(server, api);
    registerWriteFileTool(server, api);
  }
}
