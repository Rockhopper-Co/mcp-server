import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api-client.js';
import { registerListUnenrolledFilesTool } from '../../tools/list-unenrolled-files.js';
import { renderEmpty, renderFound } from '../../tools/list-unenrolled-render.js';
import type {
  DriveInventoryFreshness,
  DriveInventoryItem,
  DriveInventoryLaneFreshness,
  FileProvider,
} from '../../types.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * `list_unenrolled_files` once the stored inventory holds Smartsheet rows.
 *
 * The backend's Smartsheet lane reports `NO_SMARTSHEET_LINK` for a user who
 * never connected Smartsheet. That code must read as "this lane does not
 * serve the account", so the dateline never names a Smartsheet read that did
 * not happen. Every expectation is exact text; fixtures are hand-written.
 */

const AS_OF = '2026-11-02T12:00:00.000Z';

function lane(
  provider: FileProvider,
  inapplicableReason: string | null,
): DriveInventoryLaneFreshness {
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
  };
}

/** The top level the backend derives from `lanes` when combining them. */
function freshness(lanes: DriveInventoryLaneFreshness[]): DriveInventoryFreshness {
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
  };
}

const MICROSOFT_ROW: DriveInventoryItem = {
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

const SMARTSHEET_ROW: DriveInventoryItem = {
  msId: 'sheet-42',
  driveMsId: null,
  provider: 'smartsheet',
  name: 'Close Tracker',
  webUrl: null,
  parentPath: null,
  lastModifiedAt: '2026-11-01T09:00:00.000Z',
  size: null,
  enrollmentState: 'not_enrolled',
  entitlementObservedAt: '2026-11-02T11:00:00.000Z',
};

const MICROSOFT_LINE =
  '- **Q3 Forecast.xlsx** in /Finance/2026, modified 2026-08-18T10:00:00.000Z\n' +
  '  msId: item-1, driveMsId: drive-1';

const SMARTSHEET_LINE =
  '- **Close Tracker**, modified 2026-11-01T09:00:00.000Z\n' +
  '  provider: smartsheet, sheetId: sheet-42 — enroll with ' +
  'provider="smartsheet" and msId="sheet-42"';

const dateline = (readers: string): string =>
  `As of ${AS_OF} — from Rockhopper's stored records, not a live ${readers} read.`;

describe('list_unenrolled_files — Smartsheet never connected', () => {
  const MICROSOFT_ONLY = freshness([
    lane('microsoft', null),
    lane('google', 'NO_GOOGLE_GRANT'),
    lane('smartsheet', 'NO_SMARTSHEET_LINK'),
  ]);

  it('dates a Microsoft row as a Microsoft read only, never a Smartsheet one', () => {
    const text = renderFound([MICROSOFT_ROW], MICROSOFT_ONLY);
    expect(text).toBe(
      `1 workbook(s) not yet in Rockhopper:\n\n${MICROSOFT_LINE}\n\n` +
        dateline('Microsoft'),
    );
    expect(text).not.toContain('Smartsheet');
  });

  it('dates an empty answer as a Microsoft read only', () => {
    const text = renderEmpty(MICROSOFT_ONLY);
    expect(text).toBe(
      'Every workbook Rockhopper has seen for this user is already in ' +
        `Rockhopper.\n\n${dateline('Microsoft')}`,
    );
    expect(text).not.toContain('Smartsheet');
  });
});

describe('list_unenrolled_files — a stored Smartsheet row', () => {
  it('prints the enroll line and dates it as a Smartsheet read', () => {
    const text = renderFound(
      [SMARTSHEET_ROW],
      freshness([
        lane('microsoft', 'NO_MICROSOFT_TENANT'),
        lane('google', 'NO_GOOGLE_GRANT'),
        lane('smartsheet', null),
      ]),
    );
    expect(text).toBe(
      `1 file(s) not yet in Rockhopper:\n\n${SMARTSHEET_LINE}\n\n` +
        dateline('Smartsheet'),
    );
  });

  it('names both readers when Microsoft and Smartsheet both serve the user', () => {
    const text = renderFound(
      [MICROSOFT_ROW, SMARTSHEET_ROW],
      freshness([
        lane('microsoft', null),
        lane('google', 'NO_GOOGLE_GRANT'),
        lane('smartsheet', null),
      ]),
    );
    expect(text).toBe(
      `2 file(s) not yet in Rockhopper:\n\n${MICROSOFT_LINE}\n${SMARTSHEET_LINE}\n\n` +
        dateline('Microsoft or Smartsheet'),
    );
  });
});

describe('list_unenrolled_files — no lane serves the account, Smartsheet included', () => {
  it('names Smartsheet among what it covers and what the account lacks', () => {
    const text = renderEmpty(
      freshness([
        lane('microsoft', 'NO_MICROSOFT_TENANT'),
        lane('google', 'NO_GOOGLE_GRANT'),
        lane('smartsheet', 'NO_SMARTSHEET_LINK'),
      ]),
    );
    expect(text).toContain(
      "Rockhopper's drive inventory covers OneDrive and SharePoint and " +
        'Google Drive and Smartsheet, and this account has no Microsoft link ' +
        'and no Google connection and no Smartsheet connection — so there is ' +
        'nothing for it to list and nothing to retry.',
    );
    expect(text).not.toMatch(/has been started|try again/i);
  });
});

describe('list_unenrolled_files — description', () => {
  it('says the stored list covers Smartsheet and how a Smartsheet row is enrolled', () => {
    const server = createMockMcpServer();
    registerListUnenrolledFilesTool(
      server as unknown as McpServer,
      createMockApiClient() as unknown as ApiClient,
    );
    const call = server.registerTool.mock.calls.find(
      (c: unknown[]) => c[0] === 'list_unenrolled_files',
    );
    const config = call?.[1] as { description: string } | undefined;
    const description = config?.description ?? '';
    expect(description).toContain(
      'It covers OneDrive and SharePoint (Microsoft), Google Drive and Smartsheet',
    );
    expect(description).toContain(
      'to add a Smartsheet row, pass `provider` "smartsheet" and its sheet id as `msId`',
    );
    expect(description).not.toContain('stored OneDrive, SharePoint and Google Drive list');
  });
});
