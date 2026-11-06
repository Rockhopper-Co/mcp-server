import { RockhopperApiError, type ApiClient } from './api-client.js';
import type { DriveSearchOutcome } from './drive-search.js';
import type { EnrollOutcome } from './enrollment.js';
import type { SmartsheetBrowseItem } from './smartsheet-types.js';
import type { DriveSearchItem, EnrollmentState } from './types.js';

/** The file type the backend gives an enrolled Smartsheet sheet. */
export const SMARTSHEET_FILE_TYPE = 'smartsheet_sheet';

/** The code the backend answers when the user has no usable connection. */
export const SMARTSHEET_CONNECT_REQUIRED = 'SMARTSHEET_CONNECT_REQUIRED';

/** True when the refusal means the user must connect (or reconnect) Smartsheet. */
export function isSmartsheetConnectRequired(error: unknown): boolean {
  return (
    error instanceof RockhopperApiError &&
    error.code === SMARTSHEET_CONNECT_REQUIRED
  );
}

/**
 * The code the backend answers when the user has no usable link of their own
 * AND their organization has no usable Smartsheet connector (ENG-8726).
 */
export const SMARTSHEET_ORG_CONNECTOR_REQUIRED =
  'SMARTSHEET_ORG_CONNECTOR_REQUIRED';

/** True when the refusal means the organization's connection is missing. */
export function isSmartsheetOrgConnectorRequired(error: unknown): boolean {
  return (
    error instanceof RockhopperApiError &&
    error.code === SMARTSHEET_ORG_CONNECTOR_REQUIRED
  );
}

/** What the assistant is told when the organization's connection is missing. */
export const SMARTSHEET_ORG_CONNECTOR_TEXT =
  "This user's organization has no Smartsheet connection in Rockhopper, so " +
  'their sheets cannot be reached. An administrator of their organization ' +
  'connects Smartsheet once for everyone; ask the user to contact that ' +
  'administrator. This is NOT evidence that they have no sheets.';

/**
 * The sheets this user already has in Rockhopper, by sheet id, with names.
 *
 * Read from the enrolled-file list. That list leaves out a file the user
 * removed, so a removed sheet reads as not enrolled here and the enrollment
 * answer itself (restored or added) is the authority on what happened.
 */
export async function enrolledSheetIds(
  api: ApiClient,
): Promise<Map<string, string>> {
  const files = await api.listEnrolledFiles();
  return new Map(
    files
      .filter((f) => f.fileType === SMARTSHEET_FILE_TYPE)
      .map((f) => [f.platformId, f.name] as const),
  );
}

/**
 * Why a Smartsheet search cannot run as asked, or `null`. Checked before the
 * session's search budget is spent: a malformed ask costs nothing.
 */
export function smartsheetQueryProblem(
  query: string | undefined,
  scope: string | undefined,
): string | null {
  if (scope === 'recent') {
    return (
      'Smartsheet has no "recent" list. Call again with a `query` (at least ' +
      'two characters of the sheet name), or call `list_unenrolled_files` ' +
      'with `provider` "smartsheet" to browse the user\'s sheets.'
    );
  }
  if ((query ?? '').trim().length < 2) {
    return (
      'A Smartsheet search needs a `query` of at least two characters of ' +
      'the sheet name. Ask the user for part of the name.'
    );
  }
  return null;
}

/** A browse or search row as a search candidate. Sheets only. */
export function sheetCandidate(
  item: SmartsheetBrowseItem,
  enrolled: ReadonlyMap<string, string>,
): DriveSearchItem {
  const state: EnrollmentState = enrolled.has(item.id)
    ? 'enrolled'
    : 'not_enrolled';
  return {
    msId: item.id,
    driveMsId: null,
    provider: 'smartsheet',
    name: item.name,
    webUrl: item.permalink,
    lastModifiedAt: null,
    size: null,
    parentPath: null,
    enrollmentState: state,
  };
}

/** Sheets matching `query`, and how many reports or dashboards were left out. */
export async function searchSmartsheetSheets(
  api: ApiClient,
  query: string,
  limit: number,
): Promise<{ items: DriveSearchItem[]; skipped: number }> {
  const [listing, enrolled] = await Promise.all([
    api.searchSmartsheet(query),
    enrolledSheetIds(api),
  ]);
  const sheets = listing.items.filter((i) => i.kind === 'sheet');
  return {
    items: sheets.slice(0, limit).map((i) => sheetCandidate(i, enrolled)),
    skipped: listing.items.filter((i) => i.kind !== 'sheet').length,
  };
}

export interface SmartsheetFailure {
  outcome: DriveSearchOutcome;
  message: string;
}

/**
 * A failed Smartsheet discovery call as a named outcome. The connect-required
 * refusal is NOT handled here: answering it means minting a connect link.
 */
export function classifySmartsheetFailure(error: unknown): SmartsheetFailure {
  if (error instanceof RockhopperApiError) {
    // Before the status branches: it arrives as a 403, and the generic
    // refusal would send the user to check their own access instead.
    if (error.code === SMARTSHEET_ORG_CONNECTOR_REQUIRED) {
      return {
        outcome: 'search_refused',
        message: SMARTSHEET_ORG_CONNECTOR_TEXT,
      };
    }
    if (error.status === 404) {
      return {
        outcome: 'backend_unsupported',
        message:
          'This Rockhopper deployment cannot reach Smartsheet from an ' +
          'assistant yet. Ask the user to add the sheet from the Rockhopper ' +
          'web app instead.',
      };
    }
    if (error.status === 400) {
      return {
        outcome: 'search_unavailable',
        message:
          'A Smartsheet search needs at least two characters of the sheet ' +
          'name. Ask the user for part of the name.',
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        outcome: 'search_refused',
        message:
          'Rockhopper refused this Smartsheet request for this session, and ' +
          'trying again will not change that. Ask the user to check their ' +
          'access in Rockhopper.',
      };
    }
    return {
      outcome: 'search_unavailable',
      message:
        'Smartsheet could not answer just now. Try again in a minute. Nothing ' +
        'is known about the sheets this user has from this call, so do not ' +
        'tell them they have none.',
    };
  }
  return {
    outcome: 'search_unavailable',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * A failed Smartsheet enrollment as a named outcome, or `null` when the
 * general classifier already says the right thing. The general one names a
 * Microsoft remedy for the access refusals, which would send a Smartsheet
 * user to the wrong sign-in.
 */
export function classifySmartsheetEnrollment(
  error: unknown,
): { outcome: EnrollOutcome; message: string } | null {
  if (!(error instanceof RockhopperApiError)) return null;
  switch (error.code) {
    case 'ACCESS_UNPROVEN':
      return {
        outcome: 'access_unproven',
        message:
          'Rockhopper cannot confirm the user can open this sheet, because ' +
          'there is no usable Smartsheet connection for this session. Run ' +
          '`connect_smartsheet` to connect one, then try again. Nothing was ' +
          'changed.',
      };
    case 'FILE_ACCESS_DENIED':
      return {
        outcome: 'access_unproven',
        message:
          'Smartsheet says the user cannot open that sheet, so Rockhopper ' +
          'will not add it. Ask the sheet\'s owner to share it first. ' +
          'Retrying will not help.',
      };
    case 'SMARTSHEET_UNSUPPORTED_OBJECT':
      return {
        outcome: 'unsupported_provider',
        message:
          'Rockhopper tracks Smartsheet sheets only. That item is a report or ' +
          'a dashboard and cannot be added.',
      };
    default:
      return null;
  }
}
