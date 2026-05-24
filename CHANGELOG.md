# Changelog

All notable changes to this project are documented here. Follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed
- `ROCKHOPPER_TOKEN` is now **optional** (was required). Unset → OAuth.
  Set → PAT auth path.

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
