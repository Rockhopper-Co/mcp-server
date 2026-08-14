import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import {
  CAPABILITY_SET,
  PAT_CAPABILITIES,
  type PatCapability,
} from '../capabilities.js';
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

export {
  PAT_CAPABILITIES,
  PENDING_WRITE_TOOLS,
  WRITE_TOOLS_BY_CAPABILITY,
  registeredToolsForCapabilities,
  type PatCapability,
} from '../capabilities.js';

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
   *
   * Ignored when {@link capabilities} is supplied.
   */
  scope?: string;
  /**
   * ENG-2212 — the write families the token holds (`/users/me`'s `patScopes`).
   * THIS is the authority when present; `scope` is one bit that cannot tell a
   * token that may draft a comment from one that may discard a person's
   * uncommitted work.
   *
   * Bare strings for the same reason as `scope`: the values arrive off the
   * wire and an unrecognised one must grant nothing rather than everything.
   *
   * ABSENT and EMPTY are deliberately different. Absent means the backend said
   * nothing about families — a deploy older than ENG-2211 — and the coarse
   * scope decides. Empty means the caller named no families, and no coarse
   * scope re-widens it. Same polarity as the backend's `resolveGrant`.
   */
  capabilities?: readonly string[];
}

/**
 * The scope values that grant every write family.
 *
 * ENG-2208 — an ALLOW-LIST. The previous gate was `scope !== 'read-only'`,
 * which is fail-OPEN: every value except one literal registered every write
 * tool, so `undefined` (the CLI passed no options at all) and any future or
 * mistyped scope string handed an agent the ability to discard a customer's
 * uncommitted work. Adding a scope value to the vocabulary must never be a
 * privilege escalation.
 */
const WRITE_SCOPES: ReadonlySet<string> = new Set(['read-write']);

/** Whether `scope` is on the write allow-list. Unknown and absent both deny. */
export function grantsWriteTools(scope: string | undefined): boolean {
  return scope !== undefined && WRITE_SCOPES.has(scope);
}

/**
 * The write families this launch actually grants.
 *
 * Families-first, matching the backend's `resolveGrant`: a caller that names
 * families gets exactly those, and a coarse `scope` alongside is ignored rather
 * than allowed to widen them. Unknown strings are dropped, duplicates are
 * collapsed, and the result is in `PAT_CAPABILITIES` order so two equivalent
 * grants render identically.
 */
export function resolveCapabilities(
  options?: RegisterToolsOptions,
): PatCapability[] {
  if (options?.capabilities !== undefined) {
    const named = new Set(
      options.capabilities.filter((c): c is PatCapability =>
        CAPABILITY_SET.has(c),
      ),
    );
    return PAT_CAPABILITIES.filter((c) => named.has(c));
  }
  return grantsWriteTools(options?.scope) ? [...PAT_CAPABILITIES] : [];
}

const REGISTRARS: Readonly<
  Record<PatCapability, (server: McpServer, api: ApiClient) => void>
> = {
  'comments:write': registerWriteCommentTools,
  'reviews:write': registerWriteReviewTools,
  'versions:write': registerWriteVersionTools,
  'files:write': registerWriteFileTool,
};

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

  // Write tools — one registrar per granted family, so a token holding
  // `comments:write` alone cannot reach `discard_changes`.
  for (const capability of resolveCapabilities(options)) {
    REGISTRARS[capability](server, api);
  }
}
