/**
 * ENG-5410 — "there is nothing that looks" is a different answer from "we
 * looked and found nothing", and `create_version` / `discard_changes` printed
 * the second when they meant the first.
 *
 * Both tools short-circuit on `hasUncommittedChanges` and report *"File X has
 * no uncommitted changes to commit."* Nothing ever SETS that flag for a native
 * Google Doc or a Google Slides deck — there is no add-on for either host, so
 * no producer can write a change row — which makes that sentence a false
 * statement about a file the customer may have just edited, delivered
 * confidently, in the direction that makes them STOP looking. Same class as
 * ENG-1748 one tool over: a plausible zero is the most dangerous thing a tool
 * can return, because unlike a refusal it does not look like a non-answer.
 *
 * ## This is ENG-5073's state, widened — NOT a second vocabulary
 *
 * The backend already grew this exact claim for `POST /file-versions`
 * (`CreateVersionNoOpReason.NO_CHANGE_ROWS_RECORDED`, backend #3041): the third
 * member of a set that already had "we looked and found nothing" and "we tried
 * to look and could not". The MCP tools never reach it, because they refuse on
 * the client side before the request is made. The CLAIM and the SENTENCE below
 * are that reason's, not a new phrasing of one fact — a second hand-written
 * wording is how two surfaces describing one file drift apart.
 *
 * ## The predicate is keyed on `fileType`, and EVERY UNKNOWN ARM ANSWERS TRUE
 *
 * That direction is the whole safety property, and it is ENG-5073's arm for
 * arm. `true` — "this file does record a change-by-change list" — is what this
 * tool did before the predicate existed, so an unrecognised `fileType` (an
 * older backend's value, a hand-built fixture, a type added after this package
 * was published) keeps today's behaviour instead of acquiring a NEW NEGATIVE
 * CLAIM about a file it cannot name. Guessing "not recorded" would put this
 * sentence in front of a customer whose spreadsheet is fully tracked, which is
 * the same false statement pointed the other way.
 *
 * It matters that this package ships to customers on their own upgrade
 * schedule: a stale second copy of a server-side rule refuses work the server
 * would have taken, invisibly (the ENG-2200 lesson, recorded at
 * `api-client.ts!searchDriveFiles`). Answering TRUE on anything unfamiliar is
 * what keeps that failure impossible here.
 *
 * ## Microsoft `.docx` and `.pptx` are deliberately NOT here
 *
 * They have `paragraph-capture` and `presentation-capture` (ENG-4843), so they
 * genuinely set the flag and these tools work for them today. Reading document
 * CATEGORY alone would answer "not recorded" for a `.docx` and re-break what
 * ENG-4843 fixed; reading PROVIDER alone would answer it for a Google Sheet,
 * which has an add-on and a full cell ledger. Nothing here is "Google files are
 * lesser" — the spreadsheet answer is TRUE on both providers. The backend needs
 * two axes to say that; this package gets it from one `fileType` string, which
 * already encodes both.
 */

/**
 * The backend's machine-readable reason, matched by name so the two surfaces
 * are greppable together. Also the first token of the refusal a model sees.
 */
export const NO_CHANGE_ROWS_RECORDED_CODE = 'NO_CHANGE_ROWS_RECORDED';

/**
 * The `fileType` values for which no change-by-change list exists, and never
 * will without a capture lane that does not exist yet (out of scope on
 * ENG-5410, tracked separately).
 *
 * Exhaustive over `EnrolledFileType`'s FALSE arms as of backend `2d5acca3`:
 * the enum's other six members — `microsoft_xlsx`, `microsoft_xlsm`,
 * `microsoft_pptx`, `microsoft_docx`, `gdrive_xlsx`, `gsheet_native` — all
 * record rows. A member added later is unknown here and answers TRUE, per the
 * safety direction above.
 */
const FILE_TYPES_WITHOUT_CHANGE_ROWS: ReadonlySet<string> = new Set([
  'google_doc',
  'google_slides',
]);

/**
 * Does Rockhopper record a change-by-change list for this file, or only its
 * versions and the comparison between two of them?
 *
 * Mirrors the backend's `enrolledFileRecordsChangeRows`, including its unknown
 * arms, so the two cannot disagree about one file.
 */
export function recordsChangeRows(
  fileType: string | null | undefined,
): boolean {
  if (fileType == null) return true;
  return !FILE_TYPES_WITHOUT_CHANGE_ROWS.has(fileType);
}

export interface NoChangeRowsToolResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/** The write this refusal is answering — the only variable part of the copy. */
export type ChangeRowAction = 'commit' | 'discard';

/**
 * The lead clause per action, so the sentence names the write the caller
 * actually attempted rather than a generic one.
 */
const LEAD: Readonly<Record<ChangeRowAction, string>> = {
  commit: 'No new version was created',
  discard: 'Nothing was discarded',
};

/**
 * The tool answer for a write there is no recorded change to make.
 *
 * The customer-facing sentence is ENG-5073's, with only the trailing verb
 * varying by action. What it deliberately does NOT do: name another vendor,
 * describe a capture mechanism or cadence, hedge, or claim a search of the file
 * happened. What it deliberately KEEPS is the statement of what Rockhopper DOES
 * store — that is a commitment the customer is entitled to, and cutting it
 * swings back into the ENG-4533 / ENG-4580 defect of copy that quietly
 * overclaims.
 *
 * The three lines around it are addressed to the CLIENT, not the customer, and
 * are the same three defences `cellHistoryUnavailableToolResult` uses, because
 * one is not enough against a model that wants to be helpful: `isError`, prose
 * that names the wrong inference explicitly, and a JSON object to branch on.
 */
export function noChangeRowsRecordedToolResult(
  fileName: string,
  fileType: string | null | undefined,
  action: ChangeRowAction,
): NoChangeRowsToolResult {
  const payload = {
    status: 'no_change_rows_recorded',
    code: NO_CHANGE_ROWS_RECORDED_CODE,
    fileName,
    fileType: fileType ?? null,
    action,
  };
  return {
    content: [
      {
        type: 'text',
        text:
          `${NO_CHANGE_ROWS_RECORDED_CODE} — this is NOT a finding about the file.\n` +
          `${LEAD[action]}: Rockhopper records this file's versions and the ` +
          `comparison between them, not a change-by-change list, so there is ` +
          `no recorded change here to ${action}.\n` +
          `Do NOT say "${fileName}" is unchanged, has no changes, or is ` +
          `already committed — none of that is known.\n` +
          `Retrying will not change this answer.\n` +
          JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}
