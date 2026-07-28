export interface Team {
  internalId: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  teamMembers: TeamMember[];
}

export interface TeamMember {
  id: number;
  role: string;
  user: UserSummary;
  createdAt: string;
}

export interface UserSummary {
  internalId: number;
  firstName: string | null;
  lastName: string | null;
  email: string;
  username: string | null;
}

export interface Workspace {
  internalId: number;
  workspaceDescription: string | null;
  enrolledFiles: EnrolledFile[];
}

export interface EnrolledFile {
  internalId: number;
  platformId: string;
  fileType: string;
  driveMsId: string;
  name: string;
  hasUncommittedChanges: boolean | null;
}

export interface FileVersion {
  internalId: number;
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
  description: string | null;
  createdAt: string;
  wasDiscarded: boolean;
  wasReverted: boolean;
  byUserPlatformId: string | null;
  byUserPlatformType: string | null;
}

export interface FileChat {
  internalId: number;
  message: string;
  source: string;
  cellReference: string | null;
  resolved: boolean;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
  updatedAt: string;
  editedOn: string | null;
  replies?: FileChat[];
  byUser?: UserSummary | null;
}

export interface ReviewRequest {
  internalId: number;
  id: number;
  subject: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  requester?: UserSummary;
  reviewRecords?: ReviewRecord[];
}

export interface ReviewRecord {
  id: number;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  reviewer?: UserSummary;
}

export interface UnattributedChange {
  id: number;
  changeType: string;
  sheetName: string;
  cellAddress: string;
  oldValue: unknown;
  newValue: unknown;
  byUserPlatformId: string | null;
  byUserPlatformType: string | null;
  processingStatus: string;
  attributionDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Envelope returned by the backend's paginated unattributed-changes route
 * (`GET /unattributed-changes/paginated/:fileMsId`). Cursor-based snapshot
 * pagination with a 1k-row page cap + 30-minute snapshot TTL. See KI-102 in
 * `knowledge-base/docs/known-issues.md` for the route history; the bare
 * `:fileMsId/v2` route is shadowed in the controller, so this dedicated
 * non-shadowable prefix is what mcp-server uses.
 */
export interface PaginatedUnattributedResponse {
  changes: UnattributedChange[];
  nextCursor: string | null;
  totalCount: number;
  snapshotId: string;
  snapshotCreatedAt: string;
}

/**
 * KI-096: matches the backend's `?format=mcp` projection on cell-history
 * (`GET /file-versions/file/:fileMsId/cell-history?format=mcp`, added by
 * backend PR #478). `versionId` is a semver string (`"v<major>.<minor>.<patch>"`),
 * NOT a numeric internal id — was previously typed `number` which was
 * one root cause of the audit's `Version undefined` symptom.
 */
export interface CellHistoryEntry {
  versionId: string;
  value: unknown;
  changedBy: string | null;
  changedAt: string;
  // ENG-1638 (P3-2) remainder — widened fields served when the backend's
  // read decision routes the MCP read to the Model-B ledger. All optional:
  // the legacy normalized fallback (not-eligible file, Google provider, old
  // backend) omits them entirely.
  /** Post-change formula (the ledger `f` facet). */
  formula?: string | null;
  /** Raw ledger provenance (`human_direct`, `ai_auto`, `reconcile_repair`…). */
  provenance?: string;
  /** Raw actor kind (`human`, `agent`, …). */
  actorKind?: string | null;
  /** Resolved human who drove an agent edit (P1-8). */
  drivingHuman?: string | null;
  /** Backend-rendered line: `vX.Y.Z: <value> — <provenance> (driven by <human>) — <ts>`. */
  formatted?: string;
}

export interface ReviewActivity {
  id: number;
  action: string;
  createdAt: string;
  user?: UserSummary;
}
