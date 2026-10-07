import { readFileSync } from 'node:fs';

import type { CompareSheetPage, CompareSummary } from '../../ledger-wire.js';

/**
 * ENG-6757 — the ledger compare routes' bodies AS THE BACKEND SERVES THEM.
 *
 * Source: `Rockhopper-Co/backend` origin/dev `22b826528` (the merge of
 * ENG-6755, backend #3938). Captured 2026-10-06 by a scratch e2e spec that
 * seeded exactly `test/e2e/ledger-route-legacy-fields.fixture.ts` (cells A1
 * named, A2 with no editor, A3 named by an id no user row claims; a row
 * inserted on Sheet1 and a sheet added, both with no editor) plus one named
 * cell on Sheet2, then wrote `GET /file-handler/compare-summary/by-enrolled-
 * file/:id` and each sheet's `GET /file-handler/compare-sheet/by-enrolled-
 * file/:id/:sheetIndex?snapshotId=…` verbatim. Every value is the server's,
 * the seeded test user included.
 *
 * Never edit a value by hand to make a test pass — the point of the copy is
 * that nobody here wrote it. Refresh it by re-capturing and updating the sha.
 */
export const LEDGER_COMPARE_GOLDEN = JSON.parse(
  readFileSync(new URL('./ledger-compare.json', import.meta.url), 'utf8'),
) as {
  summary: CompareSummary & Record<string, unknown>;
  pages: Array<CompareSheetPage & Record<string, unknown>>;
};
