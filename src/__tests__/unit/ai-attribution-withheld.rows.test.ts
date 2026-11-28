/**
 * AI attribution withheld by the organization's plan: how one withheld row is
 * printed, and what the changes resource serialises.
 *
 * A withheld cell-history row keeps the backend's `formatted` line, so its
 * time wording (an edit window, or "first seen") matches the unlocked rows
 * around it; only the locked provenance slot is replaced, or the mark is
 * appended when the lock arrived through the actor kind or claim alone.
 *
 * The changes resource serialises the backend's own wire fields on both the
 * workbook and the document body, so one key never has two shapes.
 */
import { describe, expect, it } from 'vitest';

import { registerResources } from '../../resources/index.js';
import { cellHistoryLine } from '../../tools/cell-history-read.js';
import { CellHistoryEntrySchema } from '../../zod-schemas.js';
import { serveLedger, servedCell } from './ledger-mock.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const DATE = '2026-11-01T00:00:00.000Z';
const MARK = "AI attribution not shown on this organization's plan";
const NOTE_FROM =
  "AI attribution is not shown on this organization's plan for changes " +
  `made on or after ${DATE}, so those changes do not say whether AI was ` +
  'involved. A change listed without AI credit may still have involved AI: ' +
  'do not report that no AI was involved.';

/** The row as the client sees it: through the schema, as the API client parses it. */
const line = (row: Record<string, unknown>) =>
  cellHistoryLine(
    CellHistoryEntrySchema.parse({
      versionId: 'v2.0.0',
      value: 6,
      changedBy: 'Ada',
      changedAt: '2026-11-02T00:00:00.000Z',
      aiLinks: [],
      ...row,
    }),
  );

describe('withheld AI attribution — one cell-history row', () => {
  it('positive control: an unlocked row whose value contains the locked word prints verbatim', () => {
    const formatted = 'v2.0.0: "x — plan_locked" — human_direct (by Ada) — 2026-11-02T00:00:00.000Z';
    expect(line({ value: 'x — plan_locked', provenance: 'human_direct', actorKind: 'user', formatted })).toBe(
      `- ${formatted}`,
    );
  });

  it('a locked provenance keeps the "first seen" wording and never prints changedAt as the edit time', () => {
    const out = line({
      changedAt: '2026-11-01T22:00:00.000Z',
      provenance: 'plan_locked',
      actorKind: 'plan_locked',
      drivingHuman: null,
      formatted: 'v2.0.0: 6 — plan_locked (by Ada) — first seen 2026-11-02T00:05:00.000Z',
    });
    expect(out).toBe(`- v2.0.0: 6 — ${MARK} (by Ada) — first seen 2026-11-02T00:05:00.000Z`);
    expect(out).not.toContain('2026-11-01T22:00:00.000Z');
  });

  it('a locked provenance keeps an edit window, and only the provenance slot is replaced', () => {
    const window = 'between 2026-11-01T23:00:00.000Z and 2026-11-02T00:00:00.000Z';
    expect(
      line({
        value: 'a — plan_locked',
        provenance: 'plan_locked',
        formatted: `v2.0.0: "a — plan_locked" — plan_locked — ${window}`,
      }),
    ).toBe(`- v2.0.0: "a — plan_locked" — ${MARK} — ${window}`);
  });

  it('a lock carried only by the actor kind or the actor claim appends the mark to the backend line', () => {
    const formatted = 'v2.0.0: 6 — human_direct (by Ada) — after 2026-11-01T23:00:00.000Z';
    expect(line({ provenance: 'human_direct', actorKind: 'plan_locked', formatted })).toBe(
      `- ${formatted} — ${MARK}`,
    );
    expect(
      line({ provenance: 'human_direct', actorKind: 'user', actorClaim: 'plan_locked', formatted }),
    ).toBe(`- ${formatted} — ${MARK}`);
  });

  it('an older backend with no formatted line keeps the original rendering', () => {
    expect(line({ provenance: 'plan_locked' })).toBe(
      `- Version v2.0.0: **6** — by Ada — ${MARK} — 2026-11-02T00:00:00.000Z`,
    );
  });
});

describe('withheld AI attribution — the changes resource', () => {
  const read = async (setup: (api: ReturnType<typeof createMockApiClient>) => void) => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    setup(api);
    registerResources(server as never, api as never);
    const call = server.registerResource.mock.calls.find((c) => c[0] === 'unattributed-changes');
    const result = await call?.[3](new URL('rockhopper://files/file-1/changes'), { fileMsId: 'file-1' });
    return JSON.parse(result.contents[0].text) as Record<string, unknown>;
  };
  const workbook = (fields: Record<string, unknown>) => (api: ReturnType<typeof createMockApiClient>) => {
    serveLedger(api, [{ name: 'Sheet1', cells: [servedCell({ cell: 'A1' })] }]);
    const summary = api.getCompareSummary.getMockImplementation();
    api.getCompareSummary.mockImplementation(async (...args: unknown[]) => ({
      ...(await summary?.(...args)),
      ...fields,
    }));
  };
  const document = (fields: Record<string, unknown>) => (api: ReturnType<typeof createMockApiClient>) => {
    api.getEnrolledFile.mockResolvedValue({ internalId: 11, platformId: 'file-1', fileType: 'microsoft_docx', name: 'Memo.docx' });
    api.getDocumentChanges.mockResolvedValue({
      rows: [],
      truncated: false,
      declineReason: null,
      windowStart: '2026-11-01T09:00:00.000Z',
      ...fields,
    });
  };
  const LOCK = { aiAttribution: 'plan_locked', lockedFrom: DATE };

  it('positive control: an entitled workbook carries none of the withheld fields', async () => {
    const body = await read(workbook({ aiAttribution: 'shown', lockedFrom: null }));
    expect(body.totalCount).toBe(1);
    expect(body).not.toHaveProperty('aiAttribution');
    expect(body).not.toHaveProperty('lockedFrom');
    expect(body).not.toHaveProperty('aiAttributionNote');
  });

  it('a locked workbook and a locked document serialise the same fields, note included', async () => {
    const expected = { ...LOCK, aiAttributionNote: NOTE_FROM };
    const sheetBody = await read(workbook(LOCK));
    expect(sheetBody.totalCount).toBe(1);
    expect(sheetBody).toMatchObject(expected);
    const docBody = await read(document(LOCK));
    expect(docBody.windowStart).toBe('2026-11-01T09:00:00.000Z');
    expect(docBody).toMatchObject(expected);
  });
});
