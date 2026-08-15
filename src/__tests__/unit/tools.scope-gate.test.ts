import { describe, expect, it } from 'vitest';
import { grantsWriteTools, registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2208 — the write gate is an ALLOW-LIST, not `scope !== 'read-only'`.
 *
 * The old test was fail-open: any value the allow-list does not name — a
 * scope string a future backend mints, a typo, a missing field on an older
 * `/users/me` — registered all nine write tools. Adding a scope value was
 * therefore a privilege escalation, which is exactly what the four-capability
 * work (ENG-2211) is about to do.
 */
const WRITE_TOOL_NAMES = [
  'add_comment',
  'reply_to_comment',
  'resolve_comment',
  'create_review_request',
  'approve_review',
  'cancel_review',
  'create_version',
  'discard_changes',
  'rename_file',
  'enroll_file',
];

/** Every tool a token of any scope may call — the read-only floor. */
const READ_TOOL_NAMES = [
  'connect_microsoft',
  'microsoft_link_status',
  'disconnect_microsoft',
  'list_files',
  'get_file_versions',
  'get_file_comments',
  'get_reviews',
  'get_cell_history',
  'get_unattributed_changes',
  'search_files',
  'search_drive_files',
];

function registeredToolNames(scope?: string): string[] {
  const server = createMockMcpServer();
  const api = createMockApiClient();
  registerTools(server as any, api as any, scope === undefined ? undefined : { scope });
  return server.registerTool.mock.calls.map((c) => c[0]);
}

describe('write-tool scope gate (ENG-2208)', () => {
  it('grants the write tools only to read-write', () => {
    expect(grantsWriteTools('read-write')).toBe(true);
    expect(grantsWriteTools('read-only')).toBe(false);
    expect(grantsWriteTools(undefined)).toBe(false);
    expect(grantsWriteTools('')).toBe(false);
    expect(grantsWriteTools('admin')).toBe(false);
    expect(grantsWriteTools('READ-WRITE')).toBe(false);
    expect(grantsWriteTools('read-write-plus')).toBe(false);
  });

  it('registers 21 tools for a read-write scope', () => {
    const names = registeredToolNames('read-write');
    expect(names).toHaveLength(21);
    for (const name of [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
      expect(names).toContain(name);
    }
  });

  it('registers 11 tools for a read-only scope', () => {
    const names = registeredToolNames('read-only');
    expect(names).toHaveLength(11);
    expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  // The polarity flip. Pre-ENG-2208 each of these registered all 16.
  it('registers 11 tools for an UNRECOGNISED scope', () => {
    for (const scope of ['admin', 'write', 'read-write-plus', '']) {
      const names = registeredToolNames(scope);
      expect(names, `scope=${JSON.stringify(scope)}`).toHaveLength(11);
      for (const name of WRITE_TOOL_NAMES) {
        expect(names, `scope=${JSON.stringify(scope)}`).not.toContain(name);
      }
    }
  });

  it('registers 11 tools when no scope is supplied at all', () => {
    expect(registeredToolNames()).toHaveLength(11);
    for (const name of WRITE_TOOL_NAMES) {
      expect(registeredToolNames()).not.toContain(name);
    }
  });
});
