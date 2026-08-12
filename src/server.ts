import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from './api-client.js';
import { runWithCorrelationId } from './correlation.js';
import { log, serviceVersion } from './logger.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools, type RegisterToolsOptions } from './tools/index.js';

/**
 * Phase 1.1 / KI-226 + Phase 1.5 / KI-225 — wrap every tool handler once.
 * Intercepting `registerTool` here (vs. wrapping each of the ~16 handlers)
 * means all current and future tools are covered automatically. The wrapper:
 *   - runs the handler inside {@link runWithCorrelationId}, so every outbound
 *     `ApiClient` call it makes — including multi-call fan-outs like search —
 *     shares one `X-Correlation-Id` (1.1), and
 *   - times the handler and logs a `tool_call` / `tool_call_failed` line to
 *     the local diagnostic file (1.5). Only the tool NAME is logged — never
 *     the tool arguments, which may carry file refs / PII.
 * The handler callback is always the last positional argument to
 * `registerTool`; the loose casts insulate this seam from the SDK's generic
 * `ToolCallback` union. On a handler throw we log then re-throw — behavior
 * (the error surfacing to the SDK) is preserved.
 */
function installCorrelationScope(server: McpServer): void {
  const baseRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: unknown,
    cb: unknown,
  ): ReturnType<typeof baseRegisterTool> => {
    const handler = cb as (...args: unknown[]) => unknown;
    const wrapped = (...args: unknown[]): unknown =>
      runWithCorrelationId(async () => {
        const start = Date.now();
        try {
          const result = await handler(...args);
          log.info(
            { event: 'tool_call', tool: name, durationMs: Date.now() - start, outcome: 'ok' },
            'tool_call',
          );
          return result;
        } catch (err) {
          log.error(
            { event: 'tool_call_failed', tool: name, durationMs: Date.now() - start, err },
            'tool_call_failed',
          );
          throw err;
        }
      });
    return (
      baseRegisterTool as (
        name: string,
        config: unknown,
        cb: unknown,
      ) => ReturnType<typeof baseRegisterTool>
    )(name, config, wrapped);
  }) as typeof server.registerTool;
}

export function createServer(
  apiClient: ApiClient,
  options?: RegisterToolsOptions,
): McpServer {
  const readOnly = options?.scope === 'read-only';

  const server = new McpServer(
    {
      name: 'rockhopper',
      // ENG-1955: read from package.json (see logger.ts) so the version a
      // client sees in `initialize` is the version it is actually running.
      version: serviceVersion,
    },
    {
      instructions: readOnly
        ? 'Rockhopper MCP server for reading Excel file metadata. ' +
          'Use list_files first to discover available files, then drill into ' +
          'versions, comments, reviews, or cell history. ' +
          'This token is read-only — write operations are not available. ' +
          'File IDs use the platformId field (e.g. from list_files output).'
        : 'Rockhopper MCP server for managing Excel file metadata. ' +
          'Use list_files first to discover available files, then drill into ' +
          'versions, comments, reviews, or cell history. Write operations ' +
          '(add_comment, reply_to_comment, resolve_comment, create_review_request, ' +
          'approve_review, cancel_review, create_version, discard_changes, ' +
          'rename_file) require a read-write scoped token. ' +
          'File IDs use the platformId field (e.g. from list_files output).',
    },
  );

  installCorrelationScope(server);
  registerResources(server, apiClient);
  registerTools(server, apiClient, options);
  registerPrompts(server, apiClient);

  return server;
}
