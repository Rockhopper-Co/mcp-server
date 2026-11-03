import { describe, expect, it } from 'vitest';
import { renderEmpty, renderFound } from '../../tools/list-unenrolled-render.js';
import type {
  DriveInventoryFreshness,
  DriveInventoryItem,
  DriveInventoryLaneFreshness,
  FileProvider,
} from '../../types.js';

/**
 * The stored-inventory answer at the edges of its provider lanes: a Smartsheet
 * lane whose connection broke, and a lane or row naming a provider this
 * package does not know yet (a newer backend). Each edge is checked against
 * the ordinary answer for the same lanes. Fixtures are hand-written.
 */
const AS_OF = '2026-11-02T12:00:00.000Z';

function lane(
  provider: FileProvider,
  lastFailureReason: string | null = null,
): DriveInventoryLaneFreshness {
  return {
    provider,
    asOf: AS_OF,
    stale: false,
    refreshing: false,
    lastFailureAt: lastFailureReason ? AS_OF : null,
    lastFailureReason,
    consecutiveFailures: lastFailureReason ? 1 : 0,
    inapplicableReason: null,
  };
}

function freshness(lanes: DriveInventoryLaneFreshness[]): DriveInventoryFreshness {
  return {
    asOf: AS_OF,
    stale: false,
    refreshing: false,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    inapplicableReason: null,
    providers: lanes,
  };
}

const SMARTSHEET_BROKEN =
  "Rockhopper cannot see this user's Smartsheet sheets: their Smartsheet " +
  'account is not connected, or its connection needs to be made again. Ask ' +
  'the user to run `connect_smartsheet`. This list will stay empty until ' +
  'that is done, which is NOT the same as having nothing to add.';

/** A provider a newer backend may send; outside this package's union. */
const FUTURE = 'dropbox' as unknown as FileProvider;

describe('renderEmpty with a Smartsheet lane', () => {
  it('positive control: a healthy Smartsheet lane says everything is already in', () => {
    const text = renderEmpty(freshness([lane('microsoft'), lane('smartsheet')]));
    expect(text).toContain(
      'Every file Rockhopper has seen for this user is already in Rockhopper.',
    );
    expect(text).not.toContain('connect_smartsheet');
  });

  it('a Smartsheet lane whose link failed names connect_smartsheet, not a Microsoft remedy', () => {
    const text = renderEmpty(
      freshness([lane('microsoft'), lane('smartsheet', 'DELEGATED_TOKEN_REJECTED')]),
    );
    expect(text).toBe(SMARTSHEET_BROKEN);
    expect(text).not.toContain('connect_microsoft');
  });

  it('a Smartsheet outage that is not a link failure is not read as one', () => {
    const text = renderEmpty(
      freshness([lane('microsoft'), lane('smartsheet', 'graph_unavailable')]),
    );
    expect(text).not.toBe(SMARTSHEET_BROKEN);
    expect(text).toContain('already in Rockhopper');
  });
});

describe('a provider this package does not know', () => {
  it('a failed lane for it is named by the provider, and borrows no remedy', () => {
    const text = renderEmpty(
      freshness([lane('microsoft'), lane(FUTURE, 'DELEGATED_TOKEN_REJECTED')]),
    );
    expect(text).toBe('dropbox');
    expect(text).not.toContain('connect_');
  });

  it('positive control: the same lanes with no failure render the normal answer', () => {
    const text = renderEmpty(freshness([lane('microsoft'), lane(FUTURE)]));
    expect(text).toContain('already in Rockhopper');
    // The dateline names every serving reader, the unknown one by its own name.
    expect(text).toContain('not a live Microsoft or dropbox read.');
  });

  it('a row from it prints its id under its own provider name', () => {
    const row: DriveInventoryItem = {
      msId: 'dbx-1',
      driveMsId: null,
      provider: FUTURE,
      name: 'Plan.xlsx',
      webUrl: null,
      parentPath: null,
      lastModifiedAt: null,
      size: null,
      enrollmentState: 'not_enrolled',
      entitlementObservedAt: AS_OF,
    };
    const text = renderFound([row], freshness([lane('microsoft'), lane(FUTURE)]));
    expect(text).toContain('- **Plan.xlsx**\n  provider: dropbox, fileId: dbx-1');
    expect(text).not.toContain('driveMsId');
  });

  it('positive control: a Smartsheet row prints the line enroll_file acts on', () => {
    const row: DriveInventoryItem = {
      msId: '4583173393803140',
      driveMsId: null,
      provider: 'smartsheet',
      name: 'Q4 Forecast',
      webUrl: null,
      parentPath: null,
      lastModifiedAt: null,
      size: null,
      enrollmentState: 'not_enrolled',
      entitlementObservedAt: AS_OF,
    };
    const text = renderFound([row], freshness([lane('smartsheet')]));
    expect(text).toContain(
      'provider: smartsheet, sheetId: 4583173393803140 — enroll with ' +
        'provider="smartsheet" and msId="4583173393803140"',
    );
  });
});
