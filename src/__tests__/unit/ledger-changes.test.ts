import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { readFileChanges } from '../../file-changes.js';
import {
  readLedgerPage,
  sheetLevelRows,
  sheetPageRows,
} from '../../ledger-changes.js';
import { registerResources } from '../../resources/index.js';
import { LEDGER_COMPARE_GOLDEN as GOLDEN } from '../goldens/ledger-compare.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-6757 — the workbook change read uses the ledger compare routes and no
 * `/unattributed-changes` route, and an editor-less change reads `unresolved`
 * (David, 2026-10-06). The served bodies are the backend's own
 * (`goldens/ledger-compare.ts`), behind a real `ApiClient` and a stub `fetch`
 * that 404s every path it does not serve — so a legacy request fails loudly.
 */
const EFI = 2;
const SERVED: Record<string, unknown> = {
  '/enrolled-files/file-1': {
    internalId: EFI,
    platformId: 'file-1',
    fileType: 'microsoft_xlsx',
    driveMsId: 'drive-1',
    name: 'ledger-capture.xlsx',
    hasUncommittedChanges: true,
  },
  '/file-versions/file/file-1/fold-status': {
    foldPending: false,
    foldTargetVersionId: null,
  },
  [`/file-handler/compare-summary/by-enrolled-file/${EFI}`]: GOLDEN.summary,
  [`/file-handler/compare-sheet/by-enrolled-file/${EFI}/0`]: GOLDEN.pages[0],
  [`/file-handler/compare-sheet/by-enrolled-file/${EFI}/1`]: GOLDEN.pages[1],
};

function serveGolden(): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      requested.push(url);
      const body = SERVED[pathname];
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        statusText: body === undefined ? 'Not Found' : 'OK',
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body ?? {}),
      };
    }),
  );
  return requested;
}

const api = () => new ApiClient({ baseUrl: 'https://api.test', token: 'rh_pat_x' });
const snapshot = GOLDEN.summary.snapshotId;

afterEach(() => vi.unstubAllGlobals());

describe('ENG-6757 — no request reaches a legacy route', () => {
  it('reads the summary and every sheet page, file-wide and by sheet', async () => {
    const requested = serveGolden();
    await readFileChanges(api(), 'file-1', {});
    await readFileChanges(api(), 'file-1', { sheetName: 'Sheet2' });

    expect(requested.filter((u) => u.includes('/unattributed-changes'))).toEqual([]);
    expect(requested.filter((u) => u.includes('/file-handler/'))).toEqual([
      `https://api.test/file-handler/compare-summary/by-enrolled-file/${EFI}`,
      `https://api.test/file-handler/compare-sheet/by-enrolled-file/${EFI}/0?snapshotId=${snapshot}`,
      `https://api.test/file-handler/compare-sheet/by-enrolled-file/${EFI}/1?snapshotId=${snapshot}`,
      `https://api.test/file-handler/compare-summary/by-enrolled-file/${EFI}`,
      `https://api.test/file-handler/compare-sheet/by-enrolled-file/${EFI}/1?snapshotId=${snapshot}`,
    ]);
  });
});

describe('ENG-6757 — the changes resource serves the ledger rows', () => {
  const at = (cell: string) =>
    GOLDEN.pages.flatMap((p) => p.cellChanges).find((c) => c.cell === cell)
      ?.firstObservedAt;
  const author = {
    byUserPlatformId: 'test-ms-id-user1',
    byUserPlatformType: 'microsoft',
    byUserName: 'Test User1',
    processingStatus: 'done',
    attributionConfidence: 'in_session_actor',
  };
  const nobody = {
    byUserPlatformId: null,
    byUserPlatformType: null,
    byUserName: null,
    processingStatus: 'unresolved',
    attributionConfidence: 'unknown',
  };
  const cell = (sheetName: string, cellAddress: string, from: unknown, to: unknown) => ({
    changeType: 'cell',
    sheetName,
    fromSheetName: null,
    cellAddress,
    oldValue: { v: from },
    newValue: { v: to },
    editType: 'value',
    createdAt: at(cellAddress),
  });
  const structural = (changeType: string, sheetName: string, cellAddress: string) => ({
    changeType,
    sheetName,
    fromSheetName: null,
    cellAddress,
    oldValue: null,
    newValue: null,
    editType: null,
    createdAt: null,
  });

  it('carries every row by value, `unresolved` where no editor is named', async () => {
    serveGolden();
    const server = createMockMcpServer();
    registerResources(server as never, api() as never);
    const handler = server.registerResource.mock.calls.find(
      (c) => c[0] === 'unattributed-changes',
    )?.[3];
    const result = await handler(new URL('rockhopper://files/file-1/changes'), {
      fileMsId: 'file-1',
    });
    const served = JSON.parse(result.contents[0].text);

    expect(served).toEqual({
      changes: [
        { ...structural('sheet_add', 'Added', ''), ...nobody },
        { ...structural('row_insert', 'Sheet1', '5:5'), ...nobody },
        { ...cell('Sheet1', 'A1', 1, 2), ...author },
        { ...cell('Sheet1', 'A2', 3, 4), ...nobody },
        {
          ...cell('Sheet1', 'A3', 5, 6),
          ...author,
          byUserPlatformId: 'eng6755-not-a-user',
          byUserPlatformType: null,
          byUserName: null,
        },
        { ...cell('Sheet2', 'B1', 'old', 'new'), ...author },
      ],
      nextCursor: null,
      // 3 cells + 1 band on Sheet1, 1 cell on Sheet2, 1 sheet added.
      totalCount: 6,
      snapshotId: snapshot,
    });
  });
});

describe('ENG-6757 — the row mapping', () => {
  const [added] = GOLDEN.summary.sheetDifferences?.added ?? [];

  it('maps a rename to the new name with the old one beside it, and a move to its positions', () => {
    const rows = sheetLevelRows({
      renamed: [{ ...added, oldSheet: 'Budget', newSheet: 'Budget 2026' }],
      reordered: [{ ...added, sheet: 'Budget', fromIndex: 0, toIndex: 2 }],
    });
    expect(rows.map((r) => [r.changeType, r.sheetName, r.fromSheetName, r.oldValue, r.newValue])).toEqual([
      ['sheet_rename', 'Budget 2026', 'Budget', null, null],
      ['sheet_reorder', 'Budget', null, { t: 'n', v: 0 }, { t: 'n', v: 2 }],
    ]);
  });

  it('keeps the byte lane fall-through: its createdAt clock and a pending status', () => {
    const [byteCell] = sheetPageRows({
      sheetName: 'Sheet1',
      cellChanges: [
        {
          cell: 'C3',
          cell1: { v: 1 },
          cell2: { v: 2 },
          byUserPlatformId: null,
          processingStatus: 'pending',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      rowColumnChanges: {},
      nextCursor: null,
    });
    expect(byteCell).toMatchObject({
      createdAt: '2026-10-01T00:00:00.000Z',
      processingStatus: 'pending',
      byUserName: null,
    });
  });

  it('refuses a cursor it did not mint, by name', async () => {
    await expect(
      readLedgerPage(createMockApiClient(), EFI, 'not-a-cursor'),
    ).rejects.toThrow('Invalid cursor');
  });
});
