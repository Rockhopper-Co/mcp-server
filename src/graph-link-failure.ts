/**
 * ENG-4311 — the delegated-Microsoft failure codes, spelled ONCE.
 *
 * ## The defect this exists to close
 *
 * `list_unenrolled_files` guarded against its worst failure — reporting "we
 * never managed to look" as "there is nothing to add" — with
 * `lastFailureReason === 'no_delegated_token'`. The backend does not write
 * that string. Traced end to end:
 *
 *   1. `backend/src/resources/graph-links/graph-link-errors.ts` — the
 *      `GraphLinkFailure` enum is SCREAMING_SNAKE, and
 *      `NoDelegatedTokenError.reason` is a required constructor argument, so
 *      it is always one of the four values below.
 *   2. `backend/src/user-drive-inventory/user-drive-inventory-refresh.service.ts`
 *      passes `error.reason` — the enum value — as the recorded reason.
 *   3. `backend/src/user-drive-inventory/user-drive-sync-state.service.ts`
 *      stores `detail.reason ?? outcome`. `detail.reason` is set on that path,
 *      so the `?? outcome` fallback never runs.
 *   4. `backend/src/user-drive-inventory/user-drive-inventory.service.ts`
 *      serializes the column verbatim. Nothing normalises the case anywhere.
 *
 * So the lowercase comparison never matched, the branch was unreachable, and a
 * user with no working Microsoft link fell through to "the first scan has not
 * finished, one has been started, try again shortly" — an instruction to retry,
 * addressed to a state that no retry can change, with the real reason printed
 * in a parenthetical one sentence later.
 *
 * ## Why the values live here and not in the two files that read them
 *
 * `drive-search.ts` already compared `CONSENT_REQUIRED` correctly. One repo
 * held two spellings of one enum, and the file that got it wrong is the file
 * nobody re-read. A second copy is what produced the defect, so there is one
 * copy, imported by both.
 *
 * The strings are duplicated from the backend rather than imported because
 * this package ships to customers over npm on its own release clock and takes
 * no build dependency on the API. `LEGACY_OUTCOME_NAME` is what keeps that
 * duplication honest in the one direction it can drift safely.
 */

/**
 * The four reasons a delegated Microsoft call can fail, byte-for-byte as the
 * backend's `GraphLinkFailure` enum writes them.
 *
 * They are NOT interchangeable. Three of the four name a different party who
 * has to act, and collapsing them is how ENG-2614's loop happened: a user whose
 * TENANT is the blocker was handed a connect link, sent to Microsoft, refused,
 * and returned with the same link.
 */
export const GRAPH_LINK_FAILURE = {
  /** No link on file — never consented, or unlinked. The user connects. */
  NO_DELEGATED_TOKEN: 'NO_DELEGATED_TOKEN',
  /** Microsoft rejected the stored refresh token. The user reconnects. */
  DELEGATED_TOKEN_REJECTED: 'DELEGATED_TOKEN_REJECTED',
  /** The ciphertext will not open under our key. OUR fault; the user
   * reconnects anyway, because that is the only lever they hold. */
  DELEGATED_TOKEN_UNREADABLE: 'DELEGATED_TOKEN_UNREADABLE',
  /** The tenant has not approved Rockhopper. ONLY an administrator can act. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
} as const;

export type GraphLinkFailure =
  (typeof GRAPH_LINK_FAILURE)[keyof typeof GRAPH_LINK_FAILURE];

/**
 * The lowercase OUTCOME name, which is a different thing from a reason and is
 * still reachable.
 *
 * `recordOutcome` stores `detail.reason ?? outcome`, so a caller that records
 * the outcome with no reason lands here, and so does any backend older than
 * the enum. Accepted as `NO_DELEGATED_TOKEN` — the coarse answer it always
 * meant — rather than dropped, because refusing it would re-open the same hole
 * for the deployments that do send it.
 */
const LEGACY_OUTCOME_NAME = 'no_delegated_token';

const KNOWN: ReadonlySet<string> = new Set(Object.values(GRAPH_LINK_FAILURE));

/**
 * The delegated-link failure a recorded reason names, or `null`.
 *
 * `null` means "this is not a link failure" — `graph_unavailable`,
 * `token_mint_failed`, an exception name, or nothing recorded at all. Those
 * keep their existing handling: a caller must not render a Graph outage as a
 * broken link, which would send the user to reconnect something that works.
 *
 * EXACT MATCH on the four. No case folding and no prefix test: a value we do
 * not recognise is not "probably one of these", it is a code this package has
 * not learned about, and guessing is what put a made-up string in the
 * comparison in the first place.
 */
export function graphLinkFailureFrom(
  reason: string | null | undefined,
): GraphLinkFailure | null {
  if (typeof reason !== 'string') return null;
  if (reason === LEGACY_OUTCOME_NAME) {
    return GRAPH_LINK_FAILURE.NO_DELEGATED_TOKEN;
  }
  return KNOWN.has(reason) ? (reason as GraphLinkFailure) : null;
}

/**
 * What to tell the assistant for each failure, written to be ACTED on.
 *
 * Two rules hold across all four, and both are the point of the ticket:
 *
 *  - **No retry language.** Every one of these is stable until a person does
 *    something outside this session. "Try again shortly" is what the dead
 *    branch's fall-through said, and a model complies with it.
 *  - **`connect_microsoft` appears only where the USER can fix it.** It is
 *    absent from the consent case on purpose (ENG-2614), and its absence is
 *    asserted rather than assumed.
 *
 * Each also states that an empty list is not evidence of an empty drive, since
 * that inference is the harm the whole surface is written against.
 */
const NOT_EVIDENCE =
  ' This list will stay empty until that is done, which is NOT the same as ' +
  'having nothing to add.';

export const GRAPH_LINK_FAILURE_TEXT: Readonly<
  Record<GraphLinkFailure, string>
> = {
  [GRAPH_LINK_FAILURE.NO_DELEGATED_TOKEN]:
    'Rockhopper cannot see this user\'s workbooks: their Microsoft account ' +
    'is not connected. Run `connect_microsoft` first.' + NOT_EVIDENCE,

  [GRAPH_LINK_FAILURE.DELEGATED_TOKEN_REJECTED]:
    'Rockhopper cannot see this user\'s workbooks: their connection to ' +
    'Microsoft has expired or was revoked — in Microsoft, by them or by an ' +
    'administrator. Run `connect_microsoft` to reconnect.' + NOT_EVIDENCE,

  [GRAPH_LINK_FAILURE.DELEGATED_TOKEN_UNREADABLE]:
    'Rockhopper cannot see this user\'s workbooks: the stored Microsoft ' +
    'connection could not be read. That is a Rockhopper-side fault, not ' +
    'anything the user did wrong, and reconnecting repairs it — run ' +
    '`connect_microsoft`.' + NOT_EVIDENCE,

  // No connect link, deliberately: there is nothing on the far end of one for
  // this user until an administrator acts. Mirrors `ADMIN_CONSENT_TEXT` in
  // `drive-search.ts`, which answers the same condition on the search surface.
  [GRAPH_LINK_FAILURE.CONSENT_REQUIRED]:
    'Rockhopper cannot see this user\'s workbooks because their organisation ' +
    'has not approved Rockhopper yet. Microsoft only lets a Microsoft 365 ' +
    'administrator approve this — the user cannot grant it themselves, and ' +
    'connecting or signing in again will not change the answer. Ask the user ' +
    'to send their IT administrator to ' +
    'https://docs.rockhopper.co/it-setup/approve-file-access.' + NOT_EVIDENCE,
};
