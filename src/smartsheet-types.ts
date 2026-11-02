/**
 * Smartsheet wire shapes, as the Rockhopper API serves them. Mirrored here
 * rather than imported: this package ships on npm and takes no build
 * dependency on the API tree.
 *
 * Statuses and kinds are plain strings on purpose. A value the API adds later
 * must reach the reader's fall-through branch, not fail a union check.
 */

/** The one region the connection flow supports today. */
export const SMARTSHEET_REGION = 'us';

/** One stored connection, as `GET /auth/smartsheet/link` lists it. */
export interface SmartsheetLinkView {
  region: string;
  /**
   * `connected`, `expired`, `needs_reconnect`, `plan_lacks_api_access` or
   * `scopes_insufficient`. Never token material.
   */
  status: string;
  accountLabel: string | null;
  linkedAt: string | null;
}

export interface SmartsheetLinkStatusResponse {
  linked: boolean;
  links: SmartsheetLinkView[];
}

/** `workspace`, `folder`, `sheet`, `report` or `dashboard`. */
export interface SmartsheetBrowseItem {
  kind: string;
  /** A string: Smartsheet ids exceed what a JSON number holds exactly. */
  id: string;
  name: string;
  permalink: string | null;
  enrollable: boolean;
  unsupportedReason: string | null;
}

export interface SmartsheetBrowseListing {
  parent: { parentType: string; parentId: string | null };
  items: SmartsheetBrowseItem[];
}

export interface SmartsheetSearchListing {
  query: string;
  totalCount: number;
  items: SmartsheetBrowseItem[];
}

/** Where a browse starts: the account's home, or inside a container. */
export interface SmartsheetBrowseParent {
  parentType?: 'workspace' | 'folder';
  parentId?: string;
}

/** One recorded change to one Smartsheet cell. */
export interface SmartsheetCellHistoryEntry {
  eventType: string;
  fromValue: unknown;
  toValue: unknown;
  provenance: string;
  actorKind: string | null;
  actorPlatformId: string | null;
  attributionConfidence: string;
  /** More writes were seen than events: only first and last value are kept. */
  coalesced: boolean;
  changedAt: string | null;
}

/** `GET /cell-change-events/cell-history` for a row and column anchor. */
export interface SmartsheetCellHistory {
  rowAnchorId: string;
  columnAnchorId: string;
  /** Oldest first. */
  history: SmartsheetCellHistoryEntry[];
  /** The oldest entries beyond the page are not listed. */
  truncated: boolean;
}
