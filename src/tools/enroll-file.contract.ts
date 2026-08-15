/**
 * ENG-2200 — everything `enroll_file` SAYS, split from everything it DOES
 * (`enroll-file.ts`).
 *
 * The seam is not arbitrary. This half is the only interface a language model
 * ever sees: it cannot read the handler, so the schema descriptions and the
 * tool description ARE the contract, and a wrong word here is a behaviour bug
 * that no type checks. Keeping it apart means it can be reviewed as prose —
 * and read by a person deciding whether a model would do the right thing —
 * without the branch logic in the way.
 */

import { z } from 'zod';
import type { EnrollOutcome } from '../enrollment.js';

export const ENROLL_INPUT_SCHEMA = z.object({
  url: z
    .string()
    .optional()
    .describe(
      "The workbook's SharePoint or OneDrive address, exactly as copied from " +
        'the browser bar. Use this whenever the user can paste a link — it is ' +
        'the only input that names one specific file with no guessing.',
    ),
  driveMsId: z
    .string()
    .optional()
    .describe(
      'Microsoft drive id. Only for a file already identified by another tool; ' +
        'must be sent together with `msId`, and never alongside `url`.',
    ),
  msId: z
    .string()
    .optional()
    .describe(
      'Microsoft drive-item id. Must be sent together with `driveMsId`, and ' +
        'never alongside `url`.',
    ),
  /**
   * Optional in the SCHEMA and required by the HANDLER, deliberately.
   *
   * A required field turns an omission into a protocol-level validation error,
   * and the model then sees a rejection instead of the question it is supposed
   * to put to the user. D5/D6 say ask every time, so the tool answers an
   * omission with the question. What it must never do is pick a value:
   * enrolling privately when the user meant "my team" is invisible until
   * somebody cannot find the file.
   */
  share_with: z
    .enum(['me', 'team'])
    .optional()
    .describe(
      'REQUIRED. Who may see this file: "me" (just the user) or "team" ' +
        '(everyone on their team). ASK THE USER every time and use their ' +
        'answer — never assume, never carry an answer over from an earlier ' +
        'file. Omitting it does not enroll anything; the tool returns the ' +
        'question to put to them.',
    ),
  confirm_restore: z
    .boolean()
    .optional()
    .describe(
      'Set to true only after the user has confirmed they want a file they ' +
        'previously removed to be restored. Ignored otherwise.',
    ),
});

export const ENROLL_DESCRIPTION =
  'Add a Microsoft Excel workbook to Rockhopper so it can be versioned, ' +
  "reviewed and tracked. Takes the file's SharePoint or OneDrive link (best), " +
  'or a `driveMsId` + `msId` pair. ' +
  'MICROSOFT ONLY — Google Sheets and Drive links are refused. ' +
  'You MUST ask the user who may see the file and pass their answer as ' +
  '`share_with` ("me" or "team"); calling without it returns the question ' +
  'instead of enrolling. ' +
  'If the file was previously removed from Rockhopper, this reports ' +
  '`restore_confirmation_required` and changes nothing — ask the user, then ' +
  'call again with `confirm_restore: true`. ' +
  'Safe to call again if you lose the answer: a file that is already there ' +
  'reports `already_enrolled` and is not duplicated. ' +
  'Use this whenever `search_files` or `list_files` cannot find a file the ' +
  'user is asking about — a file Rockhopper does not know about is not a ' +
  'missing file, it is an un-enrolled one. ' +
  // ENG-2204: the `driveMsId` + `msId` pair has one honest source, and naming
  // it here is what keeps a model from assembling a pair out of ids it read
  // somewhere else and enrolling a file the user never named.
  'If the user cannot produce a link, call `search_drive_files` first, have ' +
  'them confirm which candidate they meant, and pass the `driveMsId` + `msId` ' +
  'that confirmation returned. Never enroll a file the user has not named.';

export const ENROLL_ANNOTATIONS = {
  readOnlyHint: false,
  // Enrolling adds a file; it never removes or overwrites one, and a repeat
  // call on an already-enrolled file changes nothing.
  destructiveHint: false,
  idempotentHint: true,
  // It reaches SharePoint / OneDrive through Rockhopper.
  openWorldHint: true,
} as const;

/** The question the model puts to the user when `share_with` was omitted. */
export const SHARE_QUESTION =
  'Before this file can be added, ask the user: "Should this workbook be ' +
  'visible to just you, or to your whole team?" Then call `enroll_file` again ' +
  'with share_with="me" or share_with="team". Nothing has been added yet.';

/** The machine-readable half of every answer, so a model can branch on it. */
export interface EnrollAnswer {
  outcome: EnrollOutcome;
  text: string;
  isError?: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Render an answer as a tool result: prose for the human, then one JSON line
 * for the model. Both, because prose alone invites the model to paraphrase a
 * refusal into a success, and JSON alone gives the user nothing to read.
 */
export function toolResult(answer: EnrollAnswer) {
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
