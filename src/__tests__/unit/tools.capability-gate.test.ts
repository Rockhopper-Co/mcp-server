import { describe, expect, it } from 'vitest';
import {
  PAT_CAPABILITIES,
  PENDING_WRITE_TOOLS,
  WRITE_TOOLS_BY_CAPABILITY,
  registerTools,
  resolveCapabilities,
  type PatCapability,
} from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2212 — each write registrar is gated on ITS OWN capability.
 *
 * ENG-2208 made the gate an allow-list over one coarse scope, so a token that
 * may draft a comment also got `discard_changes` — the ability to throw away a
 * person's uncommitted work. ENG-2211 made the four families a stored column;
 * until the registrars read them the column changes nothing.
 */

/**
 * The eleven tools every token gets, whatever it was granted: the eight reads,
 * plus the three Microsoft account-link tools, which ride the read floor
 * because connecting an account is not a write to Rockhopper data (ENG-2198).
 */
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
  'list_unenrolled_files',
];

function registeredToolNames(options?: {
  scope?: string;
  capabilities?: readonly string[];
}): string[] {
  const server = createMockMcpServer();
  const api = createMockApiClient();
  registerTools(server as never, api as never, options);
  return server.registerTool.mock.calls.map((c) => c[0]);
}

/** The names a family covers that a registrar actually registers today. */
function registeredNamesFor(capability: PatCapability): string[] {
  return WRITE_TOOLS_BY_CAPABILITY[capability].filter(
    (name) => !PENDING_WRITE_TOOLS.has(name),
  );
}

describe('per-capability tool registration (ENG-2212)', () => {
  it('registers only the named family, not all four', () => {
    const names = registeredToolNames({
      scope: 'read-write',
      capabilities: ['comments:write'],
    });
    expect(names.sort()).toEqual(
      [...READ_TOOL_NAMES, ...registeredNamesFor('comments:write')].sort(),
    );
    expect(names).not.toContain('discard_changes');
  });

  it.each(PAT_CAPABILITIES)('registers exactly what %s covers', (capability) => {
    const names = registeredToolNames({ capabilities: [capability] });
    expect(names.sort()).toEqual(
      [...READ_TOOL_NAMES, ...registeredNamesFor(capability)].sort(),
    );
  });

  it('grants nothing for an EMPTY capability list, even at read-write scope', () => {
    // An empty array is a caller saying "no write families", which is not the
    // same as saying nothing. The coarse scope must not re-widen it.
    const names = registeredToolNames({ scope: 'read-write', capabilities: [] });
    expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it('ignores a capability string it has never heard of', () => {
    const names = registeredToolNames({
      capabilities: ['files:destroy', 'COMMENTS:WRITE', ''],
    });
    expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it('falls back to the coarse scope when no capability list is supplied', () => {
    // A backend older than ENG-2211 serves `patScope` and no `patScopes`.
    // 10 floor (7 read + 3 Microsoft link) + 10 write, enroll_file included
    // since ENG-2200 registered it and emptied PENDING_WRITE_TOOLS.
    expect(registeredToolNames({ scope: 'read-write' })).toHaveLength(22);
    expect(registeredToolNames({ scope: 'read-only' })).toHaveLength(12);
    expect(registeredToolNames()).toHaveLength(12);
  });

  it('collapses duplicates rather than registering a tool twice', () => {
    const names = registeredToolNames({
      capabilities: ['reviews:write', 'reviews:write'],
    });
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('resolveCapabilities', () => {
  it('returns the families in vocabulary order, whatever order they arrive in', () => {
    expect(
      resolveCapabilities({
        capabilities: ['files:write', 'comments:write'],
      }),
    ).toEqual(['comments:write', 'files:write']);
  });

  it('expands read-write only when the caller named no families', () => {
    expect(resolveCapabilities({ scope: 'read-write' })).toEqual([
      ...PAT_CAPABILITIES,
    ]);
    expect(resolveCapabilities({ scope: 'read-only' })).toEqual([]);
    expect(resolveCapabilities()).toEqual([]);
  });
});

describe('the enumerated vocabulary', () => {
  it('registers enroll_file under files:write, and nothing is pending', () => {
    // ENG-2212 enumerated `enroll_file` a release before a registrar existed
    // so ENG-2200 would not have to re-cut this map. ENG-2200 then added the
    // registrar and emptied the pending set, which is what these two assert.
    expect(WRITE_TOOLS_BY_CAPABILITY['files:write']).toContain('enroll_file');
    expect(PENDING_WRITE_TOOLS.has('enroll_file')).toBe(false);
    expect(PENDING_WRITE_TOOLS.size).toBe(0);
  });

  it('registers every enumerated tool that is not marked pending', () => {
    // The derived-set guard: an enumerated name with no registrar fails here,
    // so the instructions string can never advertise a tool that does not
    // exist. It is what would have caught ENG-2200 landing half-wired.
    const registered = new Set(registeredToolNames({ scope: 'read-write' }));
    for (const capability of PAT_CAPABILITIES) {
      for (const name of WRITE_TOOLS_BY_CAPABILITY[capability]) {
        expect(
          registered.has(name),
          `${name} (${capability}) enumerated but not registered`,
        ).toBe(!PENDING_WRITE_TOOLS.has(name));
      }
    }
  });
});
