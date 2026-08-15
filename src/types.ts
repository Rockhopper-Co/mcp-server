/**
 * An identifier naming a `user`, `team` or `workspace` row — the three tables
 * ENG-1966 re-keyed onto time-ordered (version 7) uuids.
 *
 * Both spellings name the same row on the wire, and both are accepted by the
 * backend (`resource-identifier.ts` / `ResourceIdResolver`, backend #1717).
 * David decided on 2026-08-10 that the numeric form is accepted for **400
 * days** and dropped **on or after 2027-09-14** — a window set by token
 * lifetime (the JWT `sub` claim IS the numeric user id and personal access
 * tokens run to 365 days), not by how fast anything deploys.
 *
 * Prefer the uuid in new code. The numeric form stays typed here because this
 * package ships to customers over npm and we do not control when they upgrade:
 * narrowing it would break every caller written against a published version.
 */
export type RockhopperId = number | string;

export interface Team {
  /**
   * Version-7 uuid (ENG-1966). Optional only because a backend older than the
   * re-key does not serve it; it is the identifier to migrate onto.
   */
  id?: string;
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
  /**
   * Version-7 uuid (ENG-1966) — the spelling to pass as a reviewer id.
   * Optional only because a backend older than the re-key does not serve it.
   */
  id?: string;
  internalId: number;
  firstName: string | null;
  lastName: string | null;
  email: string;
  username: string | null;
  /**
   * ENG-1756: platform identity of the user — msId (Microsoft) / googleId
   * (Google). `/users/me` serializes both; the CLI uses whichever is set as
   * the `X-Driving-Human` value on agent writes (decision 15).
   */
  msId?: string | null;
  googleId?: string | null;
  /**
   * ENG-2205 — the presenting token's own scope, served on `/users/me` and
   * ONLY when the caller authenticated with a Personal Access Token. The
   * token value itself is never returned.
   *
   * Known values are `'read-only'` and `'read-write'`, but the column is a
   * `varchar(20)` and the vocabulary is about to widen (ENG-2211), so this is
   * typed as a bare string: whatever decides what a scope may do must treat an
   * unknown value as granting nothing. Absent against a backend older than
   * ENG-2205, which is also "grants nothing".
   */
  patScope?: string;
  /**
   * ENG-2205 — the write families the token holds, e.g. `comments:write`.
   * Derived from `patScope` today; ENG-2211 makes it the source of truth.
   */
  patScopes?: string[];
  /** ENG-2205 — ISO-8601 expiry of the presenting token, or null if it never expires. */
  patExpiresAt?: string | null;
}

export interface Workspace {
  /** Version-7 uuid (ENG-1966). Optional: older backends do not serve it. */
  id?: string;
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

/**
 * `GET /file-versions/file/:fileMsId/fold-status` (KI-1399) — the backend's
 * authoritative queue read. Plan 02 ruling 5 uses it as the completeness
 * precondition for every change-history surface here.
 */
export interface FoldStatus {
  fileMsId?: string;
  /** True while a commit-diff fold is queued, retrying or running. */
  foldPending: boolean;
  /** Version the pending fold will rewrite the window for; null when none. */
  foldTargetVersionId: number | null;
  checkedAt?: string;
}
