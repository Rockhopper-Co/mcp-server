import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-6410 — `list_unenrolled_files` once the inventory holds Google rows.
 *
 * ENG-6409 made `GET /drive-files/inventory` serve a Google lane: rows carry a
 * `provider`, a Google row has `driveMsId: null`, and `freshness.providers`
 * reports each lane with its own applicability. This file pins what the tool
 * renders from that payload, row by row and by exact text, so a Google row can
 * never be printed as a Microsoft id pair `enroll_file` would refuse.
 */

const AS_OF = '2026-09-28T12:00:00.000Z';

function lane(
  provider: 'microsoft' | 'google',
  inapplicableReason: string | null,
  overrides: Record<string, unknown> = {},
) {
  const served = inapplicableReason === null;
  return {
    provider,
    asOf: served ? AS_OF : null,
    stale: !served,
    refreshing: false,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    inapplicableReason,
    ...overrides,
  };
}

/** The top level the backend's `combineFreshness` derives from `lanes`. */
function freshness(lanes: ReturnType<typeof lane>[], top: Record<string, unknown> = {}) {
  const served = lanes.filter((l) => l.inapplicableReason === null);
  return {
    asOf: served.length ? AS_OF : null,
    stale: served.length === 0,
    refreshing: false,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    inapplicableReason: served.length ? null : lanes[0].inapplicableReason,
    providers: lanes,
    ...top,
  };
}

const MICROSOFT_ROW = {
  msId: 'item-1',
  driveMsId: 'drive-1',
  provider: 'microsoft',
  name: 'Q3 Forecast.xlsx',
  webUrl: 'https://contoso.sharepoint.com/Q3.xlsx',
  parentPath: '/Finance/2026',
  lastModifiedAt: '2026-08-18T10:00:00.000Z',
  size: 1024,
  enrollmentState: 'not_enrolled',
  entitlementObservedAt: '2026-08-19T20:00:00.000Z',
};

function googleRow(msId: string, name: string, webUrl: string | null) {
  return {
    msId,
    driveMsId: null,
    provider: 'google',
    name,
    webUrl,
    parentPath: null,
    lastModifiedAt: '2026-09-27T09:00:00.000Z',
    size: null,
    enrollmentState: 'not_enrolled',
    entitlementObservedAt: '2026-09-28T11:00:00.000Z',
  };
}

/** One row of each of the four Google types the backend lane lists. */
const GOOGLE_ROWS = [
  googleRow('g-sheet', 'Budget', 'https://docs.google.com/spreadsheets/d/g-sheet/edit'),
  googleRow('g-doc', 'Memo', 'https://docs.google.com/document/d/g-doc/edit'),
  googleRow('g-slides', 'Deck', 'https://docs.google.com/presentation/d/g-slides/edit'),
  googleRow('g-xlsx', 'Upload.xlsx', 'https://drive.google.com/file/d/g-xlsx/view'),
];

async function render(response: Record<string, unknown>, args: object = {}) {
  const api = createMockApiClient();
  api.listDriveInventory.mockResolvedValue({ nextCursor: null, ...response });
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  const call = server.registerTool.mock.calls.find(
    (c: unknown[]) => c[0] === 'list_unenrolled_files',
  );
  const result = await (call?.[2] as (a: unknown) => Promise<any>)(args);
  return result.content[0].text as string;
}

function googleLine(row: ReturnType<typeof googleRow>): string {
  return (
    `- **${row.name}**, modified ${row.lastModifiedAt}\n` +
    `  provider: google, fileId: ${row.msId} — enroll with url: ${row.webUrl}`
  );
}

describe('list_unenrolled_files — Microsoft-only output is unchanged (ENG-6410)', () => {
  /** Byte-for-byte what the tool printed before the Google lane existed. */
  const BEFORE =
    '1 workbook(s) not yet in Rockhopper:\n\n' +
    '- **Q3 Forecast.xlsx** in /Finance/2026, modified 2026-08-18T10:00:00.000Z\n' +
    '  msId: item-1, driveMsId: drive-1\n\n' +
    `As of ${AS_OF} — from Rockhopper's stored records, not a live Microsoft read.`;

  it('renders a Microsoft-only account exactly as before, Google lane unconnected', async () => {
    const text = await render({
      items: [MICROSOFT_ROW],
      freshness: freshness([lane('microsoft', null), lane('google', 'NO_GOOGLE_GRANT')]),
    });
    expect(text).toBe(BEFORE);
  });

  it('renders an older backend that sends no provider exactly as before', async () => {
    const { provider: _dropped, ...legacyRow } = MICROSOFT_ROW;
    const { providers: _none, ...legacyFreshness } = freshness([lane('microsoft', null)]);
    const text = await render({ items: [legacyRow], freshness: legacyFreshness });
    expect(text).toBe(BEFORE);
  });
});

describe('list_unenrolled_files — a Google-only account (ENG-6410)', () => {
  const GOOGLE_ONLY = freshness([
    lane('microsoft', 'NO_MICROSOFT_TENANT'),
    lane('google', null),
  ]);

  it('lists all four Google types, each addressed by the link enroll_file takes', async () => {
    const text = await render({ items: GOOGLE_ROWS, freshness: GOOGLE_ONLY });
    expect(text).toBe(
      '4 file(s) not yet in Rockhopper:\n\n' +
        `${GOOGLE_ROWS.map(googleLine).join('\n')}\n\n` +
        `As of ${AS_OF} — from Rockhopper's stored records, not a live Google read.`,
    );
  });

  it('never prints a Google row as a Microsoft id pair', async () => {
    const text = await render({ items: GOOGLE_ROWS, freshness: GOOGLE_ONLY });
    expect(text).not.toContain('driveMsId');
    expect(text).not.toContain('msId:');
  });

  it('says how to add a Google row with no recorded link instead of inventing one', async () => {
    const row = googleRow('g-nolink', 'Orphan', null);
    const text = await render({ items: [row], freshness: GOOGLE_ONLY });
    expect(text).toContain(
      '  provider: google, fileId: g-nolink — no link recorded; ask the user ' +
        'for its link and pass that to `enroll_file` as `url`',
    );
  });

  it('keeps the pagination instruction on a Google page', async () => {
    const text = await render({
      items: GOOGLE_ROWS.slice(0, 1),
      freshness: GOOGLE_ONLY,
      nextCursor: 'g-next',
    });
    expect(text.startsWith('1 file(s) not yet in Rockhopper on this page:')).toBe(true);
    expect(text).toContain('cursor="g-next"');
  });

  it('sends a disconnected Google lane to Google, never to connect_microsoft', async () => {
    const failed = freshness(
      [
        lane('microsoft', 'NO_MICROSOFT_TENANT'),
        lane('google', null, {
          asOf: null,
          lastFailureAt: AS_OF,
          lastFailureReason: 'no_delegated_token',
          consecutiveFailures: 1,
        }),
      ],
      { asOf: null, lastFailureAt: AS_OF, lastFailureReason: 'no_delegated_token', consecutiveFailures: 1 },
    );
    const text = await render({ items: [], freshness: failed });
    expect(text).not.toContain('connect_microsoft');
    expect(text).toContain('Google');
    expect(text).not.toMatch(/has been started/i);
  });

  it('says everything is covered in file terms when a Google refresh succeeded', async () => {
    const text = await render({ items: [], freshness: GOOGLE_ONLY });
    expect(text).toBe(
      'Every file Rockhopper has seen for this user is already in Rockhopper.\n\n' +
        `As of ${AS_OF} — from Rockhopper's stored records, not a live Google read.`,
    );
  });
});

describe('list_unenrolled_files — a dual-grant account (ENG-6410)', () => {
  it('lists both providers, each row in its own provider’s terms', async () => {
    const text = await render({
      items: [MICROSOFT_ROW, GOOGLE_ROWS[1]],
      freshness: freshness([lane('microsoft', null), lane('google', null)]),
    });
    expect(text).toBe(
      '2 file(s) not yet in Rockhopper:\n\n' +
        '- **Q3 Forecast.xlsx** in /Finance/2026, modified 2026-08-18T10:00:00.000Z\n' +
        '  msId: item-1, driveMsId: drive-1\n' +
        `${googleLine(GOOGLE_ROWS[1])}\n\n` +
        `As of ${AS_OF} — from Rockhopper's stored records, not a live Microsoft or Google read.`,
    );
  });
});

describe('list_unenrolled_files — no lane serves the account (ENG-6410)', () => {
  const NONE = freshness([
    lane('microsoft', 'NO_MICROSOFT_TENANT'),
    lane('google', 'NO_GOOGLE_GRANT'),
  ]);

  it('names every lane it covers and what this account lacks, with nothing to retry', async () => {
    const text = await render({ items: [], freshness: NONE });
    expect(text).toContain(
      'Rockhopper\'s drive inventory covers OneDrive and SharePoint and ' +
        'Google Drive, and this account has no Microsoft link and no Google ' +
        'connection',
    );
    expect(text).not.toContain('connect_microsoft');
    expect(text).not.toMatch(/has been started|try again/i);
  });
});

describe('list_unenrolled_files — description (ENG-6410)', () => {
  it('covers Google and tells the model how a Google row is enrolled', async () => {
    const server = createMockMcpServer();
    registerTools(server as any, createMockApiClient() as any);
    const call = server.registerTool.mock.calls.find(
      (c: unknown[]) => c[0] === 'list_unenrolled_files',
    );
    const description = call?.[1].description as string;
    expect(description).not.toContain('MICROSOFT ONLY');
    expect(description).toContain('Google Drive');
    expect(description).toContain('`url`');
    expect(description).not.toContain('For a Google file, call `search_drive_files`');
  });
});
