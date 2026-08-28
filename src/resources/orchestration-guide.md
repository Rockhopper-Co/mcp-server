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
| `url` / `driveMsId` + `msId` | strings | The user's browser address bar, or a Microsoft file listing | `enroll_file` only — these name a file Rockhopper does **not** have yet, which is why no `fileMsId` exists for it |

Decision tree:

- **Reading file metadata** → `fileMsId`.
- **Writing a comment** → `fileMsId` (the server auto-resolves the latest version) OR `versionInternalId` if commenting on a historical version.
- **Acting on a review** → `versionId`.
- **Naming a person or a team** → their `id` (uuid).

### Users and teams take two spellings; send the uuid

A user or team can be named by its `id` (a uuid, e.g. `0198f3a1-2b4c-7d8e-9f01-23456789abcd`) or by its legacy `internalId` (a number). Both are accepted and both name the same record, and the two can be mixed inside one `reviewerIds` array.

**Send the uuid.** The numeric form is accepted until **2027-09-14** and is removed after that date. Nothing else in this guide takes a uuid — `versionId`, `versionInternalId` and comment ids stay numeric.

If a tool returns an error like "expected versionId but received fileMsId", you used the wrong identifier — check the tool description for which type it accepts.

## 2. Adding a file to Rockhopper (enrollment)

Every other tool works on files Rockhopper ALREADY has. `enroll_file` is the only one that adds a new one, and reaching for it is the right move more often than it looks: `list_files` and `search_files` see only files that are already enrolled AND not archived by this person, so a workbook the user is talking about that appears in neither is not one that does not exist. It is one of two things, and you cannot tell them apart from the empty result — ask.

- **Never added.** `search_drive_files` is how you find it, then `enroll_file`.
- **Archived by this person.** Archive is a per-person hide: the file is still enrolled, still tracked, and still on every teammate's list. It is restored from the archived list in the Rockhopper web app. There is no archive or restore tool here, so this one is the user's to undo — say so rather than offering to enroll a file that is already enrolled.

**Identity.** Two ways to name the file, mutually exclusive:

- `url` — the SharePoint or OneDrive address, copied from the browser bar. Prefer this always: it names exactly one file, so there is no wrong-match risk.
- `driveMsId` + `msId` — the Microsoft pair, when another tool already produced it. Both are required together.

### Finding the file first: `search_drive_files` → confirm → `enroll_file`

Most users cannot produce a link on request. `search_drive_files` looks across the user's own OneDrive and SharePoint — **including workbooks Rockhopper has never seen** — and marks each candidate `not in Rockhopper yet`, `already in Rockhopper`, or `previously removed`. It is the only tool that can see an un-enrolled file.

The two steps are one flow and the middle one is not optional:

1. `search_drive_files({ query: "Q3 forecast" })` — or `scope: "recent"` when the user cannot remember the name.
2. **Show the candidates and ask which one they meant.** Quote the names; never choose for them, and never report a file as already enrolled because one result looked similar — that specific mistake is why this tool exists. Call `search_drive_files` again with their `confirm_index` and the `confirm_token` from that answer. Some clients render the question themselves; either way, one comes back confirmed.
3. Pass the `driveMsId` + `msId` the confirmation returned to `enroll_file`, which then asks who may see the file.

Only files that came back from the search can be confirmed. A pick that names anything else answers `unknown_candidate` and adds nothing.

**`declined` and `dismissed` are not the same answer.** `declined` means the user read the candidates and said none of them is the file — the search missed, so try a different word. `dismissed` means the prompt closed without them answering it: they have told you nothing, so do **not** search again and do not treat it as a rejection. List the candidates in the conversation yourself, ask which one they meant, and say they can paste the workbook's link instead.

**`link_supplied`** means the user pasted the workbook's own address rather than picking a row. Call `enroll_file` with that `url` alone — no `driveMsId`, no `msId`.

**Searching is capped per session.** A fixed number of searches, after which `search_limit_reached` is the only answer and waiting does not restore it. Search deliberately — two or three well-chosen queries, not a browse. If the cap is reached, ask the user for the workbook link and use `enroll_file` directly.

**No Microsoft account connected?** `search_drive_files` answers `microsoft_not_connected` and hands back a sign-in link Rockhopper built. Give the user that link verbatim. Never compose a Microsoft sign-in URL yourself — a link the assistant made up sends the user's consent wherever whoever wrote it wanted.

**Microsoft only.** SharePoint and OneDrive-for-Business workbooks. A Google Drive or Sheets link returns `unsupported_provider`; that is final, so do not ask the user for a different link.

**You must ask who may see it.** `share_with` is required and has two values: `"me"` (visible to the user alone) and `"team"` (also fanned out to their teammates). Ask the user every time — do not assume, and do not carry an answer over from a previous file. Calling without it enrolls nothing and returns `share_with_required` plus the question to put to them.

**A removed file is restored, never re-added.** Rockhopper keeps three states, not two: `enrolled`, `hidden` and `not_enrolled`. `hidden` means somebody deliberately removed the file from the file lists — its versions, comments and change history all survived. Enrolling a hidden file therefore RESTORES the original, and because that undoes a person's decision it needs their say-so: the first call answers `restore_confirmation_required` and writes nothing; only a second call carrying `confirm_restore: true` restores it.

**Enrollment is asynchronous, and re-calling is safe.** The answer says the file was accepted, not that it is ready — Rockhopper reads the workbook in the background and its versions appear shortly after. If the answer is lost to a dropped connection mid-call, just call again: the file row is written before the background work starts, so the second call answers `already_enrolled` rather than adding anything twice.

**Outcomes.** Every response ends with a JSON object carrying an `outcome` field, so these can be branched on without reading the prose:

| `outcome` | Meaning | What to do |
|-----------|---------|------------|
| `enrolled` | Accepted; the file was not here before | Tell the user it is being added |
| `restored` | Accepted; a file they had removed is back | Tell the user it is being restored |
| `already_enrolled` | It is already here and visible | Nothing — go straight to reading it |
| `share_with_required` | No `share_with`, or a `"team"` that resolves to nobody | Ask the user, then call again |
| `restore_confirmation_required` | The target is hidden | Ask the user, then call again with `confirm_restore: true` |
| `access_unproven` | Rockhopper cannot confirm the user can open the file | Run `connect_microsoft`, then retry — but read the note below first |
| `unresolvable` | The link names no file Rockhopper can find | Ask for the address from the browser bar |
| `unsupported_provider` | Not a Microsoft link | Stop; do not ask for another link |
| `backend_unsupported` | This Rockhopper deployment predates the enrollment API | Tell the user to add the file from the web app |

**Why `access_unproven` happens, and when it should not.** Rockhopper will not add a file on the user's say-so; it checks with Microsoft that they can actually open it. That check needs a Microsoft grant belonging to the user, and where it comes from depends on how this session was started.

- **Signed in through `mcp.rockhopper.co`** (a web assistant, over OAuth): the grant was established at sign-in, in the same consent that signed them in (ENG-2790). `access_unproven` should be **unreachable** here. If it happens anyway, something is wrong — the grant was revoked in Microsoft, or the handover at sign-in failed. `connect_microsoft` is the **repair**, and it is worth saying so plainly rather than presenting it as a setup step the user skipped.
- **Running locally over stdio** (a desktop assistant with a personal access token): this session carries no Microsoft sign-in of its own, so the user does have to link their account once with `connect_microsoft`. Until they do, every enroll is refused — deliberately, not as a bug.

Do not tell a user they "need to connect Microsoft first" without knowing which of the two they are in. For most web-assistant users that instruction names a step that already happened, which reads as the product being broken.

## 3. Reading workflow

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

**Right after `enroll_file`, expect it.** Rockhopper reads the workbook for the first
time after the file row exists, so for roughly the first minute `get_file_versions`,
`get_unattributed_changes` and both resources refuse with
`"reason": "enrollment_incomplete"`. That is the enrolment still running, not a failure
and not a file without history — do not tell the user the workbook has no versions,
and do not re-enrol it. Wait `retryAfterSeconds` and ask again.

## 4. Commenting workflow

Comments are scoped to a version. The default version is the latest **committed** one.

1. `add_comment({ fileMsId, message, cellReference })` — creates a top-level comment on the latest version.
2. `reply_to_comment({ parentCommentId, message })` — `parentCommentId` is the `internalId` from `get_file_comments`, **not** a substring or message match.
3. `resolve_comment({ commentId })` — closes a thread. Idempotent — calling on an already-resolved comment is a no-op (returns the existing record).

Comments on historical versions:

- Pass `versionInternalId` explicitly to `add_comment` to comment on a historical version snapshot.
- `get_file_comments` accepts `versionInternalId` if you want to read historical-version comments rather than the current set.

## 5. Review lifecycle

Reviews follow a strict state machine: **`pending` → `approved`** or **`pending` → `cancelled`**. No other transitions are valid.

1. `create_review_request({ versionId, reviewerIds, subject, description? })` — creates a `pending` review. Only the file owner / workspace member with edit rights can create. `reviewerIds` is an array of user ids, **not** email addresses; read them from `rockhopper://teams/{teamId}` and send each member's `id` (uuid).
2. `approve_review({ reviewId })` — moves `pending` → `approved`. **Only** assigned reviewers can approve.
3. `cancel_review({ reviewId })` — moves `pending` → `cancelled`. **Only** the requester can cancel.

Calling `approve_review` before `create_review_request` returns a 404 — there is no review to approve. Calling `approve_review` on an already-approved or cancelled review returns a 409 conflict.

## 6. Versioning

`create_version` snapshots the file's current uncommitted state as a new version.

Rules:

- **Requires uncommitted changes.** If `get_unattributed_changes(fileMsId)` returns an empty list, `create_version` will fail with "no changes to commit".
- **Auto-bumps semver** from the latest committed version. Defaults to patch (`1.0.0` → `1.0.1`). Pass `bumpType: 'minor' | 'major'` to override.
- **Optional `description`** — a one-line changelog entry. Recommended for any non-trivial version.

`discard_changes(fileMsId)` is the **destructive** alternative: it wipes uncommitted edits without creating a snapshot. Use only when the user explicitly asks to throw away unsaved work — call `get_unattributed_changes(fileMsId)` first and confirm with the user before discarding anything substantive.

## 7. Uncommitted changes vs. committed history

Two distinct concepts. Tools work with one or the other; do not mix.

- **Committed history** — version snapshots created by `create_version`. Surfaced by `get_file_versions`, `get_cell_history`. Immutable.
- **Uncommitted changes** — cell edits the user has made since the last `create_version`. Surfaced by `get_unattributed_changes`. Mutable; consumed by the next `create_version` or `discard_changes` call.

Note: on files served from the change ledger (most Microsoft files), `get_cell_history` also includes live edits not yet captured by a committed version — those entries carry the literal versionId `uncommitted`. On files still served from the legacy store, only committed values appear; use `get_unattributed_changes` for pending edits there.

## 8. Cross-cloud differences

Rockhopper supports both Microsoft Excel files (M365 / OneDrive) and Google Sheets. Tool calls work transparently across both, but the identifiers carry different meanings:

| Field | Microsoft Excel | Google Sheets |
|-------|------------------|----------------|
| `fileType` | `microsoft_xlsx` | `google_sheets` |
| `driveMsId` | OneDrive / SharePoint drive ID | Google Drive file ID (yes, the field name is misleading for the Google case) |
| `platformId` (= `fileMsId`) | Microsoft graph file ID | Google Drive file ID |

If a tool description references "drive ID" or "platform ID", it works identically across both clouds. If you need to know the platform, inspect `fileType`.

## 9. Error handling

Tool failures return structured responses with `isError: true` and a human-readable message in `content`. Common patterns:

- **404 / "not found"** — usually a wrong-identifier-type error. Re-check the IDs section above.
- **409 / "conflict"** — state-machine violation (e.g. approving an already-approved review).
- **403 / "forbidden"** — permission error (e.g. non-reviewer calling `approve_review`).
- **5xx** — server-side error. Retry once; if it persists, surface the error to the user — don't loop.

When a tool returns `isError: true`, do not silently retry with the same arguments. Either correct the arguments based on the error message or surface the failure.

## 10. Resources

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
