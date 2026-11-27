/**
 * The backend refuses an AI-specific read (an AI filter on a change read, AI
 * detail the plan withholds) when the caller's organization plan does not
 * include it: HTTP 403 with
 * `{"statusCode":403,"error":"Forbidden","message":"Your organization's plan
 * does not include this","code":"plan_excludes_feature"}`.
 *
 * Rendered through the generic error branch, an assistant reads "Rockhopper
 * API 403" as a broken tool or a permission problem, and may answer from what
 * it already has, which is exactly the "no AI was involved" it must not say.
 * So the code is matched structurally, as `cell-history-unavailable.ts`
 * matches its own, and rendered as a named refusal with its remedy.
 */

/** The backend's refusal code. */
export const PLAN_EXCLUDES_FEATURE_CODE = 'plan_excludes_feature';

/** Grep marker; also the first token of the refusal an assistant sees. */
export const PLAN_EXCLUDES_FEATURE_MARKER = 'PLAN_EXCLUDES_FEATURE';

/** Matches the backend's coded refusal, and any error carrying one as `cause`. */
export function isPlanExcludesFeature(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === PLAN_EXCLUDES_FEATURE_CODE) return true;
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)
    ?.cause;
  return cause?.code === PLAN_EXCLUDES_FEATURE_CODE;
}

export interface PlanRefusalToolResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * The tool answer for the refusal: `isError`, prose naming the wrong
 * inference and the remedy, and a JSON object to branch on.
 */
export function planExcludesFeatureToolResult(): PlanRefusalToolResult {
  const payload = { status: 'refused', code: PLAN_EXCLUDES_FEATURE_CODE };
  return {
    content: [
      {
        type: 'text',
        text:
          `${PLAN_EXCLUDES_FEATURE_MARKER} — this is NOT a result and NOT an ` +
          `empty result.\n` +
          `This organization's plan does not include the AI attribution this ` +
          `request asked for, so Rockhopper refused it.\n` +
          `Do NOT say that no AI was involved or that nothing matched — none ` +
          `of that is known.\n` +
          `Tell the user that AI attribution needs an organization plan ` +
          `that includes it.\n` +
          JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}
