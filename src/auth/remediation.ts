import type { AuthSource } from './resolve-auth.js';

/**
 * ENG-4222 — WHAT TO DO NEXT, NAMED FOR THE CREDENTIAL THE USER ACTUALLY HOLDS.
 *
 * The mid-session 401 handler used to branch on nothing and tell everybody to
 * "Create a new Personal Access Token in Rockhopper Settings". A user who set
 * the server up the way the README recommends never created one — they signed
 * in through a browser — so it sent them to mint a credential they do not need
 * when the remedy was to restart and re-approve.
 *
 * That is not an edge case: the device grant's token is minted with a
 * 60-minute life and has no refresh endpoint, so every session that outlives
 * an hour reaches the mid-session message by design.
 *
 * LIVES IN ITS OWN MODULE so it can be tested as a pure function. `cli.ts` is
 * an entry script with top-level await — importing it to reach this branch
 * runs logger init and auth resolution, which is why the tests that do that
 * need `vi.doMock` and are order-sensitive under load. A string chosen from an
 * enum needs none of that.
 *
 * Keep this the ONLY place the mid-session remediation sentence is written.
 * The preflight path at `cli.ts` deliberately keeps its own wording: its PAT
 * arm names the `ROCKHOPPER_TOKEN` env var rather than a restart, so routing
 * it through here would make correct copy worse.
 */
export function remediationFor(source: AuthSource): string {
  return source === 'pat'
    ? 'Create a new Personal Access Token in Rockhopper Settings and restart this MCP server.'
    : 'Restart this MCP server — it will run the browser sign-in again.';
}
