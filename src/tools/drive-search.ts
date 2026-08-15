import { randomUUID } from 'node:crypto';
import {
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import {
  CandidateRegistry,
  SearchBudget,
  classifyDriveSearchFailure,
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
  confirmationForm,
  confirmationPrompt,
  confirmedAnswer,
  connectPrompt,
  declinedAnswer,
  toolResult,
  unknownCandidateAnswer,
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
 * 2. **A confirmation resolves against SERVER memory, never against what the
 *    client sent.** The confirmation carries a position and a nonce; the file
 *    it names is looked up in the set this session actually returned. A model
 *    that has read a hostile file name cannot conjure a `driveMsId` and have
 *    the tool bless it.
 * 3. **The budget is claimed BEFORE the network call.** A cap that discards an
 *    answer already fetched has not capped anything — the enumeration already
 *    happened, and Microsoft already answered it.
 */
export function registerDriveSearchTool(
  server: McpServer,
  api: ApiClient,
  session?: { budget?: SearchBudget; registry?: CandidateRegistry },
): void {
  // Per-server, never per-module: two servers in one process (a test file, a
  // gateway serving two sessions) must not share a ceiling, and a module-level
  // counter is exactly the shape that silently does.
  const budget = session?.budget ?? new SearchBudget();
  const registry = session?.registry ?? new CandidateRegistry();

  /**
   * Resolve a (nonce, position) pair against what this session offered.
   *
   * Position, never identifier — the only thing a client can send is a number,
   * and a number that does not index a set this session returned resolves to
   * nothing. `0` and the elicitation form's "none of these" are the same
   * answer: the user was asked and chose no file.
   */
  function resolvePick(nonce: string | null, choice: string | number) {
    if (choice === DECLINE_CHOICE || choice === 0) return declinedAnswer();
    if (!nonce) return unknownCandidateAnswer();
    const position = typeof choice === 'number' ? choice : Number(choice);
    const candidate = registry.resolve(nonce, position - 1);
    return candidate ? confirmedAnswer(candidate) : unknownCandidateAnswer();
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
    nonce: string,
  ) {
    const lane = selectLane(ctx, server.server?.getClientCapabilities?.());
    const form = confirmationForm(candidates);

    if (lane === 'input_required') {
      return inputRequired({
        inputRequests: { [CONFIRM_KEY]: inputRequired.elicit(form) },
        requestState: nonce,
      });
    }

    if (lane === 'elicitation' && ctx?.mcpReq?.elicitInput) {
      try {
        const answer = await ctx.mcpReq.elicitInput({ ...form, mode: 'form' });
        if (answer?.action === 'accept') {
          const choice = (answer.content as { choice?: string } | undefined)
            ?.choice;
          return resolvePick(nonce, choice ?? DECLINE_CHOICE);
        }
        // Declined or cancelled. Both mean the user did not choose a file, and
        // neither is an error: a person is allowed to say no.
        return declinedAnswer();
      } catch {
        // The client advertised elicitation and could not deliver it. Falling
        // back to the universal lane keeps the question answerable instead of
        // turning a capability mismatch into a dead end.
      }
    }

    return toolResult({
      outcome: 'candidates',
      text: confirmationPrompt(candidates, nonce),
      detail: { confirmToken: nonce, candidateCount: candidates.length },
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
        if (embedded.action !== 'accept') return declinedAnswer();
        const choice = (embedded.content as { choice?: string } | undefined)
          ?.choice;
        return resolvePick(readRequestState(ctx), choice ?? DECLINE_CHOICE);
      }

      // The universal lane's confirmation: the model relaying a number the
      // user said out loud. Same resolution, same server-side lookup.
      if (confirm_index !== undefined || confirm_token !== undefined) {
        return resolvePick(confirm_token ?? null, confirm_index ?? NaN);
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
        return toolResult({
          outcome: 'no_matches',
          text:
            'Microsoft returned no spreadsheets matching that. The search ran ' +
            'and came back empty — it did not fail. Ask the user to try a ' +
            'different part of the name, or call again with scope="recent" ' +
            'to list what they have worked on lately.',
        });
      }

      const candidates = items.map(toCandidate);
      const nonce = randomUUID();
      registry.remember(nonce, candidates);
      return ask(ctx, candidates, nonce);
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
