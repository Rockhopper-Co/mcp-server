import { describe, expect, it } from 'vitest';
import { formatVersion } from '../../version-format.js';
import { registerTools } from '../../tools/index.js';
import { registerPrompts } from '../../prompts/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2750 — a discard snapshot is not a version number.
 *
 * The backend marks the provisional pre-discard snapshot by NEGATING every
 * semver component (`convergence-orchestrator.service.ts:178`), and tests the
 * marker as `isDiscard = version.majorVersion < 0`
 * (`file-versions.service.ts:781`). Every renderer here interpolated the three
 * numbers raw, so staging printed `- **v-2.0.0** (id: 814)`.
 *
 * The consumer is a MODEL. `v-2.0.0` is quotable to a customer, sorts as the
 * oldest release, and can be passed back as an argument — three wrong answers
 * from one unrendered internal marker.
 */

const base = {
  internalId: 101,
  majorVersion: 2,
  minorVersion: 0,
  patchVersion: 0,
  description: 'Q3 assumptions',
  createdAt: '2026-01-01T00:00:00Z',
  wasDiscarded: false,
  wasReverted: false,
  byUserPlatformId: null,
  byUserPlatformType: null,
  byUserName: 'David Kuchar',
};

/** The staging row from the ticket: the discard OF v2.0.0. */
const discardSnapshot = {
  ...base,
  internalId: 814,
  majorVersion: -2,
  minorVersion: 0,
  patchVersion: 0,
  wasDiscarded: true,
};

describe('formatVersion (ENG-2750)', () => {
  it('renders an ordinary version as semver', () => {
    expect(formatVersion({ majorVersion: 2, minorVersion: 3, patchVersion: 1 })).toBe(
      'v2.3.1',
    );
  });

  it('renders a discard snapshot as the discard OF the version it snapshotted', () => {
    expect(
      formatVersion({ majorVersion: -2, minorVersion: 0, patchVersion: 0 }),
    ).toBe('discard of v2.0.0');
  });

  /**
   * All three components are negated at the write site, so recovering the
   * original needs an absolute value on each — not just on the major.
   */
  it('recovers every negated component, not only the major', () => {
    expect(
      formatVersion({ majorVersion: -1, minorVersion: -3, patchVersion: -2 }),
    ).toBe('discard of v1.3.2');
  });

  it('never emits a negative-looking version string', () => {
    const text = formatVersion({
      majorVersion: -9,
      minorVersion: -9,
      patchVersion: -9,
    });
    expect(text).not.toContain('v-');
    expect(text).not.toContain('.-');
  });

  /** `-0` stringifies as `0`, but Math.abs keeps that true after the fix too. */
  it('handles a negated zero component', () => {
    expect(
      formatVersion({ majorVersion: -2, minorVersion: -0, patchVersion: -0 }),
    ).toBe('discard of v2.0.0');
  });
});

describe('get_file_versions discard rendering (ENG-2750)', () => {
  const render = async (versions: unknown[]) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue(versions);
    registerTools(server as any, api as any, { scope: 'read-write' });
    const call = server.registerTool.mock.calls.find(
      (c) => c[0] === 'get_file_versions',
    );
    const result = await call?.[2]({ fileMsId: 'file-1' });
    return result.content[0].text as string;
  };

  it('names the discarded version and prints no negative semver', async () => {
    const text = await render([discardSnapshot]);
    expect(text).toContain('discard of v2.0.0');
    expect(text).not.toContain('v-');
    expect(text).toContain('(id: 814)');
  });

  /** The `[discarded]` tag reflects `wasDiscarded`, a different fact — it stays. */
  it('keeps the discarded flag alongside the label', async () => {
    const text = await render([discardSnapshot]);
    expect(text).toContain('[discarded]');
  });

  it('leaves an ordinary version untouched', async () => {
    const text = await render([base]);
    expect(text).toContain('**v2.0.0**');
    expect(text).not.toContain('discard of');
  });
});

describe('prompt version rendering (ENG-2750)', () => {
  const renderPrompt = async (name: string, versions: unknown[]) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileVersions.mockResolvedValue(versions);
    registerPrompts(server as any, api as any);
    const call = server.registerPrompt.mock.calls.find((c) => c[0] === name);
    const result = await call?.[2]({ fileMsId: 'file-1' });
    return result.messages[0].content.text as string;
  };

  it('summarize-file-changes names the discarded version', async () => {
    const text = await renderPrompt('summarize-file-changes', [discardSnapshot]);
    expect(text).toContain('discard of v2.0.0');
    expect(text).not.toContain('v-');
  });

  it('file-overview names the discarded version', async () => {
    const text = await renderPrompt('file-overview', [discardSnapshot]);
    expect(text).toContain('discard of v2.0.0');
    expect(text).not.toContain('v-');
  });
});

describe('create_version rendering (ENG-2750)', () => {
  it('reports the created version through the shared formatter', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue({
      internalId: 1,
      platformId: 'file-1',
      fileType: 'excel',
      driveMsId: 'drive-1',
      name: 'Budget.xlsx',
      hasUncommittedChanges: true,
    });
    api.getFileVersions.mockResolvedValue([base]);
    api.createVersion.mockResolvedValue({
      ...base,
      majorVersion: 2,
      minorVersion: 1,
      patchVersion: 0,
    });
    registerTools(server as any, api as any, { scope: 'read-write' });
    const call = server.registerTool.mock.calls.find(
      (c) => c[0] === 'create_version',
    );
    const result = await call?.[2]({
      fileMsId: 'file-1',
      versionType: 'minor',
      description: 'bump',
    });
    expect(result.content[0].text).toContain('Version v2.1.0 created');
  });
});
