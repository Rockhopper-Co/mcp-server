/**
 * ENG-1748 — "this source cannot answer for this file" is a different answer
 * from "this cell has no history", and the tool used to print the second when
 * it meant the first: the backend served `[]` with HTTP 200 for a file whose
 * history it could not see, and an assistant reported "this cell never changed"
 * to a customer as fact. A plausible zero is the most dangerous thing a tool can
 * return, because — unlike a refusal — it does not look like a non-answer.
 *
 * The discriminator is NOT the empty array. The backend now refuses such a read
 * outright with `422` and the machine-readable `CELL_HISTORY_UNAVAILABLE` code;
 * this module recognises that code and renders it as a refusal. A zero-length
 * result that arrives with HTTP 200 is still a real, trustworthy zero and is
 * still rendered as one.
 *
 * Deliberately NOT part of `not-ready.ts`: that vocabulary is "come back
 * later", and every field of its payload (`retryAfterSeconds`) is wrong here.
 * Retrying cannot make this file's history reconstructible.
 */

/** The backend's refusal code, matched structurally so no import cycle forms. */
export const CELL_HISTORY_UNAVAILABLE_CODE = 'CELL_HISTORY_UNAVAILABLE';

/** Grep marker; also the first token of the refusal an assistant sees. */
export const UNAVAILABLE_MARKER = CELL_HISTORY_UNAVAILABLE_CODE;

/** Matches the backend's coded refusal, and any error carrying one as `cause`. */
export function isCellHistoryUnavailable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === CELL_HISTORY_UNAVAILABLE_CODE) return true;
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)
    ?.cause;
  return cause?.code === CELL_HISTORY_UNAVAILABLE_CODE;
}

export interface UnavailableToolResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * The tool answer for an unanswerable read. Three defences, the same three
 * `notReadyToolResult` uses, because one is not enough against a model that
 * wants to be helpful: `isError`, prose that names the wrong inference
 * explicitly, and a JSON object to branch on.
 */
export function cellHistoryUnavailableToolResult(
  cell: string,
  sheetName: string,
): UnavailableToolResult {
  const payload = {
    status: 'unavailable',
    code: CELL_HISTORY_UNAVAILABLE_CODE,
    cell,
    sheetName,
  };
  return {
    content: [
      {
        type: 'text',
        text:
          `${UNAVAILABLE_MARKER} — this is NOT a result and NOT an empty result.\n` +
          `Rockhopper cannot report the change history of ${cell} on ` +
          `"${sheetName}" for this file.\n` +
          `Do NOT say the cell has no history, that nothing changed, or that ` +
          `the history is empty — none of that is known.\n` +
          `Retrying will not change this answer.\n` +
          JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}
