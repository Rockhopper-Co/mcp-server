/**
 * ENG-2212 — the write-capability VOCABULARY, kept apart from the registrars
 * that act on it.
 *
 * Its own module because `instructions.ts` needs the tool names per family and
 * `tools/index.ts` needs the registrars: folding both into one module means
 * every test that mocks the registration seam also has to restate the
 * vocabulary, and a restated vocabulary is one that drifts.
 */

/**
 * The four write families a Personal Access Token may hold, in the order they
 * are reported and rendered. Mirrors the backend's `PatCapability`
 * (`backend/src/resources/personal-access-tokens/pat-capabilities.ts`) and the
 * `CHK_pat_scopes_vocabulary` constraint on the stored column.
 */
export const PAT_CAPABILITIES = [
  'comments:write',
  'reviews:write',
  'versions:write',
  'files:write',
] as const;

export type PatCapability = (typeof PAT_CAPABILITIES)[number];

export const CAPABILITY_SET: ReadonlySet<string> = new Set(PAT_CAPABILITIES);

/**
 * The write tools each family covers.
 *
 * This is the VOCABULARY, not the registration list. ENG-2212 named
 * `enroll_file` here before any registrar existed, so that ENG-2200 only had
 * to add a registrar and drop one entry from {@link PENDING_WRITE_TOOLS}
 * rather than re-cut the family map in every repo that copied it. That is
 * exactly what ENG-2200 did, and the pending set is now empty.
 */
export const WRITE_TOOLS_BY_CAPABILITY: Readonly<
  Record<PatCapability, readonly string[]>
> = {
  'comments:write': ['add_comment', 'reply_to_comment', 'resolve_comment'],
  'reviews:write': ['create_review_request', 'approve_review', 'cancel_review'],
  'versions:write': ['create_version', 'discard_changes'],
  'files:write': ['rename_file', 'enroll_file'],
};

/**
 * Names in {@link WRITE_TOOLS_BY_CAPABILITY} that no registrar registers yet.
 *
 * Kept explicit so the instructions string never advertises a tool the model
 * cannot call, and so `tools.capability-gate.test.ts` can assert that every
 * OTHER enumerated name really is registered — a set derived from the
 * registrars rather than a second hand-maintained list that silently drifts.
 */
export const PENDING_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([]);

/** The tools a granted family actually adds to the surface today. */
export function registeredToolsForCapabilities(
  capabilities: readonly PatCapability[],
): string[] {
  return capabilities.flatMap((capability) =>
    WRITE_TOOLS_BY_CAPABILITY[capability].filter(
      (name) => !PENDING_WRITE_TOOLS.has(name),
    ),
  );
}
