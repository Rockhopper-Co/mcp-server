/**
 * AI attribution withheld by the organization's plan: the backend serves the
 * rows with their AI evidence stripped and says so with `aiAttribution` /
 * `lockedFrom` (body) or `X-AI-Attribution` (header). Every renderer must say
 * the attribution is withheld, never imply no AI, and never print the locked
 * value `plan_locked` as if it were a provenance or an actor kind.
 *
 * Each case asserts the exact note text by identity, and every withheld case
 * has its entitled twin first: the same rows, rendered exactly as before.
 */
import { describe, expect, it } from 'vitest';

import {
  aiAttributionFromBody,
  aiAttributionFromHeaders,
  aiAttributionSuffix,
  mergeAiAttribution,
} from '../../ai-attribution.js';
import { formatDocumentChanges } from '../../document-changes.js';
import { readLedgerPage, readLedgerSheet } from '../../ledger-changes.js';
import { changeSummarySection } from '../../prompts/change-sections.js';
import { formatAnchorHistory } from '../../tools/anchor-history-read.js';
import { cellHistoryLine } from '../../tools/cell-history-read.js';
import { formatSmartsheetCellHistory } from '../../tools/smartsheet-cell-history.js';
import type { SmartsheetCellHistory } from '../../smartsheet-types.js';
import type { DocumentAnchorHistory, LinkCheckedDocumentChanges } from '../../types.js';
import { DocumentAnchorHistorySchema, DocumentChangesResponseSchema } from '../../zod-schemas.js';
import { serveLedger, servedCell } from './ledger-mock.js';
import { createMockApiClient } from './test-helpers.js';

const DATE = '2026-11-01T00:00:00.000Z';
const DO_NOT =
  'A change listed without AI credit may still have involved AI: do not ' +
  'report that no AI was involved.';
const NOTE_ALL =
  "AI attribution is not shown on this organization's plan, so these " +
  `changes do not say whether AI was involved. ${DO_NOT}`;
const NOTE_FROM =
  "AI attribution is not shown on this organization's plan for changes " +
  `made on or after ${DATE}, so those changes do not say whether AI was ` +
  `involved. ${DO_NOT}`;
const NOTE_UNKNOWN =
  "AI attribution is not shown on this organization's plan for some or all " +
  `of these changes, so they do not say whether AI was involved. ${DO_NOT}`;
const MARK = "AI attribution not shown on this organization's plan";
const ALL = { aiAttribution: 'plan_locked', lockedFrom: null };
const FROM = { aiAttribution: 'plan_locked', lockedFrom: DATE };
const SHOWN = { aiAttribution: 'shown', lockedFrom: null };

describe('withheld AI attribution — parsing', () => {
  it('an older backend (no field, no header) and an explicit shown both read as shown', () => {
    expect(aiAttributionFromBody({})).toEqual({ kind: 'shown' });
    expect(aiAttributionFromBody(SHOWN)).toEqual({ kind: 'shown' });
    expect(aiAttributionFromBody([])).toEqual({ kind: 'shown' });
    expect(aiAttributionFromHeaders(undefined)).toEqual({ kind: 'shown' });
    expect(aiAttributionFromHeaders(new Headers())).toEqual({ kind: 'shown' });
    expect(aiAttributionFromHeaders(new Headers({ 'X-AI-Attribution': 'shown' }))).toEqual({
      kind: 'shown',
    });
  });

  it('reads a full lock, a dated lock, and a header-only lock apart', () => {
    expect(aiAttributionFromBody(ALL)).toEqual({ kind: 'withheld_all' });
    expect(aiAttributionFromBody(FROM)).toEqual({ kind: 'withheld_from', lockedFrom: DATE });
    expect(aiAttributionFromBody({ aiAttribution: 'plan_locked' })).toEqual({
      kind: 'withheld_extent_unknown',
    });
    expect(
      aiAttributionFromHeaders(new Headers({ 'X-AI-Attribution': 'plan_locked' })),
    ).toEqual({ kind: 'withheld_extent_unknown' });
  });

  it('merges reads: shown is neutral, a full lock wins, two dates keep the earlier', () => {
    const from = (lockedFrom: string) => ({ kind: 'withheld_from' as const, lockedFrom });
    expect(mergeAiAttribution({ kind: 'shown' }, from(DATE))).toEqual(from(DATE));
    expect(mergeAiAttribution(from(DATE), { kind: 'shown' })).toEqual(from(DATE));
    expect(mergeAiAttribution(from(DATE), { kind: 'withheld_all' })).toEqual({ kind: 'withheld_all' });
    expect(mergeAiAttribution(from('2026-12-01T00:00:00.000Z'), from(DATE))).toEqual(from(DATE));
    expect(mergeAiAttribution(from(DATE), { kind: 'withheld_extent_unknown' })).toEqual({
      kind: 'withheld_extent_unknown',
    });
  });

  it('the notes, by identity, and nothing when shown', () => {
    expect(aiAttributionSuffix({ kind: 'shown' })).toBe('');
    expect(aiAttributionSuffix({ kind: 'withheld_all' })).toBe(`\n\n${NOTE_ALL}`);
    expect(aiAttributionSuffix({ kind: 'withheld_from', lockedFrom: DATE })).toBe(`\n\n${NOTE_FROM}`);
    expect(aiAttributionSuffix({ kind: 'withheld_extent_unknown' })).toBe(`\n\n${NOTE_UNKNOWN}`);
  });

  it('the document envelopes parse with and without the new fields', () => {
    const old = { rows: [], truncated: false, declineReason: null, windowStart: 'w' };
    expect(DocumentChangesResponseSchema.parse(old)).not.toHaveProperty('aiAttribution');
    expect(DocumentChangesResponseSchema.parse({ ...old, ...FROM })).toMatchObject(FROM);
  });
});

const docRow = {
  eventId: '1',
  kind: 'block',
  containerProviderId: null,
  anchorProviderId: 'p-1',
  anchorLabel: null,
  changeKind: 'block_edit',
  editorPlatformId: 'u-1',
  editorName: 'Ada',
  occurredAt: '2026-11-02T10:00:00.000Z',
  firstObservedAt: '2026-11-02T10:00:01.000Z',
  fromValue: { v: 'Net 30 days' },
  toValue: { v: 'Net 60 days' },
  truncated: false,
  aiLinks: [],
};

describe('withheld AI attribution — document changes and anchor history', () => {
  const envelope = (over: Record<string, unknown>): LinkCheckedDocumentChanges =>
    DocumentChangesResponseSchema.parse({
      rows: [docRow],
      truncated: false,
      declineReason: null,
      windowStart: '2026-11-01T09:00:00.000Z',
      nextCursor: null,
      ...over,
    }) as unknown as LinkCheckedDocumentChanges;

  it('positive control: shown and absent render exactly as before', () => {
    const before = formatDocumentChanges(envelope({}), 'Memo.docx');
    expect(before).toContain('"Net 30 days" → "Net 60 days" — by Ada');
    expect(formatDocumentChanges(envelope(SHOWN), 'Memo.docx')).toBe(before);
    expect(before).not.toContain("organization's plan");
  });

  it('a full lock and a dated lock each print their note once', () => {
    const all = formatDocumentChanges(envelope(ALL), 'Memo.docx');
    expect(all).toContain('"Net 30 days" → "Net 60 days" — by Ada');
    expect(all.split(NOTE_ALL)).toHaveLength(2);
    const from = formatDocumentChanges(envelope({ ...FROM, rows: [] }), 'Memo.docx');
    expect(from).toContain('No changes recorded in this window.');
    expect(from.split(NOTE_FROM)).toHaveLength(2);
  });

  const anchor = (over: Record<string, unknown>): DocumentAnchorHistory =>
    DocumentAnchorHistorySchema.parse({
      documentType: 'text',
      anchorId: 'p-1',
      anchorLane: 'both',
      anchorIdentity: 'provider_id',
      history: [{ ...docRow, boundVersionId: 7 }],
      truncated: false,
      ...over,
    }) as DocumentAnchorHistory;

  it('anchor history: the shown body renders as before; a dated lock adds the dated note', () => {
    const before = formatAnchorHistory(anchor({}));
    expect(before).toContain('[saved in version id 7]');
    expect(formatAnchorHistory(anchor(SHOWN))).toBe(before);
    const from = formatAnchorHistory(anchor(FROM));
    expect(from).toBe(`${before}\n\n${NOTE_FROM}`);
  });
});

describe('withheld AI attribution — a locked row is never printed as a provenance', () => {
  const entry = {
    versionId: 'v3.0.0',
    value: 7,
    changedBy: 'u-1',
    changedByName: 'Ada',
    changedAt: '2026-11-02T10:00:00.000Z',
    aiLinks: [],
    formula: '=A1+1',
  };

  it('positive control: an unlocked row still prints its formatted line verbatim', () => {
    const formatted = 'v3.0.0: 7 [=A1+1] — human_direct (by u-1) — 2026-11-02T10:00:00.000Z';
    expect(cellHistoryLine({ ...entry, provenance: 'human_direct', actorKind: 'human', formatted })).toBe(
      `- ${formatted}`,
    );
  });

  it('a plan_locked row prints the withheld mark and never the raw value', () => {
    const line = cellHistoryLine({
      ...entry,
      provenance: 'plan_locked',
      actorKind: 'plan_locked',
      drivingHuman: null,
      formatted: 'v3.0.0: 7 [=A1+1] — plan_locked (by u-1) — 2026-11-02T10:00:00.000Z',
    });
    expect(line).toBe(
      `- Version v3.0.0: **7** [=A1+1] — by Ada — ${MARK} — 2026-11-02T10:00:00.000Z`,
    );
    expect(line).not.toContain('plan_locked');
  });

  const sheet = (history: unknown[], over: Partial<SmartsheetCellHistory> = {}) =>
    formatSmartsheetCellHistory(
      { rowAnchorId: 'r', columnAnchorId: 'c', history: history as never, truncated: false, ...over },
      null,
    );
  const ssEntry = {
    eventType: 'cell_edit',
    fromValue: 1,
    toValue: 2,
    attributionConfidence: 'high',
    coalesced: false,
    changedAt: '2026-11-02T10:00:00.000Z',
  };

  it('Smartsheet: an unlocked row as before; a locked one names neither plan_locked nor "not recorded"', () => {
    const before = sheet([{ ...ssEntry, provenance: 'human_direct', actorKind: 'human', actorPlatformId: 'u-1' }]);
    expect(before).toContain('— human_direct, by human u-1 (attribution high)');
    expect(before).not.toContain("organization's plan");
    const locked = sheet(
      [{ ...ssEntry, provenance: 'plan_locked', actorKind: 'plan_locked', actorPlatformId: null }],
      FROM,
    );
    expect(locked).toContain(`— source not shown, actor not shown (attribution high) — ${MARK}`);
    expect(locked).not.toContain('plan_locked');
    expect(locked).not.toContain('actor not recorded');
    expect(locked.split(NOTE_FROM)).toHaveLength(2);
  });
});

describe('withheld AI attribution — the ledger compare reads', () => {
  const withBody = (api: ReturnType<typeof createMockApiClient>, fields: Record<string, unknown>) => {
    const page = api.getCompareSheet.getMockImplementation();
    api.getCompareSheet.mockImplementation(async (...args: unknown[]) => ({
      ...(await page?.(...args)),
      ...fields,
    }));
  };

  it('an entitled page carries no aiAttribution key, so it serialises as before', async () => {
    const api = createMockApiClient();
    serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'A1' })] }]);
    withBody(api, SHOWN);
    const read = await readLedgerPage(api as never, 11);
    expect(read.changes).toHaveLength(1);
    expect(read).not.toHaveProperty('aiAttribution');
  });

  it('a dated lock on a page reaches the file-wide and the sheet read', async () => {
    const api = createMockApiClient();
    serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'A1' })] }]);
    withBody(api, FROM);
    const read = await readLedgerPage(api as never, 11);
    expect(read.changes).toHaveLength(1);
    expect(read.aiAttribution).toEqual({ kind: 'withheld_from', lockedFrom: DATE });
    const sheetRead = await readLedgerSheet(api as never, 11, 'Sheet1');
    expect(sheetRead.changes).toHaveLength(1);
    expect(sheetRead.aiAttribution).toEqual({ kind: 'withheld_from', lockedFrom: DATE });
  });
});

describe('withheld AI attribution — the change-summary prompt section', () => {
  const file = { internalId: 11, platformId: 'file-1', fileType: 'microsoft_xlsx', name: 'Budget.xlsx' } as never;
  const page = { changes: [], nextCursor: null, totalCount: 0, snapshotId: 's', aiLinksAvailable: true };

  it('says nothing extra when shown, and the dated note once when withheld', () => {
    const shown = changeSummarySection({ kind: 'spreadsheet', file, page });
    expect(shown).toBe('## Unattributed Changes (0 total)\nNone');
    const wide = changeSummarySection({
      kind: 'spreadsheet',
      file,
      page: { ...page, aiAttribution: { kind: 'withheld_from', lockedFrom: DATE } },
    });
    expect(wide).toBe(`## Unattributed Changes (0 total)\nNone\n\n${NOTE_FROM}`);
    const sheet = changeSummarySection({
      kind: 'spreadsheet_sheet',
      file,
      sheetName: 'Sheet1',
      changes: [],
      aiLinksAvailable: true,
      aiAttribution: { kind: 'withheld_all' },
    });
    expect(sheet).toBe(`## Unattributed Changes (0 total)\nNone\n\n${NOTE_ALL}`);
  });
});
