import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from './api-client.js';
import { runWithCorrelationId } from './correlation.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools, type RegisterToolsOptions } from './tools/index.js';

/**
 * Phase 1.1 / KI-226 — wrap every tool handler in a per-tool-call correlation
 * scope. Intercepting `registerTool` once here (vs. wrapping each of the ~16
 * handlers) means all current and future tools are covered automatically: the
 * handler body runs inside {@link runWithCorrelationId}, so every outbound
 * `ApiClient` call it makes — including multi-call fan-outs like search —
 * shares one `X-Correlation-Id`. The handler callback is always the last
 * positional argument to `registerTool`; the loose casts insulate this seam
 * from the SDK's generic `ToolCallback` union without changing behavior.
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
      runWithCorrelationId(() => handler(...args));
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
      version: '0.1.0',
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
