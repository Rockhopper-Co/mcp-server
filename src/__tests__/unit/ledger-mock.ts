import type {
  CompareSheetPage,
  CompareSummary,
  LedgerBand,
  LedgerCell,
} from '../../ledger-wire.js';
import { LEDGER_COMPARE_GOLDEN } from '../goldens/ledger-compare.js';
import type { MockApiClient } from './test-helpers.js';

/**
 * ENG-6757 — the ledger compare routes, served to a mock `ApiClient`.
 *
 * Every row starts from a REAL served row (`goldens/ledger-compare.json`) and
 * a spec overrides only the fields it is about, so a key the backend serves
 * and nobody wrote here still reaches the code under test. Paging follows
 * `file-handler.service.ts!compareSheetByEnrolledFileId`: 5,000 cells a page,
 * the sheet's bands on its first page only.
 */
const [GOLDEN_SHEET] = LEDGER_COMPARE_GOLDEN.pages;
const GOLDEN_NAMED_CELL = GOLDEN_SHEET.cellChanges.find(
  (c) => c.processingStatus === 'done' && c.byUserName !== null,
) as LedgerCell;

/** A served cell: the golden's named cell, with `over` applied. */
export const servedCell = (over: Partial<LedgerCell>): LedgerCell => ({
  ...GOLDEN_NAMED_CELL,
  ...over,
});

const PAGE = 5000;
type Buckets = CompareSheetPage['rowColumnChanges'];
const emptyBuckets = (): Required<Buckets> => ({
  rowInsertions: [],
  rowDeletions: [],
  columnInsertions: [],
  columnDeletions: [],
});

export interface LedgerSheetFixture {
  name: string;
  cells?: LedgerCell[];
  bands?: Partial<Record<keyof Buckets, LedgerBand[]>>;
}

/** Serve `sheets` (and the sheet-level changes) from the two compare mocks. */
export function serveLedger(
  api: MockApiClient,
  sheets: LedgerSheetFixture[],
  sheetDifferences: CompareSummary['sheetDifferences'] = null,
): void {
  const bandCount = (s: LedgerSheetFixture) =>
    Object.values(s.bands ?? {}).reduce((n, b) => n + (b?.length ?? 0), 0);
  api.getCompareSummary.mockResolvedValue({
    ...LEDGER_COMPARE_GOLDEN.summary,
    sheets: sheets.map((s, sheetIndex) => ({
      sheetIndex,
      sheetName: s.name,
      cellChangeCount: s.cells?.length ?? 0,
      rowColumnChangeCount: bandCount(s),
      rangeFormatChangeCount: 0,
      cursorRequired: (s.cells?.length ?? 0) > PAGE,
    })),
    sheetDifferences,
    snapshotId: 'snap-1',
  });
  api.getCompareSheet.mockImplementation(
    async (_file: number, sheetIndex: number, snapshotId: string, cursor?: string) => {
      const sheet = sheets[sheetIndex];
      const cells = sheet.cells ?? [];
      const from = cursor ? Number(cursor) : 0;
      return {
        ...GOLDEN_SHEET,
        sheetIndex,
        sheetName: sheet.name,
        cellChanges: cells.slice(from, from + PAGE),
        rowColumnChanges:
          from === 0 ? { ...emptyBuckets(), ...sheet.bands } : emptyBuckets(),
        nextCursor: from + PAGE < cells.length ? String(from + PAGE) : null,
        totalCellChangeCount: cells.length,
        snapshotId,
      };
    },
  );
}
