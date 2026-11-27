/**
 * AI attribution withheld by the organization's plan, through the tools.
 *
 * The cell arm of `get_cell_history` is driven through the REAL ApiClient over
 * a stubbed fetch with real `Headers`, so the `X-AI-Attribution` wire header
 * and the coded 403 body are what is under test, not a parsed fixture. Every
 * withheld case has its entitled twin first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../../api-client.js';
import {
  isPlanExcludesFeature,
  planExcludesFeatureToolResult,
} from '../../plan-excludes-feature.js';
import { registerTools } from '../../tools/index.js';
import { serveLedger, servedCell } from './ledger-mock.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const DATE = '2026-11-01T00:00:00.000Z';
const DO_NOT =
  'A change listed without AI credit may still have involved AI: do not ' +
  'report that no AI was involved.';
const NOTE_UNKNOWN =
  "AI attribution is not shown on this organization's plan for some or all " +
  `of these changes, so they do not say whether AI was involved. ${DO_NOT}`;
const NOTE_FROM =
  "AI attribution is not shown on this organization's plan for changes " +
  `made on or after ${DATE}, so those changes do not say whether AI was ` +
  `involved. ${DO_NOT}`;
const MARK = "AI attribution not shown on this organization's plan";
const REFUSAL_BODY = {
  statusCode: 403,
  error: 'Forbidden',
  message: "Your organization's plan does not include this",
  code: 'plan_excludes_feature',
};

type Wire = { status?: number; body: unknown; headers?: Record<string, string> };

/** A real ApiClient whose fetch answers every request with `wire`. */
function wired(wire: Wire) {
  const status = wire.status ?? 200;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: status < 400,
        status,
        statusText: status < 400 ? 'OK' : 'Forbidden',
        headers: new Headers(wire.headers ?? {}),
        json: () => Promise.resolve(wire.body),
        text: () => Promise.resolve(JSON.stringify(wire.body)),
      }),
    ),
  );
  const real = new ApiClient({ baseUrl: 'https://api.test', token: 't' });
  const api = createMockApiClient();
  api.getCellHistory.mockImplementation((...a: unknown[]) =>
    (real.getCellHistory as (...x: unknown[]) => unknown)(...a),
  );
  const server = createMockMcpServer();
  registerTools(server as never, api as never);
  const handler = server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_cell_history',
  )![2];
  return { handler, real };
}

const cellArgs = { fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'A1' };
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

const human = {
  versionId: 'v1.0.0',
  value: 5,
  changedBy: 'u-1',
  changedAt: '2026-10-01T00:00:00.000Z',
  provenance: 'human_direct',
  formatted: 'v1.0.0: 5 — human_direct (by u-1) — 2026-10-01T00:00:00.000Z',
};
const locked = {
  versionId: 'v2.0.0',
  value: 6,
  changedBy: 'u-1',
  changedAt: '2026-11-02T00:00:00.000Z',
  provenance: 'plan_locked',
  actorKind: 'plan_locked',
  drivingHuman: null,
  formatted: 'v2.0.0: 6 — plan_locked (by u-1) — 2026-11-02T00:00:00.000Z',
};

describe('get_cell_history — withheld AI attribution over the wire', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('positive control: an entitled answer (header shown, or none) renders as before', async () => {
    const before =
      'Cell A1 on "Sheet1" — 1 change(s):\n\n' +
      '- v1.0.0: 5 — human_direct (by u-1) — 2026-10-01T00:00:00.000Z';
    expect(text(await wired({ body: [human] }).handler(cellArgs))).toBe(before);
    const shown = wired({ body: [human], headers: { 'X-AI-Attribution': 'shown' } });
    expect(text(await shown.handler(cellArgs))).toBe(before);
  });

  it('the header lock prints the note once, and a locked row never prints plan_locked', async () => {
    const { handler } = wired({
      body: [human, locked],
      headers: { 'X-AI-Attribution': 'plan_locked' },
    });
    const out = text(await handler(cellArgs));
    expect(out).toContain('- v1.0.0: 5 — human_direct (by u-1) — 2026-10-01T00:00:00.000Z');
    expect(out).toContain(`- Version v2.0.0: **6** — by u-1 — ${MARK} — 2026-11-02T00:00:00.000Z`);
    expect(out.split(NOTE_UNKNOWN)).toHaveLength(2);
    expect(out).not.toContain('plan_locked');
  });

  it('renders plan_excludes_feature by its code, not as a generic failure', async () => {
    const { handler, real } = wired({ status: 403, body: REFUSAL_BODY });
    // The client carried the backend's code onto the error.
    const err = await real.getCellHistory('file-1', 'Sheet1', 'A1').catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe('plan_excludes_feature');
    expect(isPlanExcludesFeature(err)).toBe(true);
    const result = await handler(cellArgs);
    expect(result.isError).toBe(true);
    expect(result).toEqual(planExcludesFeatureToolResult());
    const out = text(result);
    expect(out.startsWith('PLAN_EXCLUDES_FEATURE — this is NOT a result')).toBe(true);
    expect(out).toContain('{"status":"refused","code":"plan_excludes_feature"}');
    expect(out).not.toContain('Failed to get cell history');
  });

  it('positive control: a 403 without that code stays the generic failure', async () => {
    const { handler } = wired({ status: 403, body: { statusCode: 403, message: 'Forbidden' } });
    const out = text(await handler(cellArgs));
    expect(out.startsWith('Failed to get cell history: Rockhopper API 403')).toBe(true);
    expect(out).not.toContain('PLAN_EXCLUDES_FEATURE');
  });

  it('matches the code carried as a cause too', () => {
    expect(isPlanExcludesFeature(new Error('x', { cause: { code: 'plan_excludes_feature' } }))).toBe(true);
    expect(isPlanExcludesFeature(new Error('x'))).toBe(false);
    expect(isPlanExcludesFeature(null)).toBe(false);
  });
});

describe('get_unattributed_changes and the anchor arm — withheld AI attribution', () => {
  const tool = async (
    name: string,
    args: Record<string, unknown>,
    setup: (api: ReturnType<typeof createMockApiClient>) => void,
  ) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    setup(api);
    registerTools(server as never, api as never);
    const call = server.registerTool.mock.calls.find((c) => c[0] === name);
    return (await call?.[2](args)) as { content: Array<{ text: string }>; isError?: boolean };
  };
  const ledger = (fields: Record<string, unknown>) => (api: ReturnType<typeof createMockApiClient>) => {
    serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'A1' })] }]);
    const summary = api.getCompareSummary.getMockImplementation();
    api.getCompareSummary.mockImplementation(async (...args: unknown[]) => ({
      ...(await summary?.(...args)),
      ...fields,
    }));
  };

  it('file-wide and sheet mode: shown prints no note; a dated lock prints it once', async () => {
    const shown = text(await tool('get_unattributed_changes', { fileMsId: 'file-1' }, ledger({ aiAttribution: 'shown', lockedFrom: null })));
    expect(shown).toContain('**Sheet1!A1**');
    expect(shown).not.toContain("organization's plan");
    const lockedFrom = { aiAttribution: 'plan_locked', lockedFrom: DATE };
    const wide = text(await tool('get_unattributed_changes', { fileMsId: 'file-1' }, ledger(lockedFrom)));
    expect(wide).toContain('**Sheet1!A1**');
    expect(wide.split(NOTE_FROM)).toHaveLength(2);
    const sheet = text(
      await tool('get_unattributed_changes', { fileMsId: 'file-1', sheetName: 'Sheet1' }, ledger(lockedFrom)),
    );
    expect(sheet).toContain('**Sheet1!A1**');
    expect(sheet.split(NOTE_FROM)).toHaveLength(2);
  });

  it('get_unattributed_changes renders the refusal by its code', async () => {
    const err = Object.assign(new Error('Rockhopper API 403'), { code: 'plan_excludes_feature' });
    const result = await tool('get_unattributed_changes', { fileMsId: 'file-1' }, (api) => {
      api.getCompareSummary.mockRejectedValue(err);
    });
    expect(result).toEqual(planExcludesFeatureToolResult());
  });

  it('the anchor and Smartsheet arms render the refusal by its code', async () => {
    const err = Object.assign(new Error('Rockhopper API 403'), { code: 'plan_excludes_feature' });
    const anchor = await tool('get_cell_history', { fileMsId: 'file-1', anchorId: 'p-1' }, (api) => {
      api.getAnchorHistory.mockRejectedValue(err);
    });
    expect(anchor).toEqual(planExcludesFeatureToolResult());
    const smartsheet = await tool(
      'get_cell_history',
      { fileMsId: 'file-1', rowAnchorId: 'r', columnAnchorId: 'c' },
      (api) => {
        api.getEnrolledFile.mockResolvedValue({ internalId: 11, platformId: 'file-1', fileType: 'smartsheet_sheet', name: 'Plan' });
        api.getSmartsheetCellHistory.mockRejectedValue(err);
      },
    );
    expect(smartsheet).toEqual(planExcludesFeatureToolResult());
  });
});
