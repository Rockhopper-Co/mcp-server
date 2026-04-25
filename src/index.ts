/**
 * Default entry point. Re-exports the public library API from `./lib`.
 *
 * The CLI lives at `./cli.js` (the `rockhopper-mcp` bin). Importing
 * this module is side-effect free; it does NOT start a stdio server.
 *
 * @see ./lib.ts for the canonical export list.
 * @see ./cli.ts for the stdio CLI entrypoint.
 */
export * from './lib.js';
