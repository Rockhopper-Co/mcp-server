import type { PaginatedUnattributedResponse, UnattributedChange } from './types.js';
import {
  BAND_KINDS,
  type CompareSheetPage,
  type CompareSummary,
  type LedgerChangeReader,
  type LedgerSheetItem,
  type ServedAuthor,
} from './ledger-wire.js';

/**
 * ENG-6757 — a workbook's changes since its last saved version, from the
 * LEDGER compare routes (backend ENG-6755; the legacy `/unattributed-changes`
 * routes are retired, ENG-6759). Both are keyed by the enrolled file's
 * INTERNAL id: `compare-summary` (the sheets with changes, the tab-level
 * changes, a `snapshotId`) and `compare-sheet` (one sheet's cells, 5,000 a
 * page, and its row and column bands on the first page).
 *
 * The row carries the legacy row's fields by value, minus the five
 * bookkeeping fields David ruled out (2026-10-06): the attribution trace and
 * time, the row update time, the legacy row id, the snapshot time.
 * `processingStatus` is served verbatim: `done` when an editor is named,
 * `unresolved` when none is.
 *
 * `createdAt` keeps the legacy meaning, when Rockhopper first saw the change:
 * a ledger cell serves it as `firstObservedAt` (its `createdAt` is the EDIT
 * time), the byte-lane fall-through as `createdAt`. A band or tab change is
 * served with an edit time only, so its `createdAt` is null rather than a
 * second meaning in one field.
 */

/**
 * The legacy route paged at 1,000 rows. A page here stops adding sheets once
 * it holds this many; one `compare-sheet` page can still carry up to 5,000.
 */
const PAGE_ROWS = 1000;

const row = (
  item: ServedAuthor,
  fields: Pick<UnattributedChange, 'changeType' | 'sheetName' | 'byUserPlatformId'> &
    Partial<UnattributedChange>,
): UnattributedChange => ({
  fromSheetName: null,
  cellAddress: '',
  oldValue: null,
  newValue: null,
  editType: null,
  createdAt: null,
  ...fields,
  byUserPlatformType: item.byUserPlatformType ?? null,
  byUserName: item.byUserName ?? null,
  processingStatus: item.processingStatus ?? null,
  attributionConfidence: item.attributionConfidence ?? null,
});

/** The sheet-level changes, one row each, as the legacy table held them. */
export function sheetLevelRows(
  diffs: CompareSummary['sheetDifferences'],
): UnattributedChange[] {
  const tab = (changeType: string) => (s: LedgerSheetItem) =>
    row(s, { changeType, sheetName: s.sheet, byUserPlatformId: s.byUserPlatformId });
  return [
    ...(diffs?.added ?? []).map(tab('sheet_add')),
    ...(diffs?.removed ?? []).map(tab('sheet_delete')),
    ...(diffs?.renamed ?? []).map((s) =>
      row(s, {
        changeType: 'sheet_rename',
        sheetName: s.newSheet,
        fromSheetName: s.oldSheet,
        byUserPlatformId: s.byUserPlatformId,
      }),
    ),
    // The legacy reorder row carried its tab positions as `{ t: 'n', v }`.
    ...(diffs?.reordered ?? []).map((s) =>
      row(s, {
        changeType: 'sheet_reorder',
        sheetName: s.sheet,
        oldValue: { t: 'n', v: s.fromIndex },
        newValue: { t: 'n', v: s.toIndex },
        byUserPlatformId: s.byUserPlatformId,
      }),
    ),
  ];
}

/** One `compare-sheet` page as rows: its bands first, then its cells. */
export function sheetPageRows(page: CompareSheetPage): UnattributedChange[] {
  const sheetName = page.sheetName;
  const bands = (Object.keys(BAND_KINDS) as Array<keyof typeof BAND_KINDS>).flatMap(
    (bucket) =>
      (page.rowColumnChanges?.[bucket] ?? []).map((b) =>
        row(b, {
          changeType: BAND_KINDS[bucket],
          sheetName,
          cellAddress: b.address,
          byUserPlatformId: b.userPlatformId,
        }),
      ),
  );
  const cells = page.cellChanges.map((c) =>
    row(c, {
      changeType: 'cell',
      sheetName,
      cellAddress: c.cell ?? '',
      oldValue: c.cell1,
      newValue: c.cell2,
      byUserPlatformId: c.byUserPlatformId,
      editType: c.editType ?? null,
      createdAt:
        (c.firstObservedAt === undefined ? c.createdAt : c.firstObservedAt) ?? null,
    }),
  );
  return [...bands, ...cells];
}

/**
 * Every change on one sheet: all of its `compare-sheet` pages. Empty when the
 * summary lists no sheet of that EXACT name, which is the same case-sensitive
 * equality the sheet catalogue then checks.
 */
export async function readLedgerSheet(
  api: LedgerChangeReader,
  enrolledFileInternalId: number,
  sheetName: string,
): Promise<UnattributedChange[]> {
  const summary = await api.getCompareSummary(enrolledFileInternalId);
  const sheet = summary.sheets.find((s) => s.sheetName === sheetName);
  if (!sheet) return [];
  const rows: UnattributedChange[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.getCompareSheet(
      enrolledFileInternalId,
      sheet.sheetIndex,
      summary.snapshotId,
      cursor,
    );
    rows.push(...sheetPageRows(page));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/**
 * Where a file-wide walk stands, opaque to callers: the summary's snapshot
 * (`s`), the sheet indices still to read (`q`, current first), the current
 * sheet's cursor (`c`), rows served before this page (`n`), the file total (`t`).
 */
interface WalkState {
  s: string;
  q: number[];
  c: string | null;
  n: number;
  t: number;
}

const encode = (state: WalkState): string =>
  Buffer.from(JSON.stringify(state)).toString('base64url');

function decode(cursor: string): WalkState {
  try {
    const state = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as WalkState;
    if (
      typeof state.s === 'string' &&
      Array.isArray(state.q) &&
      state.q.every(Number.isInteger) &&
      (state.c === null || typeof state.c === 'string') &&
      Number.isInteger(state.n) &&
      Number.isInteger(state.t)
    ) {
      return state;
    }
  } catch {
    // Falls through to the named refusal below.
  }
  throw new Error(
    'Invalid cursor: pass the cursor from a previous response unchanged, or ' +
      'omit it to start from the first page.',
  );
}

/**
 * One file-wide page. The first page carries the sheet-level changes, then
 * walks the sheets in summary order; `nextCursor` names where it stopped.
 *
 * `totalCount` keeps the legacy meaning: rows from this page onward. On the
 * first page that is the FILE total, counted the way the summary counts:
 * each sheet's cells and bands plus every sheet-level change.
 */
export async function readLedgerPage(
  api: LedgerChangeReader,
  enrolledFileInternalId: number,
  cursor?: string,
): Promise<PaginatedUnattributedResponse> {
  let state: WalkState;
  const rows: UnattributedChange[] = [];
  if (cursor) {
    state = decode(cursor);
  } else {
    const summary = await api.getCompareSummary(enrolledFileInternalId);
    const sheets = summary.sheets.filter(
      (s) => s.cellChangeCount + s.rowColumnChangeCount > 0,
    );
    rows.push(...sheetLevelRows(summary.sheetDifferences));
    state = {
      s: summary.snapshotId,
      q: sheets.map((s) => s.sheetIndex),
      c: null,
      n: 0,
      t: sheets.reduce(
        (sum, s) => sum + s.cellChangeCount + s.rowColumnChangeCount,
        rows.length,
      ),
    };
  }
  const totalCount = state.t - state.n;
  while (state.q.length > 0 && rows.length < PAGE_ROWS) {
    const page = await api.getCompareSheet(
      enrolledFileInternalId,
      state.q[0],
      state.s,
      state.c ?? undefined,
    );
    rows.push(...sheetPageRows(page));
    state = page.nextCursor
      ? { ...state, c: page.nextCursor }
      : { ...state, q: state.q.slice(1), c: null };
  }
  return {
    changes: rows,
    nextCursor:
      state.q.length > 0 ? encode({ ...state, n: state.n + rows.length }) : null,
    totalCount,
    snapshotId: state.s,
  };
}
