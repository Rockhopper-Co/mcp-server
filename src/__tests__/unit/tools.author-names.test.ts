import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2603 — who changed what, rendered so a human or a model can use it.
 *
 * `get_file_versions` and `get_unattributed_changes` printed the raw
 * `byUserPlatformId`, so asked "who changed the total column" the only answer
 * available to an agent was `575f8432-d2d2-4d47-ae84-2bc8b7e19151`, while
 * `get_cell_history` on the same workbook said "David Kuchar". The backend now
 * resolves a name onto both payloads; these cases pin the rendering.
 *
 * The fallback matters as much as the happy path: the field is additive, so a
 * client on this version talking to an older backend must keep rendering what
 * it rendered before rather than dropping attribution entirely.
 */
async function callTool(name: string, args: Record<string, unknown>, versions: unknown) {
  const server = createMockMcpServer();
  const api = createMockApiClient();
  api.getFileVersions.mockResolvedValue(versions);
  registerTools(server as any, api as any, { scope: 'read-write' });
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  const result = await call?.[2](args);
  return result.content[0].text as string;
}

const base = {
  internalId: 101,
  majorVersion: 1,
  minorVersion: 0,
  patchVersion: 0,
  description: 'Q3 assumptions',
  createdAt: '2026-01-01T00:00:00Z',
  wasDiscarded: false,
  wasReverted: false,
  byUserPlatformId: '575f8432-d2d2-4d47-ae84-2bc8b7e19151',
  byUserPlatformType: 'microsoft',
};

describe('get_file_versions author rendering (ENG-2603)', () => {
  it('renders the resolved name, not the platform id', async () => {
    const text = await callTool(
      'get_file_versions',
      { fileMsId: 'file-1' },
      [{ ...base, byUserName: 'David Kuchar' }],
    );
    expect(text).toContain('by David Kuchar');
    expect(text).not.toContain('575f8432');
  });

  /** Additive field: an older backend omits it and must not lose attribution. */
  it('falls back to the platform id when the backend sent no name', async () => {
    const text = await callTool('get_file_versions', { fileMsId: 'file-1' }, [
      base,
    ]);
    expect(text).toContain('by 575f8432-d2d2-4d47-ae84-2bc8b7e19151');
  });

  it('falls back when the backend could not resolve the author', async () => {
    const text = await callTool(
      'get_file_versions',
      { fileMsId: 'file-1' },
      [{ ...base, byUserName: null }],
    );
    expect(text).toContain('by 575f8432-d2d2-4d47-ae84-2bc8b7e19151');
  });

  /**
   * No author at all is a real state — the `v0.0.0` "Live file" row carries a
   * sentinel actor. It must render as no attribution rather than the string
   * "null" or an empty "by".
   */
  it('renders no attribution segment when there is no author', async () => {
    const text = await callTool(
      'get_file_versions',
      { fileMsId: 'file-1' },
      [{ ...base, byUserPlatformId: null, byUserName: null }],
    );
    expect(text).not.toContain('by ');
    expect(text).not.toContain('null');
  });
});

/**
 * The same "no author at all" state, on the OTHER history surface.
 *
 * `get_cell_history` renders the legacy (non-ledger) entry itself, and its
 * author segment is a separate conditional from the one above —
 * `get-cell-history.ts:63`. `changedBy` is `z.string().nullable()`
 * (`zod-schemas.ts:61`), so null is a shape the backend is allowed to send,
 * and both existing cases in `tools.read.test.ts` pass a name. The false arm
 * was the last uncovered branch on that renderer.
 */
describe('get_cell_history author rendering', () => {
  const render = async (history: unknown[]) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue(history);
    registerTools(server as any, api as any);
    const call = server.registerTool.mock.calls.find(
      (c) => c[0] === 'get_cell_history',
    );
    const result = await call?.[2]({
      fileMsId: 'file-1',
      sheetName: 'Financing',
      cellAddress: 'B5',
    });
    return result.content[0].text as string;
  };

  it('renders no attribution segment when the entry has no author', async () => {
    const text = await render([
      {
        versionId: 'v3.0.0',
        value: '$18,500,000',
        changedBy: null,
        changedAt: '2026-05-12T15:42:56.676Z',
      },
    ]);

    expect(text).toContain('Version v3.0.0');
    expect(text).toContain('"$18,500,000"');
    expect(text).not.toContain('by ');
    expect(text).not.toContain('null');
  });

  it('still names the author when the entry has one', async () => {
    const text = await render([
      {
        versionId: 'v3.0.0',
        value: 1,
        changedBy: 'Sebastian Perez Lawrence',
        changedAt: '2026-05-12T15:42:56.676Z',
      },
    ]);

    expect(text).toContain('— by Sebastian Perez Lawrence');
  });
});
