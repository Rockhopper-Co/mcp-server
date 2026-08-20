import {
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import {
  SearchBudget,
  candidateAt,
  classifyDriveSearchFailure,
  createConfirmationCodec,
  ADMIN_CONSENT_TEXT,
  isAdminConsentRequired,
  isNoDelegatedToken,
  toCandidate,
  type Candidate,
} from '../drive-search.js';
import { log } from '../logger.js';
import {
  BUDGET_EXHAUSTED_TEXT,
  DECLINE_CHOICE,
  DRIVE_SEARCH_ANNOTATIONS,
  DRIVE_SEARCH_DESCRIPTION,
  DRIVE_SEARCH_INPUT_SCHEMA,
  NO_MATCHES_TEXT,
  RECENT_EMPTY_TEXT,
  confirmationForm,
  confirmationPrompt,
  confirmedAnswer,
  connectPrompt,
  declinedAnswer,
  dismissedAnswer,
  linkSuppliedAnswer,
  toolResult,
  unknownCandidateAnswer,
  usableLink,
} from './drive-search.contract.js';
import {
  CONFIRM_KEY,
  readRequestState,
  selectLane,
} from './drive-search-lanes.js';

/**
 * ENG-2204 (SP08) — the half of ENG-1647 that ENG-2200 did not fix.
 *
 * ENG-2200 built the enroll tool the customer could not find. This finds the
 * FILE: a workbook Rockhopper has never seen, in the user's own OneDrive or
 * SharePoint, confirmed with them before anything is written.
 *
 * Three things here are load-bearing and none is obvious from the happy path:
 *
 * 1. **The search set IS the permission trim.** Every candidate came back from
 *    a delegated Microsoft call made as this user. Nothing is added to it,
 *    nothing is inferred into it, and no file outside it is ever offered.
 * 2. **A confirmation resolves against a SIGNED set, never against what the
 *    client asserts.** The confirmation carries a position plus the candidate
 *    set this search returned, sealed under an HMAC keyed on the session's own
 *    credential and verified fail-closed on the way back. A model that has
 *    read a hostile file name cannot conjure a `driveMsId` and have the tool
 *    bless it — it would have to forge a signature.
 *
 *    ENG-2816: this was a per-server `Map` until 2026-08-19, and over the
 *    gateway it never resolved a single confirmation. A confirmation is a
 *    SECOND request; the gateway builds a fresh server per request across two
 *    production replicas, so the Map holding the answer was gone before the
 *    answer arrived. Server memory is the wrong carrier for a stateless
 *    server, and signing is what keeps the property the Map was there for.
 * 3. **The budget is claimed BEFORE the network call.** A cap that discards an
 *    answer already fetched has not capped anything — the enumeration already
 *    happened, and Microsoft already answered it.
 */
export function registerDriveSearchTool(
  server: McpServer,
  api: ApiClient,
  session?: { budget?: SearchBudget },
): void {
  // Per-server, never per-module: two servers in one process (a test file, a
  // gateway serving two sessions) must not share a ceiling, and a module-level
  // counter is exactly the shape that silently does.
  const budget = session?.budget ?? new SearchBudget();
  const confirmations = createConfirmationCodec(api);

  /**
   * The candidate set a confirmation is echoing back, or `null`.
   *
   * ENG-2816 — this used to be a lookup in a per-server `Map`, which is why
   * no confirmation over the gateway ever resolved: the second request runs
   * on a server built after the first one was torn down. The set now rides
   * the round trip signed, and `verify` is the fail-closed gate — a bad
   * signature, an expired state and a malformed one all answer `null`, which
   * the callers treat exactly as they treated an unknown nonce.
   */
  async function offered(
    state: string | null,
    ctx: ServerContext | undefined,
  ): Promise<readonly Candidate[] | null> {
    if (!state) return null;
    try {
      return await confirmations.verify(state, ctx as ServerContext);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a position against the set the confirmation carried.
   *
   * Position, never identifier — the only thing a client can send is a number,
   * and a number that does not index the verified set resolves to nothing.
   * `0` and the elicitation form's "none of these" are the same answer: the
   * user was asked and chose no file.
   */
  function resolvePick(
    candidates: readonly Candidate[] | null,
    choice: string | number,
  ) {
    if (choice === DECLINE_CHOICE || choice === 0) return declinedAnswer();
    if (!candidates) return unknownCandidateAnswer();
    const position = typeof choice === 'number' ? choice : Number(choice);
    const candidate = candidateAt(candidates, position - 1);
    return candidate ? confirmedAnswer(candidate) : unknownCandidateAnswer();
  }

  /**
   * Read a filled-in elicitation form.
   *
   * Order matters and it is not the obvious one: a pasted LINK beats a picked
   * row. The link is the user typing the file's own address, which
   * `enroll_file` calls the only input that names one file with no guessing,
   * while a row is a position in a list a search produced. If someone took the
   * trouble to paste an address, that is the file they mean.
   *
   * An EMPTY form is `dismissed`, never `declined`. Nothing is required any
   * more (ENG-2789), so Accept with nothing filled in is a reachable state, and
   * it means the user answered nothing — which is a different fact from "none
   * of these is my file" and leads to a different next move.
   */
  function resolveForm(
    candidates: readonly Candidate[] | null,
    content: unknown,
  ) {
    const filled = content as { choice?: string; link?: string } | undefined;
    const link = usableLink(filled?.link);
    if (link) return linkSuppliedAnswer(link);
    const choice = filled?.choice;
    if (choice === undefined || choice === '') {
      return dismissedAnswer(candidates ?? undefined);
    }
    return resolvePick(candidates, choice);
  }

  /**
   * Put the question through the best lane this request can reach.
   *
   * Lane 2 is awaited INSIDE the call and lane 3 returns out of it; both end
   * at the same three answers, and lane 1 hands the question to the model.
   */
  async function ask(
    ctx: ServerContext | undefined,
    candidates: readonly Candidate[],
  ) {
    const lane = selectLane(ctx, server.server?.getClientCapabilities?.());
    const form = confirmationForm(candidates);

    if (lane === 'input_required') {
      return inputRequired({
        inputRequests: { [CONFIRM_KEY]: inputRequired.elicit(form) },
        requestState: await confirmations.mint(candidates, ctx as ServerContext),
      });
    }

    if (lane === 'elicitation' && ctx?.mcpReq?.elicitInput) {
      try {
        const answer = await ctx.mcpReq.elicitInput({ ...form, mode: 'form' });
        // This lane answers INSIDE the call, so the set is still in scope and
        // nothing has to survive a round trip.
        if (answer?.action === 'accept')
          return resolveForm(candidates, answer.content);
        // Declined or cancelled. Neither is an error — a person is allowed to
        // close a prompt — and neither is `declined` either: the user pressed a
        // button, they did not tell us anything about these ten files. Saying
        // "the user rejected the candidates" here is the ENG-2789 failure, and
        // it is how three unreadable prompts reported themselves as decisions.
        return dismissedAnswer(candidates);
      } catch {
        // The client advertised elicitation and could not deliver it. Falling
        // back to the universal lane keeps the question answerable instead of
        // turning a capability mismatch into a dead end.
      }
    }

    // The universal lane carries the SAME signed state as its `confirm_token`
    // (ENG-2816). It is a second tool call, so it is a second request, and it
    // lost the server-memory set for exactly the reason the modern lane did.
    const token = await confirmations.mint(candidates, ctx as ServerContext);
    return toolResult({
      outcome: 'candidates',
      text: confirmationPrompt(candidates, token),
      detail: { confirmToken: token, candidateCount: candidates.length },
    });
  }

  server.registerTool(
    'search_drive_files',
    {
      title: "Find a File in the User's Microsoft Drive",
      description: DRIVE_SEARCH_DESCRIPTION,
      inputSchema: DRIVE_SEARCH_INPUT_SCHEMA,
      annotations: DRIVE_SEARCH_ANNOTATIONS,
    },
    async (
      { query, scope, limit, confirm_index, confirm_token },
      ctx?: ServerContext,
    ) => {
      // A retried multi-round-trip request arrives with the user's answer
      // embedded. It is checked FIRST and it never searches again: re-running
      // the query on a retry would spend a second unit of budget and could
      // return a different set than the one the user was looking at.
      const embedded = inputResponse(ctx?.mcpReq?.inputResponses, CONFIRM_KEY);
      if (embedded.kind === 'elicit') {
        const answered = await offered(readRequestState(ctx), ctx);
        if (embedded.action !== 'accept') {
          return dismissedAnswer(answered ?? undefined);
        }
        return resolveForm(answered, embedded.content);
      }

      // The universal lane's confirmation: the model relaying a number the
      // user said out loud. Same resolution, same verified candidate set.
      if (confirm_index !== undefined || confirm_token !== undefined) {
        return resolvePick(
          await offered(confirm_token ?? null, ctx),
          confirm_index ?? NaN,
        );
      }

      if (!budget.claim()) {
        log.warn(
          {
            event: 'drive_search_capped',
            searches: budget.spent,
            budget: budget.ceiling,
          },
          'drive_search_capped',
        );
        return toolResult({
          outcome: 'search_limit_reached',
          isError: true,
          text: BUDGET_EXHAUSTED_TEXT,
          detail: { searchesUsed: budget.spent, searchBudget: budget.ceiling },
        });
      }

      let items;
      try {
        const answer = await api.searchDriveFiles({
          q: query,
          scope,
          limit: limit ?? 10,
        });
        items = answer.items;
      } catch (error) {
        // ORDER MATTERS. Both refusals arrive as `NO_DELEGATED_TOKEN`, so
        // checking "not connected" first would swallow the administrator
        // case and hand the user a connect link that Microsoft refuses —
        // which returns them here, with the same link, forever (ENG-2614).
        if (isAdminConsentRequired(error)) {
          return toolResult({
            outcome: 'microsoft_admin_approval_required',
            text: ADMIN_CONSENT_TEXT,
            isError: true,
          });
        }
        if (isNoDelegatedToken(error)) return connectAnswer(api);
        const { outcome, message } = classifyDriveSearchFailure(error);
        return toolResult({ outcome, text: message, isError: true });
      }

      // Mirrors the backend's own discovery log (`[DRIVE-SEARCH]`): the query
      // LENGTH, never its text, and a count, never a name. Enough to tell an
      // empty probe from a real one while reading an incident, and none of the
      // customer's content.
      log.info(
        {
          event: 'drive_search',
          scope: scope ?? 'search',
          queryLength: query?.length ?? 0,
          results: items.length,
          searches: budget.spent,
          budget: budget.ceiling,
        },
        'drive_search',
      );

      if (items.length === 0) {
        // ENG-2792 — branch on the route TAKEN, not on the query. An empty
        // `recent` and a name that matched nothing have different remedies,
        // and one shared string told a caller who had just listed `recent` to
        // list `recent`. Neither message may name the route just taken.
        return toolResult({
          outcome: 'no_matches',
          text: scope === 'recent' ? RECENT_EMPTY_TEXT : NO_MATCHES_TEXT,
        });
      }

      return ask(ctx, items.map(toCandidate));
    },
  );
}

/**
 * The `NO_DELEGATED_TOKEN` answer: a link the BACKEND built.
 *
 * The tool takes no authorize URL, no redirect and no client id, and it never
 * asks the model to compose one. An MCP tool's arguments are chosen by a model
 * reading content it did not author, so a caller-supplied sign-in link is a
 * consent-phishing lever — the user would see a genuine Microsoft consent
 * screen the whole way while approving somebody else's application. Same
 * reasoning as `connect_microsoft`, which is where this link comes from.
 */
async function connectAnswer(api: ApiClient) {
  try {
    const handoff = await api.beginMicrosoftConnect();
    return toolResult({
      outcome: 'microsoft_not_connected',
      text: connectPrompt(handoff.authorizeUrl, handoff.expiresAt),
      detail: { authorizeUrl: handoff.authorizeUrl },
    });
  } catch {
    return toolResult({
      outcome: 'microsoft_not_connected',
      isError: true,
      text:
        'This user has no connected Microsoft account, and Rockhopper could ' +
        'not produce a sign-in link just now. Ask them to run ' +
        '`connect_microsoft`, or to paste the workbook link for `enroll_file`. ' +
        'Do not compose a Microsoft sign-in link yourself.',
    });
  }
}

/** Re-exported so `InputRequiredResult` is nameable where the tool is used. */
export type { InputRequiredResult };
