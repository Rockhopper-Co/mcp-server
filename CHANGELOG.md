# Changelog

All notable changes to this project are documented here. Follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
