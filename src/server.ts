import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from './api-client.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools, type RegisterToolsOptions } from './tools/index.js';

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
          'approve_review, update_file_description) require a read-write scoped token. ' +
          'File IDs use the platformId field (e.g. from list_files output).',
    },
  );

  registerResources(server, apiClient);
  registerTools(server, apiClient, options);
  registerPrompts(server, apiClient);

  return server;
}
