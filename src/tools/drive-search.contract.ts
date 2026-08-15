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

/** How one candidate reads to a user, without its identifiers. */
export function candidateLabel(candidate: Candidate): string {
  const parts: string[] = [candidate.name];
  if (candidate.parentPath) parts.push(candidate.parentPath);
  if (candidate.lastModifiedAt) {
    parts.push(`modified ${candidate.lastModifiedAt}`);
  }
  parts.push(ENROLLMENT_NOTE[candidate.enrollmentState]);
  return parts.join(' · ');
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
    .map((c, index) => `${index + 1}. **${c.name}** — ${candidateLabel(c)}`)
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

/** The elicitation form both richer lanes send. */
export function confirmationForm(
  candidates: readonly Candidate[],
): Omit<ElicitRequestFormParams, 'mode'> {
  return {
    message:
      'Which workbook did you mean? Rockhopper will not add anything until ' +
      'you pick one.',
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
          enumNames: [
            ...candidates.map((c) => candidateLabel(c)),
            'None of these',
          ],
          title: 'File',
          description: 'The workbook to add to Rockhopper.',
        },
      },
      required: ['choice'],
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
      `The user confirmed "${candidate.name}" (${candidateLabel(candidate)}). ` +
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
      'The user did not pick any of those files, so nothing was added. Ask ' +
      'them to describe the workbook differently and search again, or to ' +
      'paste its SharePoint or OneDrive link for `enroll_file`.',
  });
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
