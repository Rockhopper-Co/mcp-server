# Changelog

All notable changes to this project are documented here. Follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-10

**No code changed between `0.10.0` and `1.0.0`.** This release exists to fix a
versioning trap, and states a compatibility promise that was already true.

### Why 1.0.0

On a `0.x` version npm reads a caret range as **minor-locked**: `^0.9.0` means
`>=0.9.0 <0.10.0`, not `<1.0.0`. Nobody reads it that way. It cost two releases
— `mcp-gateway` sat on `^0.9.0` and could not receive `0.10.0`, the very release
it was waiting for, and before that on the same coupling one release earlier
(ENG-2165, ENG-2233). At `1.x` a caret finally means "any compatible version".

### The compatibility promise

From `1.0.0`, a breaking change to any of the following requires a major bump:

- **Tool names and their input schemas.** These are the load-bearing ones. The
  schemas are runtime `zod` validators that execute **on the caller's machine**,
  before any request is sent, so narrowing one breaks that caller no matter how
  compatible the backend is. Widening a schema is not breaking; narrowing it is.
- **Resource URIs and templates**, and the prompts the server registers.
- **The CLI's flags and its stdio contract.**

Explicitly **not** covered, and free to change in a minor: internal modules, the
`dist/` layout, anything reachable only by deep-importing a path this package
does not document, and log output.

### Note for consumers

Move a `^0.x` range to `^1.0.0`. A `0.x` range will not pick this up.

## [Unreleased]

### Changed
- **Moved to the v2 MCP SDK (ENG-2175).** v2 is a package **split**, not a
  version bump: `@modelcontextprotocol/sdk` stays on the v1 line at 1.30.0
  forever, and v2 ships as `@modelcontextprotocol/{core,server,client,node}`.
  This package now depends on `@modelcontextprotocol/server` (and
  `@modelcontextprotocol/client` for tests). Tool `inputSchema` and prompt
  `argsSchema` are declared as `z.object({...})` rather than the raw
  `{ field: schema }` shape v1 accepted.

  **Nothing changes on the wire.** v2's `LATEST_PROTOCOL_VERSION` is
  `2025-11-25` — the same value v1 1.30.0 carried — so a connected client
  negotiates exactly the version it did before, and the advertised
  capabilities are unchanged (`prompts`, `resources`, `tools`). Serving
  protocol revision 2026-07-28 is separate work (ENG-2176).

### Breaking
- **`engines.node` moved from `>=18.0.0` to `>=20.0.0`.** Every v2 SDK package
  declares `engines.node: ">=20"`, so the previous floor advertised a Node
  version this package no longer runs on. Node 18 reached end of life on
  2025-04-30.

### Added
- **User and team ids are accepted as uuids (ENG-2230).** `reviewerIds` on
  `create_review_request` and `{teamId}` in `rockhopper://teams/{teamId}` now
  take either the version-7 uuid or the legacy numeric internal id, mixed
  freely. Rockhopper re-keyed `user`, `team` and `workspace` onto uuids
  (ENG-1966); until this release the published tool schema validated
  `reviewerIds` as `z.array(z.number().int().positive())`, so a uuid was
  refused **on your machine** before any request was sent — every version from
  0.2.0 through 0.10.0 is affected, and no server-side change could fix it.
  `UserSummary`, `Team` and `Workspace` gained the optional `id` (uuid) field
  the API already returns, and `ApiClient.getTeam()` /
  `ApiClient.createReviewRequest()` widened from `number` to `number | string`
  (exported as the new `RockhopperId` type).

  **Nothing that works today stops working.** The numeric form is accepted
  until **2027-09-14** and removed after that date; migrate to the uuid before
  then. Version, comment and review ids are unaffected and stay numeric.

- **Strict no-partial change history (`src/not-ready.ts`).** `get_cell_history`,
  `search` and the `changes` resource refuse to answer while a file's change
  history is still being built, instead of returning the fraction that happens
  to be ready. Callers get an explicit not-ready answer they can retry.

### Fixed
- **The server announced version `0.1.0` to every client, at every release
  (ENG-1955).** `createServer` passed a string literal to `McpServer`, so the
  version in the MCP `initialize` response was `0.1.0` — unchanged since the
  initial commit, so every published version (0.2.0 through 0.8.0) announced
  itself as 0.1.0, both for the locally installed server and for every web
  client reaching the same tools through `mcp-gateway`. It now reports
  `package.json`'s version, which is what makes two builds distinguishable
  at all.

### Added
- **Provenance-context emit on agent writes (ENG-1756 / decision 15).** Every
  write call (`POST`/`PUT`/`PATCH`/`DELETE`) now carries
  `X-Rockhopper-Surface` (`mcp`), a stable per-client-instance
  `X-Rockhopper-Session-Id`, and — once the driving human is known —
  `X-Driving-Human`. The CLI declares the PAT owner as the driving human from
  its existing `/users/me` preflight. Reads are unchanged (no headers).
  This satisfies the backend's decision-15 accountability invariant, which
  rejects (403) an agent-surface write with no resolvable driving human, and
  populates the `cell_change_provenance_context` sidecar for etymology reads.
  New public API: `ApiClient` config `provenanceContext` +
  `ApiClient.setDrivingHuman()` (used by `mcp-gateway` to declare the
  `gateway` surface and its OAuth session id).

- **Local rotating diagnostic logfile (KI-225).** The server now writes a
  local diagnostic log to `~/.rockhopper/mcp-server/` (rotated via
  `pino-roll`, ~5 MB × 5 files). It captures request latency plus the
  client-side failures the backend never sees — network-unreachable
  (`api_unreachable`), local auth rejection (`auth_failed`), response schema
  drift (`schema_validation_failed`), per-tool-call timing (`tool_call` /
  `tool_call_failed`), and uncaught crashes (`uncaught_exception` /
  `unhandled_rejection`). Every line auto-carries the Phase 1.1
  `correlationId`.
  - **File only — never stdout** (stdout is the MCP stdio transport). On any
    failure to open the file, logging degrades to a no-op; the server never
    crashes and never writes to stdout.
  - **No remote transmission.** The file stays on the customer's machine and
    can be handed to support.
  - **Redacted.** Tokens, `Authorization` headers, request/response bodies,
    tool arguments, and cell data are never logged — only event, method, URL
    pathname (no query), status, durationMs, tool name, correlationId,
    version, and error type/message.
  - Configurable via `ROCKHOPPER_MCP_LOG_DIR` / `ROCKHOPPER_MCP_LOG_LEVEL`;
    disable with `ROCKHOPPER_MCP_LOG_DISABLE`.

### Fixed
- **`get_cell_history`, `resolve_comment`, and `rename_file` no longer
  render `undefined` for every field (KI-096).** Diagnosis revealed the
  formatters were correct — the backend was returning the wrong shape
  on all three endpoints. Backend PR
  [#478](https://github.com/Rockhopper-Co/backend/pull/478) fixed the
  shapes; this PR adopts them:
  - `getCellHistory` passes `?format=mcp` to opt into the backend's
    normalized projection (`{versionId, value, changedBy, changedAt}`).
    Default `format` preserves the raw-CTE shape the frontend cell-
    history popover consumes — we never call that path.
  - `resolveComment` + `updateEnrolledFile` continue to call the same
    URLs but now receive the updated `FileChat` / `EnrolledFile` entity
    (was TypeORM `UpdateResult`).
  - `CellHistoryEntry.versionId` retyped `number` → `string` (was a
    contributing root cause of the `Version undefined` symptom — the
    backend's semver string never coerced to the declared numeric type).
- **`api-client.ts`: zod-parse opt-in for response validation
  (KI-096).** `request<T>(path, init?, responseSchema?)` now accepts an
  optional zod schema; when supplied, the response is parsed with
  `safeParse` and any drift throws a useful diagnostic
  (`Rockhopper API response failed schema check at <path>: <field> —
  <message>`) instead of silently rendering `undefined` in formatters.
  Three call sites opt in: `getCellHistory`, `resolveComment`,
  `updateEnrolledFile`. Other methods stay unchanged; a sweep ticket
  can migrate them later. New `src/zod-schemas.ts` module holds the
  per-entity schemas.

### Added
- **`search_files` `matchIn` parameter.** Optional enum (`name` |
  `comments` | `versions` | `all`); defaults to `name` for back-compat.
  Broadens search past file-name substring into comment text
  (`FileChat.message`) and version descriptions (`FileVersion.description`).
  Backed by [backend PR #472](https://github.com/Rockhopper-Co/backend/pull/472)
  / ENG-1383; behavior available once that merges. Closes KI-080.
- **OAuth device-grant flow (RFC 8628) as default auth.** First launch
  with no `ROCKHOPPER_TOKEN` env var now prints a verification code +
  URL to stderr, polls the backend's `/auth/device/{code,token}`
  endpoints, and persists the resulting bearer token in the OS keychain
  (Keychain on macOS, Credential Manager on Windows, libsecret on
  Linux). Subsequent launches reuse the stored token silently. Tokens
  default to a 60-minute lifetime; on expiry the next launch silently
  re-runs the flow. `ROCKHOPPER_TOKEN` still takes precedence when set
  — PAT path preserved for headless / CI scenarios. Backed by
  [backend PR #473](https://github.com/Rockhopper-Co/backend/pull/473)
  / ENG-1384. Closes KI-081 / ENG-1444.
- **`get_unattributed_changes` cursor pagination + cap/summary (KI-097).**
  File-wide mode now uses the dedicated paginated backend route
  (`GET /unattributed-changes/paginated/:fileMsId`, added by
  [backend PR #475](https://github.com/Rockhopper-Co/backend/pull/475) /
  KI-102) instead of the legacy unpaginated route. The MCP tool gains an
  optional `cursor` input for round-tripping the backend's cursor.
  Responses are now capped at 200 displayed rows with a summary line
  ("Showing X of Y change(s) on this page (Z total across the file)" +
  top-sheets breakdown) and a pagination hint when more pages or hidden
  rows are available. Audit measured one file at 12.5 MB / 28k rows on
  the old route — context-blowing for AI clients; now bounded under
  the 25k-token MCP limit. Sheet-filter mode (`sheetName` set) is
  unchanged — it stays unpaginated since sheet size inherently bounds
  it. Closes KI-097.

### Changed
- `ROCKHOPPER_TOKEN` is now **optional** (was required). Unset → OAuth.
  Set → PAT auth path.
- **`ApiClient.getUnattributedChanges` refactored into two methods**
  (KI-097): `getUnattributedChangesBySheet(fileMsId, sheetName)` for
  the sheet-filtered legacy route, and
  `getUnattributedChangesPaginated(fileMsId, cursor?)` for the new
  cursor-paginated route. The old combined method is removed. External
  consumers of `ApiClient` (e.g. `mcp-gateway`) only use `createServer`
  + `ApiClient` as types, not these methods directly, so the rename has
  zero blast radius outside this repo.

### Dependencies
- **`keytar`** (new runtime dep) — OS-native keychain wrapper. Linux
  requires `libsecret` installed; otherwise the OAuth path errors with
  a clear remediation message and you must fall back to PAT.

### Changed (breaking)
- **`update_file_description` renamed to `rename_file`.** The tool always
  performed a rename (its `name` input wires to backend
  `PATCH /enrolled-files/:fileMsId`); the old name described non-existent
  "description" semantics. Customers using the npm-installed local server
  should update any tool-name allowlists or prompts referencing
  `update_file_description`. Closes KI-100 / ENG-1439.

### Fixed
- **`cancel_review` now actually cancels PENDING reviews.** The
  pre-flight status check at `tools/write-reviews.ts` compared against
  the lowercase string `'pending'`, but the backend's
  `ReviewRequestStatus` enum is uppercase (`PENDING`/`APPROVED`/
  `CANCELLED`). The check always failed → `api.cancelReview()` was never
  invoked → every cancel returned "cannot be cancelled — status is
  'PENDING'". Now uses a defensive `.toUpperCase()` comparison so the
  fix survives future backend casing flips. Closes KI-099 / ENG-1438.

### Internal
- Test fixtures in `src/__tests__/unit/test-helpers.ts` and
  `src/__tests__/e2e/fixtures/rockhopper-api-fixtures.ts` updated to use
  the real backend's uppercase `ReviewRequestStatus` enum values. Prior
  fixtures used lowercase, which masked KI-099 by being bug-symmetric
  with the broken code.

### Fixed (bundled — same casing-bug class as KI-099)
- **`file-overview` prompt no longer mis-classifies APPROVED + CANCELLED
  reviews as pending.** `prompts/index.ts:180` filtered with lowercase
  `r.status !== 'approved' && r.status !== 'rejected'`, but
  `ReviewRequestStatus` is uppercase and contains no `'rejected'` value
  (`PENDING`/`APPROVED`/`CANCELLED` only). Result: all non-pending
  reviews were silently counted as pending in the prompt output. Now
  filters with positive intent — `r.status?.toUpperCase() === 'PENDING'`.
  Sibling fix to KI-099; same casing-bug class but in a different
  surface (prompt vs. tool).

### Tooling
- **`npm run lint` now works.** The `lint` script referenced
  `eslint src/` but `eslint` was missing from `devDependencies`, so any
  fresh install silently produced `sh: eslint: command not found`. Added
  `@eslint/js`, `eslint`, `globals`, and `typescript-eslint` as devDeps
  and shipped a flat-config `eslint.config.js` that mirrors the
  `mcp-gateway` repo's setup. Test files relax
  `@typescript-eslint/no-explicit-any` (mock-stub casts) while production
  code keeps the rule on. Lint is clean across `src/`.

## [0.6.0] — 2026-05-13

> Released to npm as `0.6.0`. The release branch was prepared with
> `package.json` at `0.5.0` (set in [PR #37](https://github.com/Rockhopper-Co/mcp-server/pull/37)),
> but the `release:minor` script ran on top of that and produced `0.6.0`
> via `npm version minor`. No code differs between the `0.5.0` manifest
> and the `0.6.0` published artifact — the bump is purely a version-string
> change. Content below is what shipped.

### Changed
- **`resources/list` no longer enumerates per-file instances.** The 4
  per-file resource templates (`enrolled-file`, `file-versions`,
  `file-comments`, `unattributed-changes`) previously expanded into one
  concrete resource per enrolled file via their `list:` callbacks,
  bloating the response to 44+ entries at single-digit file counts and
  ~400 at 100 files. They now appear in `resources/templates/list`
  semantics instead — AI clients learn the URI pattern and construct
  concrete URIs on demand. `resources/list` stays at a small static set
  regardless of workspace size. Closes KI-078 / ENG-1381.

### Added
- **`rockhopper://orchestration-guide` resource.** Static markdown
  resource that documents tool sequencing, identity disambiguation
  (`fileMsId` vs `versionId` vs `versionInternalId`), the comment and
  review lifecycles, versioning rules, and cross-cloud (Microsoft vs
  Google Sheets) differences. AI clients can read it once at session
  start to avoid common tool-sequencing errors. Backed by
  `src/resources/orchestration-guide.md`. Closes KI-079 / ENG-1382.

### Internal
- Build step now copies `src/**/*.md` into `dist/` so non-`.ts` assets
  ship with the package (`scripts/copy-non-ts-assets.mjs`).
- Unit and e2e test updates: assert `resources/list` returns exactly 2
  static entries and `resources/templates/list` returns the 8 URI
  templates; new test reads the orchestration-guide content.
- Regenerated Postman collection (16 tools, 10 resources, 4 prompts).

### Breaking changes
- Behavior change in `resources/list` response shape. Downstream
  consumers that cached the previous per-file enumeration must refresh
  their resource lists. No tool, prompt, or resource-read semantics
  changed — only the `resources/list` response.

## [0.4.0] — 2026-05-03

### Added
- **`create_version` tool.** Commit uncommitted changes as a new semver
  version (major/minor/patch). Auto-computes the next version number from
  the latest committed version. Pre-checks `hasUncommittedChanges`.
- **`discard_changes` tool.** Discard all uncommitted changes, reverting
  to the latest committed version. Marked `destructiveHint: true`.
  Pre-checks `hasUncommittedChanges`. Discarded changes are preserved in
  version history for audit.
- **`cancel_review` tool.** Cancel a pending review request. Pre-checks
  that the review status is `pending`. Marked `destructiveHint: true`.
- `ApiClient` methods: `createVersion()`, `discardChanges()`,
  `cancelReview()`.

### Internal
- E2e and unit test coverage for all three new tools (success, error,
  and guard branches).
- Regenerated Postman collection (16 tools, 9 resources, 4 prompts).

## [0.3.0] — 2026-04-24

Adds a **library entry point** so `@rockhopper-co/mcp-server` can be
consumed programmatically — most notably by the remote MCP gateway
([`mcp-gateway`](https://github.com/Rockhopper-Co/mcp-gateway)) which
needs `createServer` and `ApiClient` to wire the Streamable HTTP
transport. The stdio CLI continues to work exactly as before.

### Added
- **Library exports.** `import { createServer, ApiClient } from
  '@rockhopper-co/mcp-server'` now works. The library entry is
  side-effect free — importing it does NOT read `ROCKHOPPER_TOKEN`,
  call `process.exit`, or open any transport. Stable surface:
  - `createServer(apiClient: ApiClient): McpServer`
  - `ApiClient` (class), `ApiClientConfig` (interface)
  - All entity types (`Team`, `EnrolledFile`, `FileVersion`, ...)
- `package.json` `exports` field with explicit subpath conditions for
  `.` (library) and `./package.json` (so consumers can read the
  package version). Anything else is intentionally not part of the
  public API.

### Changed
- **CLI moved** from `src/index.ts` → `src/cli.ts` so the default
  entrypoint can be a side-effect-free re-export. The `rockhopper-mcp`
  bin still works the same; `npx -y @rockhopper-co/mcp-server` still
  spawns the stdio server. Only difference: `dist/cli.js` is the
  shebang file now (was `dist/index.js`).
- `package.json` `bin`, `start`, and `dev` scripts now reference
  `cli.js` / `cli.ts`.
- Publish workflow's "Verify bin is executable" step now checks
  `dist/cli.js`.

### Internal
- New unit test `lib.exports.test.ts` enforces the side-effect-freedom
  invariant — fails loud if anyone re-introduces top-level CLI
  bootstrap into `index.ts` or `lib.ts`.
- Old `index.bootstrap.test.ts` renamed to `cli.bootstrap.test.ts`
  with imports adjusted.

## [0.2.1] — 2026-04-24

Publishing-pipeline hardening release. **No runtime or API changes** — the
package code is byte-equivalent to `0.2.0`. Bumped purely to validate the
CI/CD changes below on a real publish.

### Changed
- **npm Trusted Publishing (OIDC).** `publish.yml` no longer uses the
  long-lived `NPM_TOKEN` secret. The npm CLI exchanges a short-lived
  GitHub OIDC token for a publishing credential at release time, per
  https://docs.npmjs.com/trusted-publishers. Provenance attestation is
  now implied (cannot be disabled).
- **Canonical GitHub owner casing in `package.json`.** `repository.url`
  and `bugs.url` now use `Rockhopper-Co` (canonical) instead of
  `rockhopper-co` (lowercase). npm provenance does an exact string
  match against the GitHub-canonical owner — the lowercase URL caused
  E422 on the `0.2.0` first publish attempt before the bootstrap
  succeeded.
- **CI: npm CLI auto-upgraded** to >= 11.5.1 in the publish workflow
  (Node 20 ships with npm 10.x, which doesn't support Trusted
  Publishing).

## [0.2.0] — 2026-04-23

First public release on npm as `@rockhopper-co/mcp-server`.

### Added
- Public npm publishing under `@rockhopper-co/mcp-server`.
- MIT license.
- GitHub Actions `ci.yml` and `publish.yml` workflows.
- `prepublishOnly` build hook and `release:*` version scripts.
- `files` whitelist so only `dist/`, `README.md`, and `LICENSE` ship.
- npm provenance via OIDC in the publish workflow.
- `tsconfig.build.json` to exclude test files from the published
  tarball; production build now ships ~22 kB packed (vs ~80 kB before).

### Changed
- Required `versionInternalId` on `add_comment` and `reply_to_comment`
  to match backend DTO contracts.
- `create_review_request` now takes `versionId: number` and
  `reviewerIds: number[]` (was `fileVersionInternalId` / `reviewerMsIds`).
- Removed trailing slash from sheet-scoped unattributed-changes URL to
  match the backend route.

### Fixed
- Backend gap G1: `/file-versions/file/version/:versionInternalId` now
  requires JWT/PAT auth and file-access authorization.
- Backend gap G5: `search` query on `/enrolled-files` now filters by
  file name (ILIKE).
- Backend gap G8: PAT-authenticated file-chat requests now log a
  warning when Excel-native OBO sync is skipped.
- Backend gap G9/G12: PAT traffic is now throttled via a dedicated
  `PatThrottlerGuard` (120 req/min per user+scope).

## [0.1.0] — 2026-04-20

Internal prototype. Private package.
