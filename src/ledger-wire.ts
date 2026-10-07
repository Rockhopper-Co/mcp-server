/**
 * ENG-6757 — the ledger compare routes' bodies, the fields this server reads.
 * Mirrored, not imported: this package ships on npm and cannot depend on the
 * backend tree. Each type names the backend shape it copies.
 */

/** The fields every served change carries for its author and state. */
export interface ServedAuthor {
  byUserName?: string | null;
  byUserPlatformType?: string | null;
  processingStatus?: string | null;
  attributionConfidence?: string | null;
}

/** One `compare-sheet` cell (`live-diff-legacy-adapter.ts!LiveDiffCellRecord`). */
export interface LedgerCell extends ServedAuthor {
  cell: string | null;
  cell1: unknown;
  cell2: unknown;
  byUserPlatformId: string | null;
  editType?: string | null;
  createdAt?: string | null;
  firstObservedAt?: string | null;
}

/** One row or column band (`live-diff-structural-shared.ts!LegacyRowColumnBand`). */
export interface LedgerBand extends ServedAuthor {
  address: string;
  userPlatformId: string | null;
}

/** A tab added or removed (`LegacySheetChangeEntry`). */
export interface LedgerSheetItem extends ServedAuthor {
  sheet: string;
  byUserPlatformId: string | null;
}

/** A tab renamed (`LegacySheetRenameEntry`). */
export interface LedgerSheetRename extends ServedAuthor {
  oldSheet: string;
  newSheet: string;
  byUserPlatformId: string | null;
}

/** A tab moved (`LegacySheetReorderEntry`), its 0-based positions. */
export interface LedgerSheetReorder extends LedgerSheetItem {
  fromIndex: number;
  toIndex: number;
}

/** `GET /file-handler/compare-summary/by-enrolled-file/:id`, the fields read here. */
export interface CompareSummary {
  sheets: Array<{
    sheetIndex: number;
    sheetName: string;
    cellChangeCount: number;
    rowColumnChangeCount: number;
  }>;
  sheetDifferences: {
    added?: LedgerSheetItem[];
    removed?: LedgerSheetItem[];
    renamed?: LedgerSheetRename[];
    reordered?: LedgerSheetReorder[];
  } | null;
  snapshotId: string;
}

/** A `rowColumnChanges` bucket → the legacy row's `changeType`. */
export const BAND_KINDS = {
  rowInsertions: 'row_insert',
  rowDeletions: 'row_delete',
  columnInsertions: 'column_insert',
  columnDeletions: 'column_delete',
} as const;

/** `GET /file-handler/compare-sheet/by-enrolled-file/:id/:sheetIndex`. */
export interface CompareSheetPage {
  sheetName: string;
  cellChanges: LedgerCell[];
  rowColumnChanges: Partial<Record<keyof typeof BAND_KINDS, LedgerBand[]>>;
  nextCursor: string | null;
}

/** The two ledger reads, as `ApiClient` serves them. */
export interface LedgerChangeReader {
  getCompareSummary(enrolledFileInternalId: number): Promise<CompareSummary>;
  getCompareSheet(
    enrolledFileInternalId: number,
    sheetIndex: number,
    snapshotId: string,
    cursor?: string,
  ): Promise<CompareSheetPage>;
}
