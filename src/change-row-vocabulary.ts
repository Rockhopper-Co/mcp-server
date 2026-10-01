/**
 * ENG-6608 — the words a change row says, and the two words a missing side
 * says. One vocabulary for every surface: the text this server sends an AI
 * client uses the change log's words, never the ledger's event types (David,
 * 2026-09-30). Rules: knowledge-base `docs/features/change-log-row-vocabulary.md`
 * §2 (the edit-type word) and §4 (from→to sides).
 *
 * MIRRORED, NOT IMPORTED: this package ships on npm and cannot depend on the
 * frontend. Each table names the frontend source it copies, and
 * `__tests__/unit/change-row-vocabulary.test.ts` pins every pair by identity.
 *
 * Less is more: a row says WHERE, WHAT KIND and WHAT CHANGED. A kind this build
 * cannot read prints NO word — the change log draws no chip for it — rather
 * than the raw event type.
 */

/**
 * A side that exists and renders to nothing: an emptied paragraph, a blank
 * cell. A CLAIM that the side was empty. Frontend `valueSide.ts!EMPTY_SIDE`.
 */
export const EMPTY_SIDE = '—';

/**
 * A side the ledger stored no value for. Not the same fact as an empty side.
 * Frontend `valueSide.ts!UNCAPTURED_SIDE`.
 */
export const UNCAPTURED_SIDE = 'Not recorded';

/**
 * A document `changeKind` → its row word. `CHANGE_KIND_MEANING` gives each kind
 * its type and edit type (`services/document-change-kinds.ts`); an ADDED or
 * REMOVED kind reads `added` / `removed` (`changeLabel.ts!cellChangeLabel`),
 * every other kind reads `editTypeLabels[editType]` from the `text` or
 * `presentation` column of `changeLogVocabulary.ts`.
 */
export const DOCUMENT_CHANGE_KIND_WORDS: Readonly<Record<string, string>> = {
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
};

/**
 * The cause mark a document kind carries. Only a regenerated Word field has
 * one (`CHANGE_KIND_MEANING` cause `system_recalc`), and the change log names
 * it with `systemCauseLabels.system_recalc` of the `text` column.
 */
export const DOCUMENT_CHANGE_KIND_CAUSES: Readonly<Record<string, string>> = {
  block_field_regenerated: 'Updated by Word',
};

/**
 * A `slide_design` row names its part when the anchor carries one, as the
 * change log does (`change-log-value-kind.ts` `designPart`, lowercased by
 * `changeLabel.ts!cellChangeLabel`). Any other anchor keeps `design`.
 */
export const DESIGN_PART_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['design:layout:', 'layout'],
  ['design:master:', 'master'],
  ['design:theme:', 'theme'],
];

/** A cell's `editType` → its row word: the `spreadsheet` column of `changeLogVocabulary.ts`. */
export const SPREADSHEET_EDIT_TYPE_WORDS: Readonly<Record<string, string>> = {
  value: 'value',
  format: 'format',
  formula: 'formula',
  formula_recalc: 'formula, same result',
  value_and_format: 'value and format',
};

/**
 * A structural `changeType` → its row word, one row per change:
 * `changeLabel.ts!sheetChangeLabel` and `rowColumnChangeLabel` at a count of 1.
 */
export const SPREADSHEET_STRUCTURAL_WORDS: Readonly<Record<string, string>> = {
  sheet_add: 'sheet added',
  sheet_delete: 'sheet removed',
  sheet_rename: 'sheet renamed',
  row_insert: 'row inserted',
  row_delete: 'row deleted',
  column_insert: 'column inserted',
  column_delete: 'column deleted',
};

const own = (table: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** Frontend `valueSide.ts!rendersToNothing`. */
const rendersToNothing = (value: unknown): boolean =>
  value === null || value === undefined || !/\S/.test(String(value));

/** A document kind's row word, or undefined for a kind this build cannot read. */
export const documentChangeWord = (changeKind: string): string | undefined =>
  own(DOCUMENT_CHANGE_KIND_WORDS, changeKind);

/**
 * The row label of a document change: its word, then its cause mark, or null
 * when this build cannot read the kind.
 */
export function documentChangeLabel(
  changeKind: string,
  anchorProviderId: string | null,
): string | null {
  let word = documentChangeWord(changeKind);
  if (word === undefined) return null;
  if (changeKind === 'slide_design') {
    const part = DESIGN_PART_WORDS.find(([prefix]) =>
      (anchorProviderId ?? '').startsWith(prefix),
    );
    word = part ? part[1] : word;
  }
  const cause = own(DOCUMENT_CHANGE_KIND_CAUSES, changeKind);
  return cause ? `${word}, ${cause}` : word;
}

/**
 * One side of a document row. A paragraph or shape side is its `.v` text,
 * exactly as frontend `document-change-sides.ts!facetToValue` reads it.
 */
export function documentSide(facet: { v?: unknown } | null): string {
  const value = facet?.v;
  if (value === null || value === undefined) return UNCAPTURED_SIDE;
  return rendersToNothing(value) ? EMPTY_SIDE : JSON.stringify(value);
}

/**
 * One side of a cell row. Absent → `Not recorded`; a value with nothing to
 * show in any of its display, value or formula fields → `—`; otherwise the
 * stored value as written today.
 */
export function cellSide(value: unknown): string {
  if (value === null || value === undefined) return UNCAPTURED_SIDE;
  const shown =
    typeof value === 'object'
      ? (['w', 'formattedValue', 'v', 'f'] as const).map(
          (key) => (value as Record<string, unknown>)[key],
        )
      : [value];
  return shown.every(rendersToNothing) ? EMPTY_SIDE : JSON.stringify(value);
}

/** The fields a spreadsheet change row renders (`UnattributedChange`). */
export interface SpreadsheetChangeRowInput {
  sheetName: string;
  cellAddress: string;
  changeType: string;
  /** The server's facet classification; absent on an older backend. */
  editType?: string | null;
  oldValue: unknown;
  newValue: unknown;
  byUserPlatformId: string | null;
  /** ENG-2603 — resolved display name; absent on an older backend. */
  byUserName?: string | null;
  createdAt: string;
}

/**
 * Spreadsheet change rows, rendered. A structural row names what happened to
 * the sheet, row or column and has no value sides, as in the change log.
 */
export function formatSpreadsheetChangeRows(
  changes: ReadonlyArray<SpreadsheetChangeRowInput>,
): string {
  return changes
    .map((c) => {
      const structural = own(SPREADSHEET_STRUCTURAL_WORDS, c.changeType);
      const word =
        structural ??
        (c.changeType === 'cell' && c.editType
          ? own(SPREADSHEET_EDIT_TYPE_WORDS, c.editType)
          : undefined);
      const label = word ? ` (${word})` : '';
      const sides = structural
        ? ''
        : `: ${cellSide(c.oldValue)} → ${cellSide(c.newValue)}`;
      // ENG-2603 — see get-versions: name first, platform id as fallback.
      const author = c.byUserName ?? c.byUserPlatformId;
      const by = author ? ` — by ${author}` : '';
      return `- **${c.sheetName}!${c.cellAddress}**${label}${sides}${by} — ${c.createdAt}`;
    })
    .join('\n');
}
