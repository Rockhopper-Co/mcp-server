/**
 * The backend refuses a request by name when it cannot read the caller's
 * organization billing: HTTP 503 with
 * `{"statusCode":503,"error":"Service Unavailable","message":"Billing could
 * not be checked; try again","code":"billing_unreadable"}`.
 *
 * A 503 or 429 on a read lane otherwise means "outputs still producing"
 * (`not-ready.ts`), and a billing refusal sharing that status must not be
 * read as one: the not-ready answer tells an assistant the change history is
 * still being computed, which is false here. So the API client keeps a coded
 * billing refusal as `RockhopperApiError`, and the change-history tools render
 * it by its code, as `plan-excludes-feature.ts` renders its own.
 *
 * Only the codes that arrive on 429 or 503 from a route this client calls
 * are listed. A billing refusal on another status (403 `reviewer_seat`,
 * `plan_excludes_feature`) never reached the not-ready branch.
 */

/** The backend's code when it could not read the organization's billing. */
export const BILLING_UNREADABLE_CODE = 'billing_unreadable';

/** Billing refusal codes that share a status with the not-ready answer. */
const BILLING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  BILLING_UNREADABLE_CODE,
]);

/** Whether a 429/503 body's `code` names a billing refusal. */
export function isBillingRefusalCode(code: string | null): boolean {
  return code !== null && BILLING_REFUSAL_CODES.has(code);
}

/**
 * The billing refusal code an error carries, directly or as `cause`; null
 * for anything else. Matched structurally, so no import cycle forms with the
 * API client.
 */
export function billingRefusalCodeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && isBillingRefusalCode(code)) return code;
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)
    ?.cause?.code;
  return typeof cause === 'string' && isBillingRefusalCode(cause)
    ? cause
    : null;
}

/** Grep marker; also the first token of the refusal an assistant sees. */
export const BILLING_REFUSAL_MARKER = 'BILLING_REFUSED';

export interface BillingRefusalToolResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/** What each code means and what the user can do, in the assistant's words. */
const REMEDY: Readonly<Record<string, string>> = {
  [BILLING_UNREADABLE_CODE]:
    "Rockhopper could not confirm this organization's billing right now, " +
    'so it refused this request.\n' +
    "Tell the user that Rockhopper could not confirm their organization's " +
    'billing right now, and that trying again later may work.\n',
};

/**
 * The tool answer for a billing refusal: `isError`, prose naming the wrong
 * inference and the remedy, and a JSON object to branch on.
 */
export function billingRefusalToolResult(
  code: string,
): BillingRefusalToolResult {
  const payload = { status: 'refused', code };
  return {
    content: [
      {
        type: 'text',
        text:
          `${BILLING_REFUSAL_MARKER} — this is NOT a result and NOT an empty ` +
          `result.\n` +
          (REMEDY[code] ?? 'Rockhopper refused this request.\n') +
          `Do NOT say the file has no changes, no history or no versions, or ` +
          `that its history is empty — none of that is known.\n` +
          JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}
