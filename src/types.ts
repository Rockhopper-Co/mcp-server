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

/**
 * ENG-2198 — the delegated Microsoft Graph grant, as the backend reports it.
 * Carries no token material by design: the refresh token lives encrypted in
 * the backend and is never served to any client, this package included.
 */
export interface MicrosoftLinkStatus {
  linked: boolean;
  msAccountLabel: string | null;
  msTenantId: string | null;
  grantedScopes: string[];
  linkedAt: string | null;
  lastUsedAt: string | null;
}

/** The server-constructed consent URL for the user to open. */
export interface MicrosoftConnectHandoff {
  authorizeUrl: string;
  expiresAt: string;
}

/**
 * ENG-2541 — THREE states, never a boolean.
 *
 * `hidden` is a file this tenant enrolled and then deliberately removed from
 * its file lists; the row and everything hanging off it (versions, comments,
 * history) survives. A caller that cannot tell `hidden` from `not_enrolled`
 * offers the wrong action, and a caller that cannot tell it from `enrolled`
 * silently undoes a removal somebody meant.
 */
export type EnrollmentState = 'enrolled' | 'hidden' | 'not_enrolled';

/** ENG-2195 — `POST /enrolled-files/resolve-url`'s answer. */
export interface ResolvedFileUrl {
  /** The Graph driveItem id. */
  msId: string;
  /** The Graph drive id containing the item. */
  driveMsId: string;
  /** The file name as Microsoft holds it. */
  name: string;
  /** The SharePoint listItemUniqueId — stable across rename and move. */
  listItemUniqueId: string | null;
  /** The canonical Graph webUrl. */
  webUrl: string;
  enrollmentState: EnrollmentState;
}

/**
 * ENG-2541 — `POST /enrolled-files/info/bulk`, one entry per requested id, in
 * the order they were sent.
 *
 * The identity fields are WITHHELD (absent) for a `hidden` file and for a
 * half-written enrolment stub, deliberately: holding them is the caller's
 * licence to treat the row as a live enrolment, and neither of those is one.
 */
export interface EnrollmentInfo {
  isEnrolled: boolean;
  enrollmentState: EnrollmentState;
  isInUserWorkspace: boolean;
  enrolledFileMsId?: string;
  driveMsId?: string;
  internalId?: number;
  name?: string;
}

/**
 * ENG-2203 — one hit from `GET /drive-files/search`.
 *
 * These are files Microsoft returned for THIS user's delegated token, so the
 * set is already permission-trimmed: nothing here needs a second access check
 * and nothing outside it may be offered to the user.
 */
export interface DriveSearchItem {
  msId: string;
  /** `null` when Graph withheld the containing drive on this hit. */
  driveMsId: string | null;
  name: string;
  webUrl: string | null;
  lastModifiedAt: string | null;
  size: number | null;
  /**
   * Containing folder from the tenant drive crawl. `null` when the crawl has
   * not reached this file — normal, and never a reason to hide it.
   */
  parentPath: string | null;
  /**
   * Three states, never a boolean: `hidden` is a file Rockhopper still tracks
   * but the user deliberately removed, and collapsing it into `enrolled`
   * offers a next step that leads nowhere.
   */
  enrollmentState: EnrollmentState;
}

/** Which discovery question was asked, echoed back with the answer. */
export type DriveSearchScope = 'search' | 'recent';

/** `GET /drive-files/search`'s answer. */
export interface DriveSearchResponse {
  scope: DriveSearchScope;
  items: DriveSearchItem[];
}

/**
 * ENG-2788 — one row of `GET /drive-files/inventory`.
 *
 * A row EXISTS because Microsoft, answering this user's own delegated token,
 * disclosed that file to them. It is a stored entitlement, not a cached
 * directory listing, and that distinction is the whole reason this endpoint may
 * return names in bulk at all.
 */
export interface DriveInventoryItem {
  msId: string;
  driveMsId: string;
  name: string;
  webUrl: string | null;
  /** Containing folder, when the observation carried one. */
  parentPath: string | null;
  lastModifiedAt: string | null;
  size: number | null;
  /**
   * Three states, never a boolean. `hidden` is a file Rockhopper still holds
   * that the user deliberately removed — it is offerable again, and calling it
   * `not_enrolled` loses the fact that its history is still there.
   */
  enrollmentState: EnrollmentState;
  /** When this user's own credential last confirmed they can see the file. */
  entitlementObservedAt: string;
}

/**
 * ENG-2788 — how old the answer is, stated rather than implied.
 *
 * The endpoint serves stored rows and never blocks on Microsoft, so every
 * answer is possibly stale BY CONSTRUCTION. These fields are what stop a
 * surface presenting it as live, and `lastFailureReason` is what separates "you
 * have no un-enrolled files" from "we have never managed to look".
 */
export interface DriveInventoryFreshness {
  /** `null` when no refresh has ever succeeded for this user. */
  asOf: string | null;
  stale: boolean;
  refreshing: boolean;
  lastFailureAt: string | null;
  /** Coarse reason code. Never a Microsoft error body — those quote names. */
  lastFailureReason: string | null;
  consecutiveFailures: number;
}

/** Which slice of the inventory was asked for. */
export type DriveInventoryEnrollment = 'all' | 'enrolled' | 'not_enrolled';

/** `GET /drive-files/inventory`'s answer. */
export interface DriveInventoryResponse {
  items: DriveInventoryItem[];
  freshness: DriveInventoryFreshness;
}

/**
 * ENG-2536 — what the enrolment DID, mirrored from the backend's
 * `EnrollmentOutcome` rather than imported: this package ships to customers
 * over npm and cannot depend on the backend tree.
 *
 * The mirror is the whole risk. A value added on the server is invisible here
 * until someone edits this line, and until then it arrives as a string this
 * union says cannot exist. That is survivable ONLY because every read of it is
 * an exhaustive switch with a `never` arm — see `describeServerOutcome` — so
 * the moment this union grows a member, every reader fails to compile instead
 * of dropping the new value into an `else`. That is ENG-2580's defect, and the
 * `never` arm is the only defence available without a shared package.
 */
export type ServerEnrollmentOutcome =
  | 'enrolled'
  | 'restored'
  | 'already_enrolled';

/** One file's outcome on an enroll response. */
export interface QueuedEnrollmentFile {
  msId: string;
  platformId: string;
  outcome: ServerEnrollmentOutcome;
}

/**
 * What every enroll route answers. Enrollment is ASYNC — the file is not
 * present when this returns, only accepted, so nothing may claim otherwise.
 *
 * ENG-2536 — except for `already_enrolled`, which is the one answer that is
 * NOT a promise about the future: it means nothing was written and no worker
 * pass will change the file.
 *
 * Optional because the package and the backend ship on separate clocks. A
 * customer running `npx` picks up `latest` the moment it publishes, so calling
 * a backend that predates this field is a real case; readers fall back to what
 * the pre-write lookup said.
 */
export interface QueuedEnrollment {
  enrollmentId: string;
  status: 'queued';
  files?: QueuedEnrollmentFile[];
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
  /**
   * ENG-2200 — the caller's team memberships. `/users/me` serves these
   * because `User.teamMembers` and `TeamMember.team` are both `eager: true`
   * on the backend entities; no relation has to be requested.
   *
   * Optional because nothing else in this package reads it and a user may
   * belong to no team at all — which is a real state `enroll_file` has to
   * report rather than silently treat as an empty team.
   */
  teamMembers?: TeamMembership[];
}

/** One row of {@link UserSummary.teamMembers} — the team, not its roster. */
export interface TeamMembership {
  team?: {
    /** Version-7 uuid (ENG-1966). Absent on a backend older than the re-key. */
    id?: string;
    internalId?: number;
    name?: string;
  } | null;
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
  /**
   * ENG-2603 — the author's resolved display name.
   *
   * Optional because it is additive: a backend older than the change that
   * added it simply omits the field, and the renderer falls back to
   * `byUserPlatformId` exactly as before. Absent means "not resolved",
   * never "nobody" — the placeholder is this client's decision.
   */
  byUserName?: string | null;
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
  /**
   * ENG-2603 — the author's resolved display name.
   *
   * Optional because it is additive: a backend older than the change that
   * added it simply omits the field, and the renderer falls back to
   * `byUserPlatformId` exactly as before. Absent means "not resolved",
   * never "nobody" — the placeholder is this client's decision.
   */
  byUserName?: string | null;
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
