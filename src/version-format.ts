/**
 * ENG-2750 — the one place a Rockhopper version number becomes text.
 *
 * The backend records a provisional pre-discard snapshot by NEGATING all three
 * semver components (`convergence-orchestrator.service.ts:178`) and identifies
 * one by `isDiscard = version.majorVersion < 0`
 * (`file-versions.service.ts:781`; documented on `TVersion` in
 * `dto/create-file-version.dto.ts` and `FileVersion.discardConfirmedAt`).
 *
 * Interpolating the three numbers raw published that internal marker as a
 * version number — staging printed `- **v-2.0.0** (id: 814)`. This client's
 * consumer is a model, so the string is not cosmetic: `v-2.0.0` is quotable to
 * a customer, sorts ahead of v0.0.1, and reads as a legal argument value.
 *
 * Every renderer in this package goes through here so a marker the backend
 * adds later has exactly one place to be taught.
 */

/** The three semver columns, as carried on `FileVersion` and on a create response. */
export interface VersionNumberParts {
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
}

/**
 * Render a version for a human or a model to read.
 *
 * An ordinary version renders `v2.3.1`. A discard snapshot renders
 * `discard of v2.0.0` — what it is, naming the version it snapshotted, with no
 * invented positive number and nothing hidden.
 */
export function formatVersion(v: VersionNumberParts): string {
  if (v.majorVersion < 0) {
    // Every component is negated at the write site, so recover each one.
    const major = Math.abs(v.majorVersion);
    const minor = Math.abs(v.minorVersion);
    const patch = Math.abs(v.patchVersion);
    return `discard of v${major}.${minor}.${patch}`;
  }
  return `v${v.majorVersion}.${v.minorVersion}.${v.patchVersion}`;
}
