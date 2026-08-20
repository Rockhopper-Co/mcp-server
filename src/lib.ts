/**
 * Library entry point for `@rockhopper-co/mcp-server`.
 *
 * This file is **side-effect free** — importing the package as a library
 * (e.g. from the remote MCP gateway) gives you the building blocks
 * (`createServer`, `ApiClient`, types) without spawning a stdio server
 * or reading `ROCKHOPPER_TOKEN` from the environment.
 *
 * The CLI entry (the `rockhopper-mcp` bin) is `./cli.js` — running it
 * directly is what spins up the stdio transport. Library consumers
 * should never import `./cli.js`; they should compose `createServer`
 * with their own transport (HTTP, in-memory, etc.).
 *
 * Stable API surface (semver-bound):
 *   - `createServer(apiClient, options?): McpServer`
 *   - `ToolTelemetrySink` (ENG-2823) — where a HOST wants one structured line
 *     per tool call to go. The stdio surface omits it and keeps the local
 *     file, because stdout is the transport there; the gateway supplies its
 *     request logger so the line reaches CloudWatch. The package never picks
 *     a destination, and the event's key set is fixed so no host can widen it
 *     into arguments or content.
 *   - `grantsWriteTools(scope)` — the write allow-list (ENG-2208), exported so
 *     the gateway asks the same question instead of writing a second copy of
 *     the rule that would drift from this one.
 *   - `PAT_CAPABILITIES`, `WRITE_TOOLS_BY_CAPABILITY`, `PENDING_WRITE_TOOLS`
 *     and `resolveCapabilities` (ENG-2212) — the four write families, which
 *     tools each covers, and how a grant is resolved. Exported for the same
 *     reason: the gateway has to answer "which family does this tool need"
 *     BEFORE it builds a server, and a hand-copied list drifts.
 *   - `ApiClient` (class) and `ApiClientConfig` (interface)
 *   - All `types` (Team, EnrolledFile, FileVersion, ...)
 */

export { createServer, type CreateServerOptions } from './server.js';
export {
  type ToolOutcome,
  type ToolTelemetryEvent,
  type ToolTelemetrySink,
} from './tool-telemetry.js';
export {
  grantsWriteTools,
  resolveCapabilities,
  registeredToolsForCapabilities,
  PAT_CAPABILITIES,
  PENDING_WRITE_TOOLS,
  WRITE_TOOLS_BY_CAPABILITY,
  type PatCapability,
  type RegisterToolsOptions,
} from './tools/index.js';
export { ApiClient, type ApiClientConfig } from './api-client.js';
export * from './types.js';
