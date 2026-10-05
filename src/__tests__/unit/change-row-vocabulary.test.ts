/**
 * ENG-6608 — PIN: the words this server prints on a change row are the change
 * log's words, pair for pair.
 *
 * MIRRORS frontend `packages/shared-ui/src/components/ChangeLog/changeLogVocabulary.ts`
 * (`editTypeLabels`, `systemCauseLabels`), read through
 * `packages/shared-ui/src/services/document-change-kinds.ts!CHANGE_KIND_MEANING`,
 * `components/ChangeLog/changeLabel.ts!cellChangeLabel` / `sheetChangeLabel` /
 * `rowColumnChangeLabel`, `change-log-value-kind.ts` (the `design:` parts) and
 * `components/ChangeLog/valueSide.ts` (`EMPTY_SIDE`, `UNCAPTURED_SIDE`).
 *
 * This package ships on npm and cannot import the frontend, so the words are
 * copied — and every pair is written out HERE, by identity, so a word changed
 * on one side and not the other reds this file. When the frontend changes a
 * word, change it in `src/change-row-vocabulary.ts` and here, in one PR.
 */
import { describe, expect, it } from 'vitest';

import {
  DESIGN_PART_WORDS,
  DOCUMENT_CHANGE_KIND_CAUSES,
  DOCUMENT_CHANGE_KIND_WORDS,
  EMPTY_SIDE,
  SPREADSHEET_EDIT_TYPE_WORDS,
  SPREADSHEET_STRUCTURAL_WORDS,
  UNCAPTURED_SIDE,
  formatSpreadsheetChangeRows,
} from '../../change-row-vocabulary.js';

describe('the change-row words are the change log words', () => {
  it('maps every document change kind to its row word', () => {
    expect(DOCUMENT_CHANGE_KIND_WORDS).toEqual({
      block_edit: 'text',
      block_insert: 'added',
      block_delete: 'removed',
      block_split: 'split',
      block_merge: 'merged',
      block_field_regenerated: 'text',
      block_format: 'formatting',
      document_design: 'formatting',
      shape_edit: 'text',
      shape_format: 'formatting',
      shape_insert: 'added',
      shape_delete: 'removed',
      slide_insert: 'added',
      slide_delete: 'removed',
      slide_reorder: 'moved',
      slide_design: 'design',
    });
  });

  it('names the one system cause a document kind carries', () => {
    expect(DOCUMENT_CHANGE_KIND_CAUSES).toEqual({
      block_field_regenerated: 'Updated by Word',
    });
  });

  it('names a design part by its anchor prefix', () => {
    expect(DESIGN_PART_WORDS).toEqual([
      ['design:layout:', 'layout'],
      ['design:master:', 'master'],
      ['design:theme:', 'theme'],
    ]);
  });

  it('maps every spreadsheet edit type to its row word', () => {
    expect(SPREADSHEET_EDIT_TYPE_WORDS).toEqual({
      value: 'value',
      format: 'format',
      formula: 'formula',
      formula_recalc: 'formula, same result',
      value_and_format: 'value and format',
    });
  });

  it('maps every structural spreadsheet change to its row word', () => {
    expect(SPREADSHEET_STRUCTURAL_WORDS).toEqual({
      sheet_add: 'sheet added',
      sheet_delete: 'sheet removed',
      sheet_rename: 'sheet renamed',
      sheet_reorder: 'sheet moved',
      row_insert: 'row inserted',
      row_delete: 'row deleted',
      column_insert: 'column inserted',
      column_delete: 'column deleted',
    });
  });

  it('uses the change log side words', () => {
    expect([EMPTY_SIDE, UNCAPTURED_SIDE]).toEqual(['—', 'Not recorded']);
  });
});

const cell = (over: Record<string, unknown>) => ({
  sheetName: 'Sheet1',
  cellAddress: 'A1',
  changeType: 'cell',
  editType: 'value',
  oldValue: { v: 1, t: 'n' },
  newValue: { v: 2, t: 'n' },
  byUserPlatformId: null,
  byUserName: null,
  createdAt: '2026-09-15T10:00:00.000Z',
  ...over,
});

describe('formatSpreadsheetChangeRows — the row word, never the change type', () => {
  it('names a cell edit by its edit type, not "cell"', () => {
    expect(formatSpreadsheetChangeRows([cell({})])).toBe(
      '- **Sheet1!A1** (value): {"v":1,"t":"n"} → {"v":2,"t":"n"} — ' +
        '2026-09-15T10:00:00.000Z',
    );
  });

  it('keeps "formula, same result" word for word', () => {
    const text = formatSpreadsheetChangeRows([
      cell({ editType: 'formula_recalc', byUserName: 'Ada' }),
    ]);
    expect(text).toContain('(formula, same result):');
    expect(text).toContain('— by Ada —');
  });

  it('prints NO word when the edit type is absent or unknown', () => {
    for (const editType of [null, undefined, 'teleport']) {
      expect(formatSpreadsheetChangeRows([cell({ editType })])).toBe(
        '- **Sheet1!A1**: {"v":1,"t":"n"} → {"v":2,"t":"n"} — ' +
          '2026-09-15T10:00:00.000Z',
      );
    }
  });

  it('prints NO word for an unknown change type, and keeps its sides', () => {
    const text = formatSpreadsheetChangeRows([cell({ changeType: 'update' })]);
    expect(text).toBe(
      '- **Sheet1!A1**: {"v":1,"t":"n"} → {"v":2,"t":"n"} — ' +
        '2026-09-15T10:00:00.000Z',
    );
    expect(text).not.toContain('update');
  });

  it('names a structural change and prints no value sides for it', () => {
    expect(
      formatSpreadsheetChangeRows([
        cell({
          changeType: 'row_insert',
          cellAddress: '5:5',
          oldValue: null,
          newValue: null,
          byUserPlatformId: 'ms-1',
        }),
      ]),
    ).toBe('- **Sheet1!5:5** (row inserted) — by ms-1 — 2026-09-15T10:00:00.000Z');
  });
});

describe('formatSpreadsheetChangeRows — a sheet reorder (ENG-6917)', () => {
  // The backend serves the 0-based tab positions in the value columns
  // (backend ENG-6913, `file-handler.service.ts` reorder save); the change log
  // reads "sheet moved" and counts positions from 1
  // (`changeLabel.ts!sheetChangeLabel`, `UserStructuralChange.tsx`).
  const reorder = (over: Record<string, unknown>) =>
    cell({
      sheetName: 'Budget',
      cellAddress: '',
      changeType: 'sheet_reorder',
      editType: null,
      oldValue: { t: 'n', v: 0 },
      newValue: { t: 'n', v: 2 },
      byUserName: 'Ada',
      ...over,
    });

  it('names a reorder "sheet moved" with both tab positions counted from 1', () => {
    expect(formatSpreadsheetChangeRows([reorder({})])).toBe(
      '- **Budget!** (sheet moved): position 1 → 3 — by Ada — ' +
        '2026-09-15T10:00:00.000Z',
    );
  });

  it('prints no positions, and no raw values, when a side is not a position', () => {
    expect(
      formatSpreadsheetChangeRows([reorder({ oldValue: null })]),
    ).toBe('- **Budget!** (sheet moved) — by Ada — 2026-09-15T10:00:00.000Z');
  });
});

describe('formatSpreadsheetChangeRows — the two side words, and no third', () => {
  it('says Not recorded for a side with no stored value', () => {
    const text = formatSpreadsheetChangeRows([
      cell({ oldValue: null, newValue: undefined }),
    ]);
    expect(text).toContain(': Not recorded → Not recorded —');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('says — for a side that renders to nothing', () => {
    for (const blank of ['', '  ', { v: '' }, {}, { v: null, w: ' ' }]) {
      expect(
        formatSpreadsheetChangeRows([cell({ newValue: blank })]),
      ).toContain('{"v":1,"t":"n"} → — —');
    }
  });

  it('keeps a side that shows something, even when only its formula does', () => {
    const text = formatSpreadsheetChangeRows([
      cell({ newValue: { v: '', f: 'A2' }, oldValue: 0 }),
    ]);
    expect(text).toContain(': 0 → {"v":"","f":"A2"} —');
  });
});
