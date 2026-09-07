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
    // ENG-2208: the scope is now explicit. This suite exercises every tool
    // including the writes, so it declares the read-write token it always
    // implicitly assumed.
    const server = createServer(apiClient, { scope: 'read-write' });

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
        'connect_microsoft',
        'create_review_request',
        'create_version',
        'disconnect_microsoft',
        'discard_changes',
        'enroll_file',
        'get_cell_history',
        'get_file_comments',
        'get_file_versions',
        'get_reviews',
        'get_unattributed_changes',
        'list_files',
        'list_unenrolled_files',
        'microsoft_link_status',
        'rename_file',
        'reply_to_comment',
        'resolve_comment',
        'search_drive_files',
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

  /**
   * The safety annotations a client GATES ON, read back off the real
   * `tools/list` rather than off the registration object.
   *
   * `readOnlyHint` and `destructiveHint` are not documentation: a host reads
   * them to decide whether a tool may auto-run and whether to put a
   * confirmation in front of it. `discard_changes` throws away a person's
   * uncommitted work, so it advertising `destructiveHint: false` — or a read
   * tool advertising `readOnlyHint: false` — would silently move a decision a
   * human is supposed to make. Nothing else in this package checks that these
   * survive registration and reach the wire.
   */
  it('advertises the safety annotations a host gates on', async () => {
    const tools = await client.listTools();
    const annotationsFor = (
      name: string,
    ): { readOnlyHint?: boolean; destructiveHint?: boolean } => {
      const tool = tools.tools.find((t) => t.name === name);
      if (!tool?.annotations) {
        throw new Error(`tools/list carried no annotations for ${name}`);
      }
      return tool.annotations;
    };

    // Every tool a read-only token is given claims to change nothing — with
    // ONE exception, and it is deliberate: `disconnect_microsoft` rides the
    // read floor because it is an account action, and it is destructive.
    for (const name of [
      'connect_microsoft',
      'microsoft_link_status',
      'get_cell_history',
      'get_file_comments',
      'get_file_versions',
      'get_reviews',
      'get_unattributed_changes',
      'list_files',
      'list_unenrolled_files',
      'search_files',
      'search_drive_files',
    ]) {
      expect(annotationsFor(name).readOnlyHint, name).toBe(true);
    }

    // The three that destroy something a user cannot get back by re-running
    // the tool. A host that auto-runs these has been told it may.
    for (const name of [
      'discard_changes',
      'cancel_review',
      'disconnect_microsoft',
    ]) {
      expect(annotationsFor(name).destructiveHint, name).toBe(true);
      expect(annotationsFor(name).readOnlyHint, name).toBe(false);
    }

    // …and the pairing, so the loop above is not satisfied by marking
    // everything destructive: an ordinary write is not.
    for (const name of ['add_comment', 'create_version', 'rename_file']) {
      expect(annotationsFor(name).destructiveHint, name).toBe(false);
      expect(annotationsFor(name).readOnlyHint, name).toBe(false);
    }
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
    const text = JSON.stringify(result.content);
    expect(text).toContain('nonexistent_file_xyz');
    // ENG-3402 — an empty list is the one ambiguous answer, so over the wire
    // it must still name both causes (archived by this person / never added)
    // rather than reading as "no such file".
    expect(text).toMatch(/archiv/i);
    expect(text).toContain('search_drive_files');
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

  // ENG-2824 — an enrolled file with no versions is one Rockhopper has not
  // finished reading, never one that has none, so the empty answer this used
  // to assert is the defect. Proven over the real JSON-RPC transport: this is
  // the shape a connector actually receives seconds after `enroll_file`.
  it('get_file_versions refuses instead of reporting an empty version list', async () => {
    const result = await client.callTool({
      name: 'get_file_versions',
      arguments: { fileMsId: 'empty-file' },
    });
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain('CHANGE_HISTORY_NOT_READY');
    expect(text).toContain('enrollment_incomplete');
    expect(text).toContain('retryAfterSeconds');
    expect(text).not.toContain('No versions found');
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

  // ENG-4339 — the reproduction, end to end through the MCP protocol. Version
  // 882 belongs to a different file than `file-1`; before the fix this
  // answered with 882's APPROVED review under `file-1`'s handle.
  it('get_reviews refuses versionId + fileMsId rather than answering with the version\'s file', async () => {
    const result = await client.callTool({
      name: 'get_reviews',
      arguments: { fileMsId: 'file-1', versionId: 882 },
    });
    const text = JSON.stringify(result.content);

    expect(result.isError).toBe(true);
    expect(text).toContain('Provide versionId or fileMsId, not both');
    // Neither lane's data leaks: not the foreign version's review (882), and
    // not the file's own (500) either.
    expect(text).not.toContain('Another file review');
    expect(text).not.toContain('Please review v1');
    expect(text).not.toContain('882,');
    expect(text).not.toContain('id: 500');
  });

  it('get_reviews still answers each identifier alone, from its own lane', async () => {
    const byVersion = await client.callTool({
      name: 'get_reviews',
      arguments: { versionId: 882 },
    });
    expect(byVersion.isError).toBeFalsy();
    expect(JSON.stringify(byVersion.content)).toContain('id: 882');

    const byFile = await client.callTool({
      name: 'get_reviews',
      arguments: { fileMsId: 'file-1' },
    });
    expect(byFile.isError).toBeFalsy();
    expect(JSON.stringify(byFile.content)).toContain('id: 500');
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

  // The other side of the conditional `discard_changes` already covers below.
  // Committing a file with nothing uncommitted would write an empty version
  // and report success, so the refusal is the behaviour — and it is a
  // RETURNED refusal, not a thrown one, which is the shape a connector reads.
  it('create_version refuses a file with no uncommitted changes', async () => {
    const result = await client.callTool({
      name: 'create_version',
      arguments: {
        fileMsId: 'no-changes-file',
        versionType: 'minor',
        description: 'nothing to commit',
      },
    });
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain('no uncommitted changes to commit');
    // It never reached the create route, so no version number was invented.
    expect(text).not.toContain('created');
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

/**
 * ENG-2208 — what a client actually sees in `tools/list` at each scope, over
 * the real protocol rather than through the registrar's mock.
 *
 * The gate used to be `scope !== 'read-only'`, so every one of these cases
 * except the explicit `read-only` string advertised all nine write tools.
 */
describe('tools/list is gated by the token scope (ENG-2208)', () => {
  const READ_TOOLS = [
    'connect_microsoft',
    'disconnect_microsoft',
    'microsoft_link_status',
    'get_cell_history',
    'get_file_comments',
    'get_file_versions',
    'get_reviews',
    'get_unattributed_changes',
    'list_files',
    'list_unenrolled_files',
    'search_files',
    'search_drive_files',
  ].sort();

  async function toolNamesForScope(scope?: string): Promise<string[]> {
    const handle = await startMockRockhopperApiServer();
    const apiClient = new ApiClient({
      baseUrl: handle.baseUrl,
      token: 'rh_pat_test_token',
    });
    const server = createServer(
      apiClient,
      scope === undefined ? undefined : { scope },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const scopedClient = new Client(
      { name: 'scope-gate-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      await Promise.all([
        server.connect(serverTransport),
        scopedClient.connect(clientTransport),
      ]);
      const tools = await scopedClient.listTools();
      return tools.tools.map((t) => t.name).sort();
    } finally {
      await scopedClient.close();
      await stopMockRockhopperApiServer(handle.server);
    }
  }

  it('shows 22 tools to a read-write token', async () => {
    const names = await toolNamesForScope('read-write');
    expect(names).toHaveLength(22);
    expect(names).toContain('add_comment');
  });

  it('shows 12 tools to a read-only token', async () => {
    expect(await toolNamesForScope('read-only')).toEqual(READ_TOOLS);
  });

  it('shows 12 tools for an unrecognised scope', async () => {
    expect(await toolNamesForScope('some-future-scope')).toEqual(READ_TOOLS);
  });

  it('shows 12 tools when the scope is unknown', async () => {
    expect(await toolNamesForScope()).toEqual(READ_TOOLS);
  });
});

/**
 * ENG-2200 — `enroll_file` over the real protocol, against the mock HTTP API.
 *
 * The unit specs mock the API client; these do not. They prove the request
 * bodies this package actually puts on the wire are the ones the backend's
 * DTOs accept — the seam where a field-name guess (`url` for `webUrl`, an
 * `msId` where a `platformId` belongs) survives every mocked test and fails
 * once, in front of a customer.
 */
describe('enroll_file end to end (ENG-2200)', () => {
  let handle: Awaited<ReturnType<typeof startMockRockhopperApiServer>>;
  let enrollClient: Client;

  beforeAll(async () => {
    handle = await startMockRockhopperApiServer();
    const server = createServer(
      new ApiClient({ baseUrl: handle.baseUrl, token: 'rh_pat_test_token' }),
      { capabilities: ['files:write'] },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    enrollClient = new Client(
      { name: 'enroll-e2e-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      enrollClient.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await enrollClient?.close();
    await stopMockRockhopperApiServer(handle.server);
  });

  async function enroll(args: Record<string, unknown>): Promise<string> {
    const result = (await enrollClient.callTool({
      name: 'enroll_file',
      arguments: args,
    })) as { content: Array<{ text?: string }> };
    return result.content[0].text ?? '';
  }

  const base = 'https://contoso.sharepoint.com/:x:/r/sites/finance/';

  it('enrolls a new workbook for share_with="me"', async () => {
    const text = await enroll({ url: `${base}Doc.aspx`, share_with: 'me' });
    expect(text).toContain('"outcome":"enrolled"');
    expect(text).toContain('Becklar_RMR_Model.xlsx');
    expect(text).toContain('visible to you only');
  });

  it('expands share_with="team" to the roster minus the caller', async () => {
    const text = await enroll({ url: `${base}Doc.aspx`, share_with: 'team' });
    expect(text).toContain('"outcome":"enrolled"');
    // Alice is the caller; Bob is the only real target.
    expect(text).toContain('"sharedWithCount":1');
  });

  it('returns the question when share_with is missing', async () => {
    const text = await enroll({ url: `${base}Doc.aspx` });
    expect(text).toContain('"outcome":"share_with_required"');
  });

  it('asks before restoring a workbook the user removed', async () => {
    const text = await enroll({ url: `${base}removed.aspx`, share_with: 'me' });
    expect(text).toContain('"outcome":"restore_confirmation_required"');
    expect(text).toContain('confirm_restore');
  });

  it('restores it on the confirmed second call', async () => {
    const text = await enroll({
      url: `${base}removed.aspx`,
      share_with: 'me',
      confirm_restore: true,
    });
    expect(text).toContain('"outcome":"restored"');
  });

  it('says already_enrolled for a workbook that is already there', async () => {
    const text = await enroll({ url: `${base}already.aspx`, share_with: 'me' });
    expect(text).toContain('"outcome":"already_enrolled"');
  });

  it('refuses a Google link as unsupported_provider', async () => {
    const text = await enroll({
      url: 'https://docs.google.com/spreadsheets/d/abc/edit',
      share_with: 'me',
    });
    expect(text).toContain('"outcome":"unsupported_provider"');
  });

  it('asks for the browser address when the link resolves to nothing', async () => {
    const text = await enroll({ url: 'https://nonsense.test/x', share_with: 'me' });
    expect(text).toContain('"outcome":"unresolvable"');
  });

  it('takes a driveMsId + msId pair and still guards a hidden target', async () => {
    expect(
      await enroll({ msId: 'removed-item', driveMsId: 'drive-9', share_with: 'me' }),
    ).toContain('"outcome":"restore_confirmation_required"');
    expect(
      await enroll({ msId: 'fresh-item', driveMsId: 'drive-9', share_with: 'me' }),
    ).toContain('"outcome":"enrolled"');
  });
});

/**
 * ENG-2204 — the ENG-1647 transcript, end to end, over the real protocol.
 *
 * The customer asked for a SharePoint workbook by name. The assistant matched
 * a DIFFERENT already-enrolled file, said "already enrolled", and then found
 * no tool that could add the real one. This is that conversation replayed
 * against the mock backend: an ambiguous name must yield a CANDIDATE LIST, the
 * user must pick, and only then may anything be enrolled.
 */
describe('ENG-1647 replayed: find, confirm, enroll (ENG-2204)', () => {
  let handle: Awaited<ReturnType<typeof startMockRockhopperApiServer>>;
  let flowClient: Client;

  beforeAll(async () => {
    handle = await startMockRockhopperApiServer();
    const server = createServer(
      new ApiClient({ baseUrl: handle.baseUrl, token: 'rh_pat_test_token' }),
      { capabilities: ['files:write'] },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    flowClient = new Client(
      { name: 'search-then-enroll-e2e-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      flowClient.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await flowClient?.close();
    await stopMockRockhopperApiServer(handle.server);
  });

  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await flowClient.callTool({
      name,
      arguments: args,
    })) as { content: Array<{ text?: string }> };
    return result.content[0].text ?? '';
  }

  it('walks the whole flow: candidates, a human pick, then the enrolment', async () => {
    // 1. The user names a file that is NOT in Rockhopper.
    const found = await call('search_drive_files', { query: 'Becklar' });
    expect(found).toContain('"outcome":"candidates"');
    // Two files match the name. Answering with either as a fact is the bug.
    expect(found).toContain('Becklar_RMR_Model.xlsx');
    expect(found).toContain('Becklar_RMR_Model_OLD.xlsx');
    const token = (JSON.parse(found.split('\n').at(-1) ?? '{}') as {
      confirmToken: string;
    }).confirmToken;

    // 2. The user says "the first one".
    const confirmed = await call('search_drive_files', {
      confirm_index: 1,
      confirm_token: token,
    });
    expect(confirmed).toContain('"outcome":"confirmed"');
    const pick = JSON.parse(confirmed.split('\n').at(-1) ?? '{}') as {
      driveMsId: string;
      msId: string;
    };
    expect(pick).toMatchObject({ driveMsId: 'drive-9', msId: 'ms-item-9' });

    // 3. `enroll_file` still asks who may see it — the search never answers
    //    that question on the user's behalf.
    expect(await call('enroll_file', pick)).toContain(
      '"outcome":"share_with_required"',
    );

    // 4. And enrols on the ids the confirmation produced.
    expect(
      await call('enroll_file', { ...pick, share_with: 'me' }),
    ).toContain('"outcome":"enrolled"');
  });

  it('enrols nothing when the pick names a file the search never returned', async () => {
    await call('search_drive_files', { query: 'Becklar' });
    const forged = await call('search_drive_files', {
      confirm_index: 1,
      confirm_token: 'a-token-this-session-never-issued',
    });
    expect(forged).toContain('"outcome":"unknown_candidate"');
  });

  it('hands back a connect link, not an error, with no Microsoft account', async () => {
    const text = await call('search_drive_files', { query: 'unlinked' });
    expect(text).toContain('"outcome":"microsoft_not_connected"');
    expect(text).toContain('login.microsoftonline.com');
    expect(text).toContain('Do not compose a sign-in link yourself');
  });

  it('says an empty drive search is empty, not broken', async () => {
    expect(await call('search_drive_files', { query: 'nothing here' })).toContain(
      '"outcome":"no_matches"',
    );
  });
});
