/**
 * ENG-8331 — each change row carries its AI links (vendor, evidence kind,
 * prompt id) through to the text an AI client reads, and the cell history
 * names its actor by display name.
 *
 * Every positive case is matched by VALUE, and every "prints nothing extra"
 * case first proves the row itself printed — an absence assertion on an empty
 * string passes for a renderer that printed nothing at all.
 */
import { describe, expect, it } from 'vitest';

import { formatSpreadsheetChangeRows } from '../../change-row-vocabulary.js';
import { formatDocumentRow } from '../../document-changes.js';
import { sheetLevelRows, sheetPageRows } from '../../ledger-changes.js';
import { registerTools } from '../../tools/index.js';
import type { DocumentChangeRow } from '../../types.js';
import {
  CellHistoryEntrySchema,
  DocumentChangeRowSchema,
} from '../../zod-schemas.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const COPILOT = {
  vendor: 'Microsoft Copilot',
  evidenceKind: 'named_sheet',
  promptId: 'prompt-1',
};
const CHATGPT = {
  vendor: 'ChatGPT',
  evidenceKind: 'content_match',
  promptId: 'prompt-2',
};

const cell = (over: Record<string, unknown>) => ({
  sheetName: 'Sheet1',
  cellAddress: 'A1',
  changeType: 'cell',
  editType: 'value',
  oldValue: { v: 1 },
  newValue: { v: 2 },
  byUserPlatformId: null,
  byUserName: 'Ada',
  createdAt: '2026-10-29T10:00:00.000Z',
  ...over,
});

describe('formatSpreadsheetChangeRows — AI links (ENG-8331)', () => {
  it('prints one clause per linked row, by value', () => {
    expect(formatSpreadsheetChangeRows([cell({ aiLinks: [COPILOT] })])).toBe(
      '- **Sheet1!A1** (value): {"v":1} → {"v":2} — by Ada — ' +
        'AI: Microsoft Copilot (named_sheet, prompt prompt-1) — ' +
        '2026-10-29T10:00:00.000Z',
    );
  });

  it('comma-joins several links in one clause', () => {
    const text = formatSpreadsheetChangeRows([cell({ aiLinks: [COPILOT, CHATGPT] })]);
    expect(text).toContain(
      ' — AI: Microsoft Copilot (named_sheet, prompt prompt-1), ' +
        'ChatGPT (content_match, prompt prompt-2) — ',
    );
  });

  it('prints nothing extra for a row with no links, or none sent', () => {
    const plain =
      '- **Sheet1!A1** (value): {"v":1} → {"v":2} — by Ada — 2026-10-29T10:00:00.000Z';
    expect(formatSpreadsheetChangeRows([cell({ aiLinks: [] })])).toBe(plain);
    expect(formatSpreadsheetChangeRows([cell({})])).toBe(plain);
  });
});

const docRow = (over: Partial<DocumentChangeRow>): DocumentChangeRow => ({
  eventId: '1',
  kind: 'block',
  containerProviderId: null,
  anchorProviderId: 'w14-paraId-7A3B',
  anchorLabel: null,
  changeKind: 'block_edit',
  editorPlatformId: 'editor-1',
  occurredAt: '2026-10-29T10:00:00.000Z',
  firstObservedAt: '2026-10-29T10:00:01.000Z',
  fromValue: { v: 'Net 30 days' },
  toValue: { v: 'Net 60 days' },
  truncated: false,
  ...over,
});

describe('formatDocumentRow — AI links (ENG-8331)', () => {
  it('prints the clause after the editor, by value', () => {
    expect(formatDocumentRow(docRow({ aiLinks: [COPILOT] }))).toBe(
      '- **w14-paraId-7A3B** (text): "Net 30 days" → "Net 60 days" — by editor-1 — ' +
        'AI: Microsoft Copilot (named_sheet, prompt prompt-1) — 2026-10-29T10:00:00.000Z',
    );
  });

  it('prints nothing extra with no links', () => {
    expect(formatDocumentRow(docRow({ aiLinks: [] }))).toBe(
      '- **w14-paraId-7A3B** (text): "Net 30 days" → "Net 60 days" — by editor-1 — ' +
        '2026-10-29T10:00:00.000Z',
    );
  });
});

describe('schemas — an older backend sends no aiLinks (ENG-8331)', () => {
  it('parses a cell-history entry without aiLinks or changedByName', () => {
    const parsed = CellHistoryEntrySchema.parse({
      versionId: 'v1.0.0',
      value: 1,
      changedBy: 'user-1',
      changedAt: '2026-10-29T10:00:00.000Z',
    });
    expect(parsed.aiLinks).toEqual([]);
    expect(parsed.versionId).toBe('v1.0.0');
  });

  it('keeps aiLinks and changedByName when the backend sends them', () => {
    const parsed = CellHistoryEntrySchema.parse({
      versionId: 'v1.0.0',
      value: 1,
      changedBy: 'user-1',
      changedByName: 'Ada',
      changedAt: '2026-10-29T10:00:00.000Z',
      aiLinks: [COPILOT],
    });
    expect(parsed).toMatchObject({ changedByName: 'Ada', aiLinks: [COPILOT] });
  });

  it('defaults a document row without aiLinks to [] and keeps a sent one', () => {
    const old = docRow({});
    expect('aiLinks' in old).toBe(false);
    expect(DocumentChangeRowSchema.parse(old).aiLinks).toEqual([]);
    expect(DocumentChangeRowSchema.parse({ ...old, aiLinks: [CHATGPT] }).aiLinks).toEqual([
      CHATGPT,
    ]);
  });
});

describe('ledger row mapping carries aiLinks (ENG-8331)', () => {
  it('copies a served cell and band link by value, [] when absent', () => {
    const rows = sheetPageRows({
      sheetName: 'Sheet1',
      cellChanges: [
        { cell: 'A1', cell1: { v: 1 }, cell2: { v: 2 }, byUserPlatformId: null, aiLinks: [COPILOT] },
        { cell: 'A2', cell1: { v: 1 }, cell2: { v: 2 }, byUserPlatformId: null },
      ],
      rowColumnChanges: {
        rowInsertions: [{ address: '5:5', userPlatformId: null, aiLinks: [CHATGPT] }],
      },
      nextCursor: null,
    });
    expect(rows.map((r) => [r.cellAddress, r.aiLinks])).toEqual([
      ['5:5', [CHATGPT]],
      ['A1', [COPILOT]],
      ['A2', []],
    ]);
  });

  it('copies a sheet-level link by value', () => {
    const [added] = sheetLevelRows({
      added: [{ sheet: 'New', byUserPlatformId: null, aiLinks: [COPILOT] }],
    });
    expect(added.aiLinks).toEqual([COPILOT]);
  });
});

describe('get_cell_history — actor name and AI links (ENG-8331)', () => {
  const render = async (history: unknown[]) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getCellHistory.mockResolvedValue(history);
    registerTools(server as never, api as never);
    const call = server.registerTool.mock.calls.find((c) => c[0] === 'get_cell_history');
    const result = await call?.[2]({ fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'B5' });
    return result.content[0].text as string;
  };
  const entry = {
    versionId: 'v3.0.0',
    value: 7,
    changedBy: 'platform-id-1',
    changedAt: '2026-10-29T10:00:00.000Z',
  };

  it('prefers changedByName and prints the clause, by value', async () => {
    const text = await render([{ ...entry, changedByName: 'Ada', aiLinks: [COPILOT] }]);
    expect(text).toContain(
      '- Version v3.0.0: **7** — by Ada — ' +
        'AI: Microsoft Copilot (named_sheet, prompt prompt-1) — 2026-10-29T10:00:00.000Z',
    );
    expect(text).not.toContain('platform-id-1');
  });

  it('falls back to changedBy and prints nothing extra with no links', async () => {
    const text = await render([{ ...entry, changedByName: null, aiLinks: [] }]);
    expect(text).toContain(
      '- Version v3.0.0: **7** — by platform-id-1 — 2026-10-29T10:00:00.000Z',
    );
    expect(text).not.toContain('AI:');
  });

  it('appends the clause to a backend-formatted line', async () => {
    const text = await render([
      { ...entry, formatted: 'v3.0.0: 7 — ai_auto — 2026-10-29T10:00:00.000Z', aiLinks: [CHATGPT] },
    ]);
    expect(text).toContain(
      '- v3.0.0: 7 — ai_auto — 2026-10-29T10:00:00.000Z — ' +
        'AI: ChatGPT (content_match, prompt prompt-2)',
    );
  });
});
