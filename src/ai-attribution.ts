/**
 * AI attribution withheld by the organization's plan.
 *
 * When the caller's organization plan does not include AI attribution, the
 * backend still serves every change but strips its AI evidence: `aiLinks`
 * comes back `[]`, an AI `provenance` / `actorKind` comes back as the literal
 * `plan_locked`, and the driving human is nulled. A change list read that way
 * looks exactly like one where no AI was involved, and an assistant will say
 * so. That is a wrong answer, so every surface that renders such a read says
 * plainly that attribution is withheld, and from when.
 *
 * WHERE THE ANSWER ARRIVES, mirroring `aiLinksAvailable`:
 * - an object body carries `aiAttribution: 'shown' | 'plan_locked'` and
 *   `lockedFrom` (an ISO instant, or null) at the top level;
 * - every response also carries the `X-AI-Attribution` header, which holds
 *   the answer only, never `lockedFrom`. A bare-array body (the cell-history
 *   `format=mcp` read) has only the header, so the extent of the lock is
 *   unknown there and the note says so rather than guessing.
 *
 * An older backend sends neither, and its rows are what it served: absent
 * reads as shown, exactly as an absent `aiLinksAvailable` reads as checked.
 * Only the explicit `plan_locked` value ever reads as withheld.
 */

/** The response header carrying the answer (`shown` or `plan_locked`). */
export const AI_ATTRIBUTION_HEADER = 'X-AI-Attribution';

/** The value the backend writes into a withheld field, and the locked answer. */
export const PLAN_LOCKED = 'plan_locked';

export type AiAttribution =
  /** Attribution is served as recorded (also an older backend). */
  | { kind: 'shown' }
  /** Every change's AI attribution is withheld (`lockedFrom: null`). */
  | { kind: 'withheld_all' }
  /** Changes at or after `lockedFrom` are withheld; earlier ones are shown. */
  | { kind: 'withheld_from'; lockedFrom: string }
  /** Withheld, but only the header answered, so the extent is not known. */
  | { kind: 'withheld_extent_unknown' };

export const AI_ATTRIBUTION_SHOWN: AiAttribution = { kind: 'shown' };

/** True for a field the backend withheld (`plan_locked`). */
export function isPlanLocked(value: unknown): boolean {
  return value === PLAN_LOCKED;
}

/** The two body fields, read off any served object without trusting its type. */
function bodyFields(body: unknown): { aiAttribution?: unknown; lockedFrom?: unknown } {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as { aiAttribution?: unknown; lockedFrom?: unknown })
    : {};
}

/**
 * The body form, read off any served object (a bare array carries none).
 * Absent or any value but `plan_locked` reads as shown.
 */
export function aiAttributionFromBody(body: unknown): AiAttribution {
  const fields = bodyFields(body);
  if (!isPlanLocked(fields.aiAttribution)) return AI_ATTRIBUTION_SHOWN;
  const lockedFrom = fields.lockedFrom;
  if (lockedFrom === null) return { kind: 'withheld_all' };
  if (typeof lockedFrom === 'string' && lockedFrom.trim() !== '') {
    return { kind: 'withheld_from', lockedFrom: lockedFrom.trim() };
  }
  // `plan_locked` without a readable `lockedFrom`: withheld, extent unknown.
  return { kind: 'withheld_extent_unknown' };
}

/** The header form. It never carries `lockedFrom`, so the extent is unknown. */
export function aiAttributionFromHeaders(
  headers: { get(name: string): string | null } | undefined,
): AiAttribution {
  return isPlanLocked(headers?.get(AI_ATTRIBUTION_HEADER)?.trim())
    ? { kind: 'withheld_extent_unknown' }
    : AI_ATTRIBUTION_SHOWN;
}

/**
 * Two reads of one file (a summary and its pages): any withheld read wins.
 * Two dated locks keep the earlier date, which covers both; a withheld-all
 * covers everything; anything else not known exactly is unknown.
 */
export function mergeAiAttribution(a: AiAttribution, b: AiAttribution): AiAttribution {
  if (a.kind === 'shown') return b;
  if (b.kind === 'shown') return a;
  if (a.kind === 'withheld_all' || b.kind === 'withheld_all') {
    return { kind: 'withheld_all' };
  }
  if (a.kind === 'withheld_from' && b.kind === 'withheld_from') {
    return Date.parse(a.lockedFrom) <= Date.parse(b.lockedFrom) ? a : b;
  }
  return { kind: 'withheld_extent_unknown' };
}

/**
 * The backend's own wire fields for an answer, for a body this client builds
 * (the file-wide ledger page): nothing when shown, so an entitled body keeps
 * its bytes; `lockedFrom` only when the extent is known. Read back with
 * {@link aiAttributionFromBody}, which inverts it exactly.
 */
export function aiAttributionWireFields(a: AiAttribution): {
  aiAttribution?: typeof PLAN_LOCKED;
  lockedFrom?: string | null;
} {
  switch (a.kind) {
    case 'shown':
      return {};
    case 'withheld_all':
      return { aiAttribution: PLAN_LOCKED, lockedFrom: null };
    case 'withheld_from':
      return { aiAttribution: PLAN_LOCKED, lockedFrom: a.lockedFrom };
    case 'withheld_extent_unknown':
      return { aiAttribution: PLAN_LOCKED };
  }
}

const DO_NOT_INFER =
  'A change listed without AI credit may still have involved AI: do not ' +
  'report that no AI was involved.';

/** The assistant-facing note for a withheld read, or null when shown. */
export function aiAttributionWithheldNote(a: AiAttribution): string | null {
  switch (a.kind) {
    case 'shown':
      return null;
    case 'withheld_all':
      return (
        "AI attribution is not shown on this organization's plan, so these " +
        `changes do not say whether AI was involved. ${DO_NOT_INFER}`
      );
    case 'withheld_from':
      return (
        "AI attribution is not shown on this organization's plan for changes " +
        `made on or after ${a.lockedFrom}, so those changes do not say ` +
        `whether AI was involved. ${DO_NOT_INFER}`
      );
    case 'withheld_extent_unknown':
      return (
        "AI attribution is not shown on this organization's plan for some " +
        'or all of these changes, so they do not say whether AI was ' +
        `involved. ${DO_NOT_INFER}`
      );
  }
}

/** The note as an appended paragraph, or nothing when shown. */
export function aiAttributionSuffix(a: AiAttribution): string {
  const note = aiAttributionWithheldNote(a);
  return note === null ? '' : `\n\n${note}`;
}

/**
 * What a row prints in place of a withheld provenance or actor kind. Never
 * the raw `plan_locked`: it is not a kind of provenance or of actor.
 */
export const PLAN_LOCKED_ROW_MARK = "AI attribution not shown on this organization's plan";
