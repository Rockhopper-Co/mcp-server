import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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
        'cancel_review',
        'create_review_request',
        'create_version',
        'discard_changes',
        'get_cell_history',
        'get_file_comments',
        'get_file_versions',
        'get_reviews',
        'get_unattributed_changes',
        'list_files',
        'rename_file',
        'reply_to_comment',
        'resolve_comment',
        'search_files',
      ].sort(),
    );

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri).sort()).toEqual(
      ['rockhopper://files', 'rockhopper://orchestration-guide'].sort(),
    );

    const templates = await client.listResourceTemplates();
    expect(
      templates.resourceTemplates.map((t) => t.uriTemplate).sort(),
    ).toEqual(
      [
        'rockhopper://files/{fileMsId}',
        'rockhopper://files/{fileMsId}/changes',
        'rockhopper://files/{fileMsId}/comments',
        'rockhopper://files/{fileMsId}/versions',
        'rockhopper://reviews/{reviewId}',
        'rockhopper://teams/{teamId}',
        'rockhopper://versions/{versionId}',
        'rockhopper://versions/{versionId}/reviews',
      ].sort(),
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
      'No unattributed changes on sheet ',
    );
    expect(JSON.stringify(result.content)).toContain('EmptySheet');
  });

  // KI-097: file-wide mode uses the cursor-paginated route.
  it('get_unattributed_changes returns paginated envelope when no sheetName', async () => {
    const result = await client.callTool({
      name: 'get_unattributed_changes',
      arguments: { fileMsId: 'file-1' },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('Showing 1 of 1');
    expect(text).toContain('Top sheets on this page: Sheet1 (1)');
    expect(text).toContain('Sheet1!A1');
  });

  it('get_unattributed_changes surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'get_unattributed_changes',
      arguments: { fileMsId: 'does-not-exist' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to get changes');
  });

  // Plan 02 ruling 5 — the strict refusal, proven over the real JSON-RPC
  // transport rather than a handler call: this is the shape Claude Desktop and
  // Cursor actually receive.
  it('refuses change history over the protocol while a fold is pending', async () => {
    const result = await client.callTool({
      name: 'get_unattributed_changes',
      arguments: { fileMsId: 'file-fold-pending' },
    });
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain('CHANGE_HISTORY_NOT_READY');
    expect(text).toContain('change_history_incomplete');
    expect(text).not.toContain('No unattributed changes');
  });

  it('errors the changes resource while a fold is pending', async () => {
    await expect(
      client.readResource({
        uri: 'rockhopper://files/file-fold-pending/changes',
      }),
    ).rejects.toThrow('CHANGE_HISTORY_NOT_READY');
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

  // ENG-2230 — the schema runs inside the SDK, on the customer's machine, so
  // these cases exercise the surface a customer actually hits rather than the
  // zod object in isolation.
  it('advertises reviewerIds as integer-or-uuid in tools/list (ENG-2230)', async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === 'create_review_request');
    const items = (
      tool?.inputSchema.properties as {
        reviewerIds: { items: { anyOf: { type: string; pattern?: string }[] } };
      }
    ).reviewerIds.items;
    expect(items.anyOf.map((b) => b.type).sort()).toEqual([
      'integer',
      'string',
    ]);
    // JSON Schema `pattern` has no case-insensitivity flag, so the advertised
    // pattern must spell both hex cases out — otherwise a client that
    // pre-validates against this schema refuses an uppercase uuid that the
    // server accepts, which is this ticket's defect in a narrower form.
    const pattern = items.anyOf.find((b) => b.type === 'string')?.pattern;
    expect(pattern).toBeDefined();
    expect(new RegExp(pattern as string).test('0198F3A1-2B4C-7D8E-9F01-23456789ABCD')).toBe(true);
    expect(new RegExp(pattern as string).test('0198f3a1-2b4c-7d8e-9f01-23456789abcd')).toBe(true);
    expect(new RegExp(pattern as string).test('alice@example.com')).toBe(false);
  });

  it('create_review_request accepts uuid reviewer ids (ENG-2230)', async () => {
    const result = await client.callTool({
      name: 'create_review_request',
      arguments: {
        versionId: 101,
        subject: 'Please review',
        reviewerIds: [
          '0198f3a1-2b4c-7d8e-9f01-0000000000a1',
          '0198f3a1-2b4c-7d8e-9f01-0000000000a2',
        ],
      },
    });
    expect(JSON.stringify(result.content)).toContain('Review request created');
  });

  it('create_review_request accepts uuid and numeric ids mixed (ENG-2230)', async () => {
    const result = await client.callTool({
      name: 'create_review_request',
      arguments: {
        versionId: 101,
        subject: 'Please review',
        reviewerIds: [7, '0198f3a1-2b4c-7d8e-9f01-0000000000a1'],
      },
    });
    expect(JSON.stringify(result.content)).toContain('Review request created');
  });

  it('create_review_request still refuses a non-identifier string (ENG-2230)', async () => {
    const result = await client.callTool({
      name: 'create_review_request',
      arguments: {
        versionId: 101,
        subject: 'Please review',
        reviewerIds: ['alice@example.com'],
      },
    });
    expect(result.isError).toBe(true);
    // The refusal must name BOTH accepted spellings — it is what the AI client
    // reads before deciding what to retry with.
    expect(JSON.stringify(result.content)).toContain(
      'either a uuid (preferred) or a positive integer internal id',
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

  it('create_version commits uncommitted changes as a new version', async () => {
    const result = await client.callTool({
      name: 'create_version',
      arguments: {
        fileMsId: 'file-1',
        versionType: 'minor',
        description: 'Updated assumptions',
      },
    });
    expect(JSON.stringify(result.content)).toContain('Version v1.1.0 created');
  });

  it('create_version on a file with no prior versions starts from v0.0.0', async () => {
    const result = await client.callTool({
      name: 'create_version',
      arguments: {
        fileMsId: 'new-file',
        versionType: 'major',
        description: 'First version',
      },
    });
    expect(JSON.stringify(result.content)).toContain('Version v1.0.0 created');
  });

  it('create_version surfaces API errors for unknown files', async () => {
    const result = await client.callTool({
      name: 'create_version',
      arguments: {
        fileMsId: 'does-not-exist',
        versionType: 'patch',
        description: 'test',
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to create version');
  });

  it('discard_changes returns error when file has no uncommitted changes', async () => {
    const result = await client.callTool({
      name: 'discard_changes',
      arguments: {
        fileMsId: 'no-changes-file',
        description: 'test',
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no uncommitted changes to discard');
  });

  it('discard_changes discards uncommitted edits', async () => {
    const result = await client.callTool({
      name: 'discard_changes',
      arguments: {
        fileMsId: 'file-1',
        description: 'Wrong assumptions',
      },
    });
    expect(JSON.stringify(result.content)).toContain('Changes discarded');
  });

  it('discard_changes surfaces API errors for unknown files', async () => {
    const result = await client.callTool({
      name: 'discard_changes',
      arguments: {
        fileMsId: 'does-not-exist',
        description: 'test',
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to discard');
  });

  it('cancel_review cancels a pending review', async () => {
    const result = await client.callTool({
      name: 'cancel_review',
      arguments: { reviewId: 500 },
    });
    expect(JSON.stringify(result.content)).toContain('Review 500 cancelled');
  });

  it('cancel_review surfaces API errors for unknown reviews', async () => {
    const result = await client.callTool({
      name: 'cancel_review',
      arguments: { reviewId: 12345 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Failed to cancel review');
  });

  it('rename_file renames a file', async () => {
    const result = await client.callTool({
      name: 'rename_file',
      arguments: { fileMsId: 'file-1', name: 'Budget-final.xlsx' },
    });
    expect(JSON.stringify(result.content)).toContain('Budget-final.xlsx');
  });

  it('rename_file surfaces API errors', async () => {
    const result = await client.callTool({
      name: 'rename_file',
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

  it('reads rockhopper://teams/{teamId} by uuid (ENG-2230)', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://teams/0198f3a1-2b4c-7d8e-9f01-23456789abcd',
    });
    expect(textOf(result.contents[0])).toContain('Finance');
  });

  it('reads rockhopper://files/{fileMsId}/changes', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://files/file-1/changes',
    });
    expect(textOf(result.contents[0])).toContain('Sheet1');
  });

  // ---------------- resource list shape ----------------

  it('listResources returns only static resources, never per-file expansions', async () => {
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    // Only the workspace-level listing + orchestration guide are static.
    // Per-file URIs must NOT appear here — they are accessed via templates/list and read-by-URI.
    expect(uris.sort()).toEqual(
      ['rockhopper://files', 'rockhopper://orchestration-guide'].sort(),
    );
    expect(
      uris.some((u) => u.startsWith('rockhopper://files/file-1')),
    ).toBe(false);
  });

  it('listResourceTemplates exposes the 8 URI templates clients use for per-file reads', async () => {
    const templates = await client.listResourceTemplates();
    const patterns = templates.resourceTemplates.map((t) => t.uriTemplate);
    expect(patterns).toContain('rockhopper://files/{fileMsId}');
    expect(patterns).toContain('rockhopper://files/{fileMsId}/versions');
    expect(patterns).toContain('rockhopper://files/{fileMsId}/comments');
    expect(patterns).toContain('rockhopper://files/{fileMsId}/changes');
    expect(patterns).toContain('rockhopper://versions/{versionId}');
    expect(patterns).toContain('rockhopper://versions/{versionId}/reviews');
    expect(patterns).toContain('rockhopper://reviews/{reviewId}');
    expect(patterns).toContain('rockhopper://teams/{teamId}');
  });

  it('reads rockhopper://orchestration-guide and returns markdown with all expected sections', async () => {
    const result = await client.readResource({
      uri: 'rockhopper://orchestration-guide',
    });
    expect(result.contents[0].uri).toBe('rockhopper://orchestration-guide');
    expect(result.contents[0].mimeType).toBe('text/markdown');
    const md = textOf(result.contents[0]);
    expect(md).toContain('fileMsId');
    expect(md).toContain('versionId');
    expect(md).toContain('versionInternalId');
    expect(md).toMatch(/identity/i);
    expect(md).toMatch(/comment/i);
    expect(md).toMatch(/review lifecycle/i);
    expect(md).toMatch(/versioning/i);
    expect(md).toMatch(/uncommitted/i);
    expect(md).toMatch(/google/i);
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
