/**
 * ENG-2204 — everything `search_drive_files` SAYS, split from everything it
 * DOES (`drive-search.ts`), on the seam ENG-2200 cut for `enroll_file`.
 *
 * This half is the only interface a language model ever sees: it cannot read
 * the handler, so the tool description and the schema descriptions ARE the
 * contract, and a wrong word here is a behaviour bug no type checks. Keeping
 * it apart means a person can review it as prose — deciding whether a model
 * would do the right thing — without the lane branching in the way.
 */

import type { ElicitRequestFormParams } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DRIVE_SEARCH_SESSION_BUDGET,
  type Candidate,
  type DriveSearchOutcome,
} from '../drive-search.js';

export const DRIVE_SEARCH_INPUT_SCHEMA = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Part of the file name to look for, in the user\'s own words — "Q3 ' +
        'forecast", "Becklar model". Required unless `scope` is "recent".',
    ),
  scope: z
    .enum(['search', 'recent'])
    .optional()
    .describe(
      '"search" (default) looks across everything the user can reach in ' +
        'OneDrive and SharePoint. "recent" lists the workbooks they have ' +
        'worked on lately and needs no `query` — use it when the user cannot ' +
        'remember the name.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many candidates to return. Default 10, maximum 50.'),
  /**
   * The confirmation lane every client has. `confirm_index` is how a client
   * with no elicitation and no multi-round-trip support closes the loop: the
   * model puts the question to the user in the conversation, and calls again
   * carrying the number the user chose.
   *
   * It is an INDEX into a set this session offered, not a file identifier, and
   * that is the whole point. A model that has read a malicious file name
   * cannot invent a `driveMsId` here and have the tool bless it: the index is
   * resolved against server memory, and an index into a set that was never
   * offered resolves to nothing.
   */
  confirm_index: z
    .number()
    .int()
    .optional()
    .describe(
      'The number of the candidate the USER picked from a previous ' +
        '`search_drive_files` answer, after you asked them which file they ' +
        'meant. Send it together with `confirm_token` from that same answer. ' +
        'Send 0 if they said none of them is the right file. ' +
        'Never guess it and never pick on the user\'s behalf.',
    ),
  confirm_token: z
    .string()
    .optional()
    .describe(
      'The `confirm_token` from the answer whose list the user picked from. ' +
        'Pass it back exactly as it was given.',
    ),
});

export const DRIVE_SEARCH_DESCRIPTION =
  "Find a Microsoft Excel workbook in the user's own OneDrive or SharePoint — " +
  'including files Rockhopper has never seen. Each candidate comes back marked ' +
  'as already in Rockhopper or not. ' +
  'USE THIS when the user names a workbook that `search_files` and ' +
  '`list_files` cannot find: those two see only files already added to ' +
  'Rockhopper, so "no match" there means "never added", not "no such file". ' +
  'YOU MUST CONFIRM THE FILE WITH THE USER before enrolling it. Show them the ' +
  'candidates, ask which one they mean, then call this tool again with their ' +
  'pick as `confirm_index` plus the `confirm_token`; the answer carries the ' +
  'identifiers to hand to `enroll_file`. Never enroll a file the user has not ' +
  'named, and never claim a file is already in Rockhopper because one search ' +
  'result looked similar. ' +
  'Read the outcome rather than assuming: `declined` means the user saw the ' +
  'candidates and rejected them, `dismissed` means the prompt closed with no ' +
  'answer at all — put the list to them yourself and do not search again — ' +
  'and `link_supplied` means they pasted the workbook address, which goes to ' +
  '`enroll_file` as `url` on its own. ' +
  'Searching is capped per session, so search deliberately rather than ' +
  'browsing. Requires a connected Microsoft account — if none is connected, ' +
  'this returns the link the user must open.';

export const DRIVE_SEARCH_ANNOTATIONS = {
  readOnlyHint: true,
  // It reaches SharePoint / OneDrive through Rockhopper.
  openWorldHint: true,
} as const;

/** The machine-readable half of every answer, so a model can branch on it. */
export interface DriveSearchAnswer {
  outcome: DriveSearchOutcome;
  text: string;
  isError?: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Render an answer as a tool result: prose for the human, then one JSON line
 * for the model. Both, because prose alone invites the model to paraphrase a
 * refusal into a success, and JSON alone gives the user nothing to read.
 * Same shape as `enroll_file`'s, so the two tools read alike in a transcript.
 */
export function toolResult(answer: DriveSearchAnswer) {
  const payload = { outcome: answer.outcome, ...(answer.detail ?? {}) };
  return {
    content: [
      {
        type: 'text' as const,
        text: `${answer.text}\n${JSON.stringify(payload)}`,
      },
    ],
    ...(answer.isError ? { isError: true as const } : {}),
  };
}

/**
 * How one candidate reads to a user, without its identifiers.
 *
 * ENG-2787 — the enrolment marking comes FIRST, and that ordering is the whole
 * fix. The flag was already on the wire; the client truncated it off the END of
 * the row, so ten candidates rendered as
 * `RE_Forecast.xlsx · /drives/b!YmtA8jQX3OSHJRQ88O…` and the tool
 * description's promise that "each candidate comes back marked as already in
 * Rockhopper or not" was true of the payload and false of the screen. A marking
 * whose position depends on the length of a customer's file name is not
 * visible; one at position zero always is.
 *
 * `lastModifiedAt` and `parentPath` are dropped for the same reason they did
 * harm: an ISO timestamp and a raw `/drives/b!…` id are forty characters
 * nobody can read, sitting in front of the one phrase that decides whether
 * this row is worth picking. Both still appear in the prompt's own message,
 * which wraps instead of truncating.
 */
export function candidateLabel(candidate: Candidate): string {
  return `${ENROLLMENT_NOTE[candidate.enrollmentState]} · ${candidate.name}`;
}

/**
 * The same facts MINUS the name, for the places that print the name already.
 *
 * A picker row has to stand alone, so {@link candidateLabel} repeats the name;
 * prose that has just written `**Becklar_RMR_Model.xlsx**` has not.
 */
function candidateNote(candidate: Candidate): string {
  return [ENROLLMENT_NOTE[candidate.enrollmentState]]
    .concat(candidate.parentPath ?? [])
    .join(' · ');
}

/**
 * What each enrolment state MEANS to the person choosing, in their words.
 *
 * `hidden` is spelled out rather than folded into "already added" because the
 * two lead to different conversations: one is done, and the other needs the
 * user to say whether they want a file they removed put back. Collapsing them
 * is the ENG-1647 answer — "already enrolled" about a file the user cannot see.
 */
const ENROLLMENT_NOTE: Record<Candidate['enrollmentState'], string> = {
  enrolled: 'already in Rockhopper',
  hidden: 'previously removed from Rockhopper',
  not_enrolled: 'not in Rockhopper yet',
};

/** The numbered list the user picks from, and the model quotes back. */
export function renderCandidates(candidates: readonly Candidate[]): string {
  return candidates
    .map((c, index) => `${index + 1}. **${c.name}** — ${candidateNote(c)}`)
    .join('\n');
}

/** The question the model puts to the user when no richer lane exists. */
export function confirmationPrompt(
  candidates: readonly Candidate[],
  token: string,
): string {
  return (
    `Found ${candidates.length} possible file(s). ` +
    'DO NOT enroll any of these yet.\n\n' +
    `${renderCandidates(candidates)}\n\n` +
    'Ask the user which one they meant — quote the names, do not choose for ' +
    'them. When they answer, call `search_drive_files` again with ' +
    `confirm_index: <their number> and confirm_token: "${token}", or ` +
    'confirm_index: 0 if none of these is the file.'
  );
}

/**
 * What the user READS before they touch anything (ENG-2789).
 *
 * The candidates are written into the message because the message is the only
 * part of an elicitation this client renders unprompted. The prompt David
 * photographed on 2026-08-19 showed exactly two things on screen — this
 * sentence, and a field collapsed to the words `not set` — while ten workbooks
 * sat behind a `→` documented in a footnote under the buttons. Three
 * consecutive real attempts returned `declined` from a prompt whose options
 * were never on screen.
 *
 * So the list is prose now, and the field is a way to answer a question the
 * user has already read rather than the only place the question exists.
 */
function pickerMessage(candidates: readonly Candidate[]): string {
  return (
    `Which of these ${candidates.length} workbooks did you mean? ` +
    'Rockhopper will not add anything until you say.\n\n' +
    `${renderCandidates(candidates)}\n\n` +
    'Pick one by number in the File field below.\n\n' +
    'If none of them is the right file, you can paste the workbook\'s own ' +
    'link instead: open it in your browser and copy the address from the bar ' +
    'into the Link field. That names the file exactly, so nothing has to be ' +
    'guessed from its name.'
  );
}

/**
 * The elicitation form both richer lanes send.
 *
 * NOTHING IS REQUIRED, and that is deliberate (ENG-2789). A required `choice`
 * is what turned an unreadable prompt into a trap: the only visible buttons
 * were Accept and Decline, and Accept was REFUSED because the invisible field
 * was unset, leaving Decline as the sole affordance that did anything. An
 * unanswered form now comes back as `dismissed` — a state the tool can name
 * and act on — instead of a button the user is herded into pressing.
 */
export function confirmationForm(
  candidates: readonly Candidate[],
): Omit<ElicitRequestFormParams, 'mode'> {
  return {
    message: pickerMessage(candidates),
    requestedSchema: {
      type: 'object',
      properties: {
        // The values are POSITIONS, never identifiers. A client (or anything
        // steering it) can only send back a number, and a number that does not
        // index a set this session offered resolves to nothing.
        choice: {
          type: 'string',
          enum: [
            ...candidates.map((_, index) => String(index + 1)),
            DECLINE_CHOICE,
          ],
          // Numbered so a row the client truncates is still resolvable
          // against the list in the message above it.
          enumNames: [
            ...candidates.map((c, index) => `${index + 1}. ${candidateLabel(c)}`),
            'None of these',
          ],
          title: 'File',
          description: 'The workbook to add to Rockhopper.',
        },
        // ENG-2784. The link route used to be spoken only to the MODEL, in the
        // text returned after the user had already given up: whether they ever
        // heard it depended on the assistant choosing to relay it. A recovery
        // path that needs the agent to speak IS the defect, so it is a field on
        // the prompt the user is already looking at.
        link: {
          type: 'string',
          title: 'Link',
          description:
            'Or paste the workbook\'s address here — open it in your browser ' +
            'and copy the address from the bar.',
        },
      },
    },
  };
}

/** The answer that means "none of these" rather than a position. */
export const DECLINE_CHOICE = 'none';

/**
 * The answer once a specific candidate has been confirmed by a human.
 *
 * It hands over identifiers and stops. Enrolling here would mean a second copy
 * of `enroll_file`'s logic — the share_with question, the hidden-file restore
 * — living in a read tool, and two copies of a rule is how the two answers
 * start to differ.
 */
export function confirmedAnswer(candidate: Candidate) {
  if (!candidate.driveMsId) {
    return toolResult({
      outcome: 'unknown_candidate',
      isError: true,
      text:
        `Microsoft did not say which drive "${candidate.name}" lives in, so ` +
        'it cannot be added from the search result. Ask the user to open the ' +
        'workbook and paste the address from their browser bar, then call ' +
        '`enroll_file` with that `url`.',
    });
  }
  return toolResult({
    outcome: 'confirmed',
    text:
      `The user confirmed "${candidate.name}" (${candidateNote(candidate)}). ` +
      'Now call `enroll_file` with the `driveMsId` and `msId` below. ' +
      '`enroll_file` will ask who may see the file — put that question to the ' +
      'user too, and never answer it yourself.',
    detail: {
      name: candidate.name,
      driveMsId: candidate.driveMsId,
      msId: candidate.msId,
      enrollmentState: candidate.enrollmentState,
    },
  });
}

/** The answer when the user was asked and said none of these. */
export function declinedAnswer() {
  return toolResult({
    outcome: 'declined',
    text:
      'The user looked at the candidates and said none of them is the file, ' +
      'so nothing was added. Ask them to describe the workbook differently ' +
      'and search again, or to paste its SharePoint or OneDrive link for ' +
      '`enroll_file`.',
  });
}

/**
 * The answer when the prompt closed without the user answering it (ENG-2789).
 *
 * Its own outcome and not a flavour of `declined`, because the two say opposite
 * things about what the user knows. `declined` means they read ten workbooks
 * and none was theirs — searching again with a different word is the right next
 * move. This means they never told us anything, and the honest next move is to
 * put the same list to them in the conversation, where it cannot be collapsed.
 * Folding them together is what let three unreadable prompts report themselves
 * as a decision the user had made.
 */
export function dismissedAnswer(candidates?: readonly Candidate[]) {
  const list = candidates?.length
    ? `\n\n${renderCandidates(candidates)}\n\n`
    : ' ';
  return toolResult({
    outcome: 'dismissed',
    text:
      'The user closed the file picker without answering it, so nothing was ' +
      'added and they have told us nothing about which file they meant. Do ' +
      'NOT treat this as a rejection and do not search again yet.' +
      list +
      'List these candidates in the conversation, ask which one they meant, ' +
      'and say they can paste the workbook\'s OneDrive or SharePoint link ' +
      'instead if none is right.',
  });
}

/**
 * The answer when the user pasted a link rather than picking a row (ENG-2784).
 *
 * The URL is the user's own typing, from a field only they can fill — it is
 * not a model-chosen argument, and it is handed straight to `enroll_file`,
 * which is the tool that resolves and validates it. Nothing here tries to
 * parse it: `enroll_file`'s own description calls a pasted address "the only
 * input that names one specific file with no guessing", and re-deriving that
 * judgement in a second place is how two answers start to differ.
 */
export function linkSuppliedAnswer(url: string) {
  return toolResult({
    outcome: 'link_supplied',
    text:
      'The user did not pick from the list. They pasted the workbook\'s own ' +
      'address instead, which names the file exactly. Call `enroll_file` with ' +
      'the `url` below and nothing else — no `driveMsId`, no `msId`. ' +
      '`enroll_file` will ask who may see the file; put that question to the ' +
      'user too, and never answer it yourself.',
    detail: { url },
  });
}

/**
 * A pasted value this tool will pass on, or `null`.
 *
 * The only check is that it is an http(s) address, and it exists so an empty
 * box or a stray keystroke does not get announced to the model as "the user
 * gave us the file". Anything further — which tenant, which drive, whether the
 * file exists — is `enroll_file`'s to decide against Microsoft, not this
 * tool's to guess from a string.
 */
export function usableLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'https:' || protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}

/** The answer when a confirmation names something this session never offered. */
export function unknownCandidateAnswer() {
  return toolResult({
    outcome: 'unknown_candidate',
    isError: true,
    text:
      'That pick does not match any file this search offered, so nothing was ' +
      'added. Run `search_drive_files` again and confirm against the list it ' +
      'returns. Never enroll a file that did not come back from a search.',
  });
}

/** Told to the model when the session has searched as much as it may. */
export const BUDGET_EXHAUSTED_TEXT =
  `This session has used all ${DRIVE_SEARCH_SESSION_BUDGET} of its file ` +
  'searches. This is a fixed limit and waiting does not restore it. Stop ' +
  "searching and ask the user to paste the workbook's SharePoint or OneDrive " +
  'link, then call `enroll_file` with that link. Nothing was searched.';

/** Told to the model when the user has no delegated Microsoft grant. */
export function connectPrompt(authorizeUrl: string, expiresAt: string): string {
  return (
    'Rockhopper cannot look at this user\'s Microsoft files until they ' +
    'connect their Microsoft account. Give them this link to open ' +
    `themselves — it expires at ${expiresAt}:\n\n${authorizeUrl}\n\n` +
    'Rockhopper asks only to READ their files. Once they have approved, call ' +
    '`microsoft_link_status` to confirm, then search again. Do not compose a ' +
    'sign-in link yourself; this one is the only valid one.'
  );
}
