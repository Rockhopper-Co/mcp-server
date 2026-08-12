# Rockhopper MCP — orchestration guide

This guide explains how to combine Rockhopper's MCP tools and resources correctly. Read it before sequencing multiple tool calls — it documents the prerequisites, identity types, and lifecycle rules that the individual tool descriptions cannot show in isolation.

## 1. Identity and IDs

Rockhopper uses four distinct identifiers. Mixing them is the most common cause of tool-call errors.

| ID | Type | Where it comes from | Where it goes |
|----|------|---------------------|---------------|
| `fileMsId` | string | `list_files` response, `rockhopper://files` resource | Tools that act on a file: `get_file_versions`, `get_file_comments`, `add_comment`, `create_version`, `discard_changes`, `get_cell_history`, `get_unattributed_changes`, `rename_file` |
| `versionId` | number | `get_file_versions` response (`internalId` field), `create_version` response | Tools that act on a specific version snapshot: `get_reviews`, `create_review_request`, `approve_review`, `cancel_review` |
| `versionInternalId` | number | `get_file_comments` response (comments scope to a version) | Comment-thread tools: `add_comment`, `reply_to_comment`, `resolve_comment` |
| user / team id | uuid string **or** number | `rockhopper://teams/{teamId}` resource — each record carries an `id` (uuid) and an `internalId` (number) | `reviewerIds` on `create_review_request`; the `{teamId}` in `rockhopper://teams/{teamId}` |

Decision tree:

- **Reading file metadata** → `fileMsId`.
- **Writing a comment** → `fileMsId` (the server auto-resolves the latest version) OR `versionInternalId` if commenting on a historical version.
- **Acting on a review** → `versionId`.
- **Naming a person or a team** → their `id` (uuid).

### Users and teams take two spellings; send the uuid

A user or team can be named by its `id` (a uuid, e.g. `0198f3a1-2b4c-7d8e-9f01-23456789abcd`) or by its legacy `internalId` (a number). Both are accepted and both name the same record, and the two can be mixed inside one `reviewerIds` array.

**Send the uuid.** The numeric form is accepted until **2027-09-14** and is removed after that date. Nothing else in this guide takes a uuid — `versionId`, `versionInternalId` and comment ids stay numeric.

If a tool returns an error like "expected versionId but received fileMsId", you used the wrong identifier — check the tool description for which type it accepts.

## 2. Reading workflow

Standard sequence to inspect a file:

1. `list_files` — discover enrolled files. Returns `fileMsId`, `name`, `fileType`, `hasUncommittedChanges`.
2. `get_file_versions(fileMsId)` — version history. Each entry has `internalId` (this is the `versionId`).
3. Branch:
   - File contents at a specific version → `get_cell_history(fileMsId, sheet, cellAddress)`.
   - Comments → `get_file_comments(fileMsId)`. Filters to the latest live version by default.
   - Reviews → `get_reviews(versionId)`. Pass a `versionId` from step 2.
   - Uncommitted changes → `get_unattributed_changes(fileMsId)` (only useful if `hasUncommittedChanges === true`).

### `CHANGE_HISTORY_NOT_READY` — never report it as "no changes"

`get_cell_history`, `get_unattributed_changes`, the `rockhopper://files/{id}/changes`
resource and the change prompts all serve change history strictly: while Rockhopper is
still computing a file's history they refuse, and the refusal carries
`{"status":"not_ready", "reason": …, "retryAfterSeconds": N}` with `isError: true`
(the resource and prompts throw).

A refusal means **nothing is known yet**. It is not an empty history, not zero changes,
and not evidence that the file is unmodified. Wait `retryAfterSeconds` and ask again;
never answer a user's question about what changed from a not-ready response.

## 3. Commenting workflow

Comments are scoped to a version. The default version is the latest **committed** one.

1. `add_comment({ fileMsId, message, cellReference })` — creates a top-level comment on the latest version.
2. `reply_to_comment({ parentCommentId, message })` — `parentCommentId` is the `internalId` from `get_file_comments`, **not** a substring or message match.
3. `resolve_comment({ commentId })` — closes a thread. Idempotent — calling on an already-resolved comment is a no-op (returns the existing record).

Comments on historical versions:

- Pass `versionInternalId` explicitly to `add_comment` to comment on a historical version snapshot.
- `get_file_comments` accepts `versionInternalId` if you want to read historical-version comments rather than the current set.

## 4. Review lifecycle

Reviews follow a strict state machine: **`pending` → `approved`** or **`pending` → `cancelled`**. No other transitions are valid.

1. `create_review_request({ versionId, reviewerIds, subject, description? })` — creates a `pending` review. Only the file owner / workspace member with edit rights can create. `reviewerIds` is an array of user ids, **not** email addresses; read them from `rockhopper://teams/{teamId}` and send each member's `id` (uuid).
2. `approve_review({ reviewId })` — moves `pending` → `approved`. **Only** assigned reviewers can approve.
3. `cancel_review({ reviewId })` — moves `pending` → `cancelled`. **Only** the requester can cancel.

Calling `approve_review` before `create_review_request` returns a 404 — there is no review to approve. Calling `approve_review` on an already-approved or cancelled review returns a 409 conflict.

## 5. Versioning

`create_version` snapshots the file's current uncommitted state as a new version.

Rules:

- **Requires uncommitted changes.** If `get_unattributed_changes(fileMsId)` returns an empty list, `create_version` will fail with "no changes to commit".
- **Auto-bumps semver** from the latest committed version. Defaults to patch (`1.0.0` → `1.0.1`). Pass `bumpType: 'minor' | 'major'` to override.
- **Optional `description`** — a one-line changelog entry. Recommended for any non-trivial version.

`discard_changes(fileMsId)` is the **destructive** alternative: it wipes uncommitted edits without creating a snapshot. Use only when the user explicitly asks to throw away unsaved work — call `get_unattributed_changes(fileMsId)` first and confirm with the user before discarding anything substantive.

## 6. Uncommitted changes vs. committed history

Two distinct concepts. Tools work with one or the other; do not mix.

- **Committed history** — version snapshots created by `create_version`. Surfaced by `get_file_versions`, `get_cell_history`. Immutable.
- **Uncommitted changes** — cell edits the user has made since the last `create_version`. Surfaced by `get_unattributed_changes`. Mutable; consumed by the next `create_version` or `discard_changes` call.

Note: on files served from the change ledger (most Microsoft files), `get_cell_history` also includes live edits not yet captured by a committed version — those entries carry the literal versionId `uncommitted`. On files still served from the legacy store, only committed values appear; use `get_unattributed_changes` for pending edits there.

## 7. Cross-cloud differences

Rockhopper supports both Microsoft Excel files (M365 / OneDrive) and Google Sheets. Tool calls work transparently across both, but the identifiers carry different meanings:

| Field | Microsoft Excel | Google Sheets |
|-------|------------------|----------------|
| `fileType` | `microsoft_xlsx` | `google_sheets` |
| `driveMsId` | OneDrive / SharePoint drive ID | Google Drive file ID (yes, the field name is misleading for the Google case) |
| `platformId` (= `fileMsId`) | Microsoft graph file ID | Google Drive file ID |

If a tool description references "drive ID" or "platform ID", it works identically across both clouds. If you need to know the platform, inspect `fileType`.

## 8. Error handling

Tool failures return structured responses with `isError: true` and a human-readable message in `content`. Common patterns:

- **404 / "not found"** — usually a wrong-identifier-type error. Re-check the IDs section above.
- **409 / "conflict"** — state-machine violation (e.g. approving an already-approved review).
- **403 / "forbidden"** — permission error (e.g. non-reviewer calling `approve_review`).
- **5xx** — server-side error. Retry once; if it persists, surface the error to the user — don't loop.

When a tool returns `isError: true`, do not silently retry with the same arguments. Either correct the arguments based on the error message or surface the failure.

## 9. Resources

The MCP server exposes two static resources via `resources/list`:

- `rockhopper://files` — workspace-level enrolled files listing. Same data as `list_files` tool.
- `rockhopper://orchestration-guide` — this document.

Eight URI templates via `resources/templates/list` — read these by constructing a concrete URI from the template pattern:

- `rockhopper://files/{fileMsId}` — file details
- `rockhopper://files/{fileMsId}/versions` — version history
- `rockhopper://files/{fileMsId}/comments` — all comments
- `rockhopper://files/{fileMsId}/changes` — uncommitted changes
- `rockhopper://versions/{versionId}` — version details
- `rockhopper://versions/{versionId}/reviews` — reviews on a version
- `rockhopper://reviews/{reviewId}` — review details
- `rockhopper://teams/{teamId}` — team details

Resources and tools return the same data for the same identifiers. Tools are preferable when you need argument shaping (filters, search); resources are preferable when you have a known URI and want the canonical representation.
