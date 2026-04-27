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
 *   - `createServer(apiClient): McpServer`
 *   - `ApiClient` (class) and `ApiClientConfig` (interface)
 *   - All `types` (Team, EnrolledFile, FileVersion, ...)
 */

export { createServer } from './server.js';
export { type RegisterToolsOptions } from './tools/index.js';
export { ApiClient, type ApiClientConfig } from './api-client.js';
export * from './types.js';
