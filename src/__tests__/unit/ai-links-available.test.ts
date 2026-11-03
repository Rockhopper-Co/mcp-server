/**
 * ENG-8332 — structural rows print their AI clause, document rows name their
 * editor, and a read whose AI links could not be checked SAYS so, once per
 * tool output, rather than reading as "no AI".
 *
 * Every "prints nothing extra" case first proves the rows printed: an absence
 * assertion on an empty output passes for a renderer that printed nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  AI_LINKS_UNAVAILABLE_NOTE,
  formatSpreadsheetChangeRows,
} from '../../change-row-vocabulary.js';
import { formatDocumentChanges, formatDocumentRow } from '../../document-changes.js';
import { aiLinksAvailableFromHeaders } from '../../ledger-freshness.js';
import { readLedgerPage, sheetLevelRows, sheetPageRows } from '../../ledger-changes.js';
import { registerTools } from '../../tools/index.js';
import type { DocumentChangeRow, LinkCheckedDocumentChanges } from '../../types.js';
import { DocumentChangesResponseSchema } from '../../zod-schemas.js';
import { serveLedger, servedCell } from './ledger-mock.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const COPILOT = {
  vendor: 'microsoft_copilot',
  evidenceKind: 'response_literal',
  promptId: '4182',
};
const NOTE = 'AI credits could not be checked for this read.';

describe('structural rows print their AI clause (ENG-8332)', () => {
  it('a row band, by value', () => {
    const rows = sheetPageRows({
      sheetName: 'Sheet1',
      cellChanges: [],
      rowColumnChanges: {
        rowDeletions: [
          { address: '5:5', userPlatformId: 'u-1', byUserName: 'Ada', aiLinks: [COPILOT] },
          { address: '9:9', userPlatformId: 'u-1', byUserName: 'Ada', aiLinks: [] },
        ],
      },
      nextCursor: null,
    });
    expect(formatSpreadsheetChangeRows(rows)).toBe(
      '- **Sheet1!5:5** (row deleted) — by Ada — ' +
        'AI: microsoft_copilot (response_literal, prompt 4182)\n' +
        // POSITIVE CONTROL — the unlinked band printed, with no clause.
        '- **Sheet1!9:9** (row deleted) — by Ada',
    );
  });

  it('a sheet item, by value', () => {
    const rows = sheetLevelRows({
      added: [{ sheet: 'Q3', byUserPlatformId: 'u-1', byUserName: 'Ada', aiLinks: [COPILOT] }],
    });
    expect(formatSpreadsheetChangeRows(rows)).toBe(
      '- **Q3!** (sheet added) — by Ada — ' +
        'AI: microsoft_copilot (response_literal, prompt 4182)',
    );
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
  aiLinks: [],
  ...over,
});

describe('document rows name their editor (ENG-8332)', () => {
  it('prints editorName in place of the raw editor id', () => {
    const text = formatDocumentRow(docRow({ editorName: 'Ada Lovelace' }));
    expect(text).toBe(
      '- **w14-paraId-7A3B** (text): "Net 30 days" → "Net 60 days" — by Ada Lovelace — ' +
        '2026-10-29T10:00:00.000Z',
    );
    expect(text).not.toContain('editor-1');
  });

  it('falls back to the editor id when no name is served', () => {
    for (const editorName of [null, undefined]) {
      expect(formatDocumentRow(docRow({ editorName }))).toContain(' — by editor-1 — ');
    }
  });
});

const envelope = (
  over: Partial<LinkCheckedDocumentChanges>,
): LinkCheckedDocumentChanges => ({
  rows: [docRow({})],
  truncated: false,
  declineReason: null,
  windowStart: '2026-10-29T09:00:00.000Z',
  nextCursor: null,
  aiLinksAvailable: true,
  ...over,
});

describe('aiLinksAvailable — parsed, defaulted, and printed (ENG-8332)', () => {
  it('keeps the wording in the vocabulary', () => {
    expect(AI_LINKS_UNAVAILABLE_NOTE).toBe(NOTE);
  });

  it('a document response without the field parses as true; a sent false is kept', () => {
    const old = { rows: [], truncated: false, declineReason: null, windowStart: 'w' };
    expect(DocumentChangesResponseSchema.parse(old).aiLinksAvailable).toBe(true);
    expect(
      DocumentChangesResponseSchema.parse({ ...old, aiLinksAvailable: false }).aiLinksAvailable,
    ).toBe(false);
  });

  it('a cell-history response without the header reads as true; "false" reads false', () => {
    const headers = (value: string | null) => ({ get: () => value });
    expect(aiLinksAvailableFromHeaders(undefined)).toBe(true);
    expect(aiLinksAvailableFromHeaders(headers(null))).toBe(true);
    expect(aiLinksAvailableFromHeaders(headers('true'))).toBe(true);
    expect(aiLinksAvailableFromHeaders(headers('false'))).toBe(false);
  });

  it('document changes print the note once when false, and not when true', () => {
    const checked = formatDocumentChanges(envelope({}), 'Memo.docx');
    expect(checked).toContain('"Net 30 days" → "Net 60 days"');
    expect(checked).not.toContain(NOTE);
    const unchecked = formatDocumentChanges(envelope({ aiLinksAvailable: false }), 'Memo.docx');
    expect(unchecked).toContain('"Net 30 days" → "Net 60 days"');
    expect(unchecked.split(NOTE)).toHaveLength(2);
    // An empty window that could not be checked says so too.
    expect(formatDocumentChanges(envelope({ rows: [], aiLinksAvailable: false }), 'Memo.docx'))
      .toContain(NOTE);
  });

  it('a ledger page reads absent as true, and false when the summary or any page says so', async () => {
    const api = createMockApiClient();
    serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'A1' })] }]);
    expect((await readLedgerPage(api as never, 11)).aiLinksAvailable).toBe(true);
    const page = api.getCompareSheet.getMockImplementation();
    api.getCompareSheet.mockImplementation(async (...args: unknown[]) => ({
      ...(await page?.(...args)),
      aiLinksAvailable: false,
    }));
    const read = await readLedgerPage(api as never, 11);
    expect(read.changes).toHaveLength(1);
    expect(read.aiLinksAvailable).toBe(false);
  });

  const tool = async (name: string, args: Record<string, unknown>, setup: (api: ReturnType<typeof createMockApiClient>) => void) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    setup(api);
    registerTools(server as never, api as never);
    const call = server.registerTool.mock.calls.find((c) => c[0] === name);
    const result = await call?.[2](args);
    return result.content[0].text as string;
  };

  it('get_unattributed_changes prints the note once when the compare read could not check', async () => {
    const serve = (available: boolean | undefined) => (api: ReturnType<typeof createMockApiClient>) => {
      serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'A1' })] }]);
      const summary = api.getCompareSummary.getMockImplementation();
      api.getCompareSummary.mockImplementation(async (...args: unknown[]) => ({
        ...(await summary?.(...args)),
        ...(available === undefined ? {} : { aiLinksAvailable: available }),
      }));
    };
    const unchecked = await tool('get_unattributed_changes', { fileMsId: 'file-1' }, serve(false));
    expect(unchecked).toContain('**Sheet1!A1**');
    expect(unchecked.split(NOTE)).toHaveLength(2);
    const old = await tool('get_unattributed_changes', { fileMsId: 'file-1' }, serve(undefined));
    expect(old).toContain('**Sheet1!A1**');
    expect(old).not.toContain(NOTE);
    const sheet = await tool(
      'get_unattributed_changes',
      { fileMsId: 'file-1', sheetName: 'Sheet1' },
      serve(false),
    );
    expect(sheet).toContain('**Sheet1!A1**');
    expect(sheet.split(NOTE)).toHaveLength(2);
  });

  it('get_cell_history prints the note once when the header said false', async () => {
    const entry = {
      versionId: 'v3.0.0',
      value: 7,
      changedBy: 'u-1',
      changedAt: '2026-10-29T10:00:00.000Z',
      aiLinks: [],
    };
    const serve = (available: boolean | null) => (api: ReturnType<typeof createMockApiClient>) => {
      api.getCellHistory.mockImplementation(
        async (_f: string, _s: string, _c: string, opts?: { onAiLinksAvailable?: (a: boolean) => void }) => {
          if (available !== null) opts?.onAiLinksAvailable?.(available);
          return [entry];
        },
      );
    };
    const args = { fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'B5' };
    const unchecked = await tool('get_cell_history', args, serve(false));
    expect(unchecked).toContain('- Version v3.0.0: **7**');
    expect(unchecked.split(NOTE)).toHaveLength(2);
    for (const available of [true, null]) {
      const checked = await tool('get_cell_history', args, serve(available));
      expect(checked).toContain('- Version v3.0.0: **7**');
      expect(checked).not.toContain(NOTE);
    }
  });
});
