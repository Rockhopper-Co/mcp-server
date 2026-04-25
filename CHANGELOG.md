# Changelog

All notable changes to this project are documented here. Follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
