import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { createServer } from '../../server.js';
import {
  startMockRockhopperApiServer,
  stopMockRockhopperApiServer,
} from './harness/mock-rockhopper-api-server.js';

/**
 * In-process end-to-end test. Spins up:
 *   - the real `McpServer` (from `createServer`) with all tools/resources/prompts wired,
 *   - an `ApiClient` pointed at a local mock Rockhopper HTTP server,
 *   - an MCP `Client` linked to the server via `InMemoryTransport.createLinkedPair()`.
 *
 * Unlike the stdio subprocess test, every byte of code executes inside the vitest worker,
 * so the v8 coverage provider instruments it. This is our primary coverage vehicle for
 * tool/resource/prompt handlers.
 */
function textOf(content: { text?: string; blob?: string }): string {
  if (typeof content.text !== 'string') {
    throw new Error('Expected text resource content, got blob');
  }
  return content.text;
}

describe('MCP in-memory protocol e2e', () => {
  let apiServerHandle: Awaited<ReturnType<typeof startMockRockhopperApiServer>>;
  let client: Client;

  beforeAll(async () => {
    apiServerHandle = await startMockRockhopperApiServer();

    const apiClient = new ApiClient({
      baseUrl: apiServerHandle.baseUrl,
      token: 'rh_pat_test_token',
    });
    const server = createServer(apiClient);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client(
      { name: 'mcp-server-inproc-test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await stopMockRockhopperApiServer(apiServerHandle.server);
  });

  it('lists every tool, resource, and prompt', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(
      [
        'add_comment',
        'approve_review',
        'create_review_request',
        'get_cell_history',
        'get_file_comments',
        'get_file_versions',
        'get_reviews',
        'get_unattributed_changes',
        'list_files',
        'reply_to_comment',
        'resolve_comment',
        'search_files',
        'update_file_description',
      ].sort(),
    );

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(
      'rockhopper://files',
    );

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(
      [
        'file-overview',
        'pending-reviews',
        'summarize-file-changes',
        'unresolved-comments',
      ].sort(),
    );
  });

  // ---------------- tools ----------------

  it('list_files returns the fixture file', async () => {
    const result = await client.callTool({ name: 'list_files', arguments: {} });
    expect(JSON.stringify(result.content)).toContain('Budget.xlsx');
  });

  it('list_files with a non-matching search returns the empty-result message', async () => {
    const result = await client.callTool({
      name: 'list_files',
      arguments: { search: 'nonexistent_file_xyz' },
    });
    expect(JSON.stringify(result.content)).toContain('No enrolled files found');
  });

  it('list_files surfaces API errors via the catch branch', async () => {
    const result = await client.callTool({
      name: 'list_files',
      arguments: { search: 'FAIL' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to list files');
  });

  it('get_file_versions returns a version summary', async () => {
    const result = await client.callTool({
      name: 'get_file_versions',
      arguments: { fileMsId: 'file-1' },
    });
    expect(JSON.stringify(result.content)).toContain('v1.0.0');
  });

  it('get_file_versions reports API errors', async () => {
    const result = await client.callTool({
      name: 'get_file_versions',
      arguments: { fileMsId: 'does-not-exist' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to get versions');
  });

  it('get_file_versions returns the empty-result message', async () => {
    const result = await client.callTool({
      name: 'get_file_versions',
      arguments: { fileMsId: 'empty-file' },
    });
    expect(JSON.stringify(result.content)).toContain('No versions found');
  });

  it('get_file_comments returns threaded comments', async () => {
    const result = await client.callTool({
      name: 'get_file_comments',
      arguments: { fileMsId: 'file-1' },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('Please double-check A1');
    expect(text).toContain('Looks right to me');
  });

  it('get_file_comments reports API errors', async () => {
    const result = await client.callTool({
      name: 'get_file_comments',
      arguments: { fileMsId: 'does-not-exist' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to get comments');
  });

  it('get_file_comments returns the empty-result message', async () => {
    const result = await client.callTool({
      name: 'get_file_comments',
      arguments: { fileMsId: 'empty-file' },
    });
    expect(JSON.stringify(result.content)).toContain('No comments on this file');
  });

  it('get_reviews by versionId returns a review', async () => {
    const result = await client.callTool({
      name: 'get_reviews',
      arguments: { versionId: 101 },
    });
    expect(JSON.stringify(result.content)).toContain('Please review v1');
  });

  it('get_reviews by fileMsId returns a review', async () => {
    const result = await client.callTool({
      name: 'get_reviews',
      arguments: { fileMsId: 'file-1' },
    });
    expect(JSON.stringify(result.content)).toContain('Please review v1');
  });

  it('get_reviews without args errors out', async () => {
    const result = await client.callTool({
      name: 'get_reviews',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Provide either versionId or fileMsId',
    );
  });

  it('get_reviews returns the empty-result message', async () => {
    const result = await client.callTool({
      name: 'get_reviews',
      arguments: { versionId: 999 },
    });
    expect(JSON.stringify(result.content)).toContain('No reviews found');
  });

  it('get_reviews surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'get_reviews',
      arguments: { versionId: 12345 }, // unknown -> 404
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to get reviews');
  });

  it('get_cell_history returns the history summary', async () => {
    const result = await client.callTool({
      name: 'get_cell_history',
      arguments: {
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('Cell A1');
    expect(text).toContain('1234');
  });

  it('get_cell_history returns the empty-result message', async () => {
    const result = await client.callTool({
      name: 'get_cell_history',
      arguments: {
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'ZZ999',
      },
    });
    expect(JSON.stringify(result.content)).toContain('No history found');
  });

  it('get_cell_history surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'get_cell_history',
      arguments: {
        fileMsId: 'does-not-exist',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Failed to get cell history',
    );
  });

  it('search_files returns matches', async () => {
    const result = await client.callTool({
      name: 'search_files',
      arguments: { query: 'Budget' },
    });
    expect(JSON.stringify(result.content)).toContain('Budget.xlsx');
  });

  it('search_files returns the no-matches message', async () => {
    const result = await client.callTool({
      name: 'search_files',
      arguments: { query: 'nonexistent_file_xyz' },
    });
    expect(JSON.stringify(result.content)).toContain('No files match');
  });

  it('search_files surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'search_files',
      arguments: { query: 'FAIL' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Search failed');
  });

  it('get_unattributed_changes returns change rows (with sheetName filter)', async () => {
    const result = await client.callTool({
      name: 'get_unattributed_changes',
      arguments: { fileMsId: 'file-1', sheetName: 'Sheet1' },
    });
    expect(JSON.stringify(result.content)).toContain('Sheet1!A1');
  });

  it('get_unattributed_changes returns the empty-result message', async () => {
    const result = await client.callTool({
      name: 'get_unattributed_changes',
      arguments: { fileMsId: 'file-1', sheetName: 'EmptySheet' },
    });
    expect(JSON.stringify(result.content)).toContain(
      'No unattributed changes found',
    );
  });

  it('get_unattributed_changes surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'get_unattributed_changes',
      arguments: { fileMsId: 'does-not-exist' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to get changes');
  });

  it('add_comment creates a new comment', async () => {
    const result = await client.callTool({
      name: 'add_comment',
      arguments: {
        fileMsId: 'file-1',
        message: 'hello from e2e',
        versionInternalId: 42,
        cellReference: 'Sheet1!A1',
      },
    });
    expect(JSON.stringify(result.content)).toContain('Comment created');
  });

  it('add_comment without cellReference still succeeds', async () => {
    const result = await client.callTool({
      name: 'add_comment',
      arguments: {
        fileMsId: 'file-1',
        message: 'no-cell',
        versionInternalId: 42,
      },
    });
    expect(JSON.stringify(result.content)).toContain('Comment created');
  });

  it('add_comment surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'add_comment',
      arguments: {
        fileMsId: 'fail-file',
        message: 'will fail',
        versionInternalId: 42,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to add comment');
  });

  it('reply_to_comment creates a reply', async () => {
    const result = await client.callTool({
      name: 'reply_to_comment',
      arguments: {
        chatId: 900,
        message: 'acknowledged',
        versionInternalId: 42,
      },
    });
    expect(JSON.stringify(result.content)).toContain('Reply created');
  });

  it('reply_to_comment surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'reply_to_comment',
      arguments: {
        chatId: 12345,
        message: 'acknowledged',
        versionInternalId: 42,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to reply');
  });

  it('resolve_comment marks a comment as resolved', async () => {
    const result = await client.callTool({
      name: 'resolve_comment',
      arguments: { chatId: 900 },
    });
    expect(JSON.stringify(result.content)).toContain('marked as resolved');
  });

  it('resolve_comment surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'resolve_comment',
      arguments: { chatId: 12345 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to resolve');
  });

  it('create_review_request creates a review', async () => {
    const result = await client.callTool({
      name: 'create_review_request',
      arguments: {
        versionId: 101,
        subject: 'Please review',
        description: 'Take a look',
        reviewerIds: [1, 2],
      },
    });
    expect(JSON.stringify(result.content)).toContain(
      'Review request created',
    );
  });

  it('create_review_request surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'create_review_request',
      arguments: {
        versionId: 101,
        subject: 'FAIL',
        reviewerIds: [1],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to create review');
  });

  it('approve_review approves an existing review', async () => {
    const result = await client.callTool({
      name: 'approve_review',
      arguments: { reviewId: 500, notes: 'LGTM' },
    });
    expect(JSON.stringify(result.content)).toContain('approved');
  });

  it('approve_review without notes still approves', async () => {
    const result = await client.callTool({
      name: 'approve_review',
      arguments: { reviewId: 500 },
    });
    expect(JSON.stringify(result.content)).toContain('approved');
  });

  it('approve_review surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'approve_review',
      arguments: { reviewId: 12345 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to approve');
  });

  it('update_file_description renames a file', async () => {
    const result = await client.callTool({
      name: 'update_file_description',
      arguments: { fileMsId: 'file-1', name: 'Budget-final.xlsx' },
    });
    expect(JSON.stringify(result.content)).toContain('Budget-final.xlsx');
  });

  it('update_file_description surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'update_file_description',
      arguments: { fileMsId: 'does-not-exist', name: 'x' },
    });
    expect(result.isError).toBe(true);
  });

  // ---------------- resources ----------------

  it('reads rockhopper://files', async () => {
    const result = await client.readResource({ uri: 'rockhopper://files' });
    expect(textOf(result.contents[0])).toContain('Budget.xlsx');
  });

  it('reads rockhopper://files/{fileMsId}', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://files/file-1',
    });
    expect(textOf(result.contents[0])).toContain('Budget.xlsx');
  });

  it('reads rockhopper://files/{fileMsId}/versions', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://files/file-1/versions',
    });
    expect(textOf(result.contents[0])).toContain('"internalId": 101');
  });

  it('reads rockhopper://versions/{versionId}', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://versions/101',
    });
    expect(textOf(result.contents[0])).toContain('"internalId": 101');
  });

  it('reads rockhopper://files/{fileMsId}/comments', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://files/file-1/comments',
    });
    expect(textOf(result.contents[0])).toContain('Please double-check A1');
  });

  it('reads rockhopper://versions/{versionId}/reviews', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://versions/101/reviews',
    });
    expect(textOf(result.contents[0])).toContain('Please review v1');
  });

  it('reads rockhopper://reviews/{reviewId}', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://reviews/500',
    });
    expect(textOf(result.contents[0])).toContain('Please review v1');
  });

  it('reads rockhopper://teams/{teamId}', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://teams/10',
    });
    expect(textOf(result.contents[0])).toContain('Finance');
  });

  it('reads rockhopper://files/{fileMsId}/changes', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://files/file-1/changes',
    });
    expect(textOf(result.contents[0])).toContain('Sheet1');
  });

  // ---------------- resource list templates ----------------

  it('listResources includes dynamically generated entries from templates', async () => {
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(['rockhopper://files']));
    expect(
      uris.some((u) => u.startsWith('rockhopper://files/file-1')),
    ).toBe(true);
  });

  // ---------------- prompts ----------------

  it('gets the summarize-file-changes prompt', async () => {
    const result = await client.getPrompt({
      name: 'summarize-file-changes',
      arguments: { fileMsId: 'file-1' },
    });
    const text = JSON.stringify(result.messages);
    expect(text).toContain('Budget.xlsx');
    expect(text).toContain('Recent Versions');
    expect(text).toContain('Unattributed Changes');
  });

  it('gets the pending-reviews prompt', async () => {
    const result = await client.getPrompt({
      name: 'pending-reviews',
      arguments: { fileMsId: 'file-1' },
    });
    expect(JSON.stringify(result.messages)).toContain(
      'Reviews on Latest Version',
    );
  });

  it('gets the unresolved-comments prompt', async () => {
    const result = await client.getPrompt({
      name: 'unresolved-comments',
      arguments: { fileMsId: 'file-1' },
    });
    expect(JSON.stringify(result.messages)).toContain(
      'Unresolved Comments',
    );
  });

  it('gets the file-overview prompt', async () => {
    const result = await client.getPrompt({
      name: 'file-overview',
      arguments: { fileMsId: 'file-1' },
    });
    const text = JSON.stringify(result.messages);
    expect(text).toContain('comprehensive overview');
    expect(text).toContain('Budget.xlsx');
  });
});
