/**
 * Plan 02 ruling 5 (David, 2026-08-04) — STRICT no-partial, on the machine
 * surfaces.
 *
 * The rule David landed is "nothing serves change history until it is
 * complete", and he chose STRICT specifically because THIS server is a
 * consumer: rows leave here for Claude Desktop / Cursor, which get no banner,
 * no colour and no human in the loop, and will narrate whatever arrives as
 * fact. An empty list is the dangerous answer — "there are no changes" is a
 * factual claim, and it is the claim an assistant makes when handed zero rows.
 *
 * So a not-ready answer here is a REFUSAL, not a value: `isError: true`, a
 * shouting marker, an explicit "this is not an empty result", and a JSON
 * object an assistant can branch on. A resource or prompt THROWS for the same
 * reason a tool cannot return rows — a protocol error cannot be summarised as
 * data.
 *
 * Vocabulary is deliberately the backend's, not a second one: the reasons
 * mirror the SP02 `ParsedOutputNotReadyReason` family
 * (`backend/src/common/parsed-output/parsed-output-not-ready.error.ts`), and
 * `isNotReady` matches both the typed error and a wrapper carrying it as
 * `cause`, exactly like the backend's `isParsedOutputNotReady`.
 */

/** Why a change-history answer is being refused. */
export type NotReadyReason =
  /** A commit-diff fold is still rewriting this file's change-log window. */
  | 'change_history_incomplete'
  /** The backend answered 429/503: parsed outputs are still being produced. */
  | 'still_producing'
  /**
   * The completeness probe itself could not answer. Fail CLOSED: under STRICT
   * an unknown completeness state is not permission to serve rows. This is the
   * one reason that is NOT a statement about the file.
   */
  | 'completeness_unknown';

/** Grep marker; also the first token of every refusal an assistant sees. */
export const NOT_READY_MARKER = 'CHANGE_HISTORY_NOT_READY';

/** Poll hint when the backend gave none — mirrors the backend's own default. */
export const DEFAULT_RETRY_AFTER_SECONDS = 15;

export class ChangeHistoryNotReadyError extends Error {
  /** Structural marker, so a wrapper can be recognised without importing. */
  readonly notReady = true as const;
  readonly reason: NotReadyReason;
  readonly retryAfterSeconds: number;
  readonly fileMsId: string | null;

  constructor(ctx: {
    reason: NotReadyReason;
    retryAfterSeconds?: number | null;
    fileMsId?: string | null;
    detail?: string;
  }) {
    super(
      `${NOT_READY_MARKER}: reason=${ctx.reason} ` +
        `retryAfterSeconds=${ctx.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS}` +
        (ctx.detail ? ` — ${ctx.detail}` : '') +
        ' — Rockhopper has not finished computing this change history. ' +
        'This is NOT an empty result: no rows can be served yet, and nothing ' +
        'may be inferred about whether the file changed.',
    );
    this.name = 'ChangeHistoryNotReadyError';
    this.reason = ctx.reason;
    this.retryAfterSeconds =
      ctx.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
    this.fileMsId = ctx.fileMsId ?? null;
  }
}

/** Matches the typed error AND any error carrying one as `cause`. */
export function isNotReady(err: unknown): err is ChangeHistoryNotReadyError {
  if (err instanceof ChangeHistoryNotReadyError) return true;
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof ChangeHistoryNotReadyError;
}

/**
 * HTTP statuses that answer the question DEFINITIVELY. A permanently-refused
 * request is not "still producing", and the two must not share an answer: a
 * probe that 404s (no such file) or 403s (no access) has told us something
 * true, and dressing it up as a capacity signal would send an assistant into a
 * retry loop against a wall. Matched structurally (`err.status`) so this module
 * stays free of an import cycle with the API client.
 */
const DEFINITIVE_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

function isDefinitiveRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' && DEFINITIVE_HTTP_STATUSES.has(status);
}

/** Unwrap to the typed error (accepts the `cause` shape). */
function unwrap(err: unknown): ChangeHistoryNotReadyError {
  if (err instanceof ChangeHistoryNotReadyError) return err;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof ChangeHistoryNotReadyError) return cause;
  return new ChangeHistoryNotReadyError({ reason: 'completeness_unknown' });
}

export interface NotReadyToolResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it so this
   * shape is assignable to a tool handler's return type. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * The tool answer for a refusal. Three defences, because one is not enough
 * against a model that wants to be helpful: `isError`, prose that names the
 * wrong inference explicitly, and a JSON object to branch on.
 */
export function notReadyToolResult(err: unknown): NotReadyToolResult {
  const e = unwrap(err);
  const payload = {
    status: 'not_ready',
    reason: e.reason,
    retryAfterSeconds: e.retryAfterSeconds,
    fileMsId: e.fileMsId,
  };
  return {
    content: [
      {
        type: 'text',
        text:
          `${NOT_READY_MARKER} — this is NOT a result and NOT an empty result.\n` +
          `Rockhopper has not finished computing this file's change history, ` +
          `so no rows can be served.\n` +
          `Do NOT say there are no changes, that nothing changed, or that the ` +
          `history is empty — none of that is known.\n` +
          `Retry in ${e.retryAfterSeconds} seconds.\n` +
          JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}

/** The completeness probe this module needs from the API client. */
export interface CompletenessProbe {
  getFoldStatus(fileMsId: string): Promise<{
    foldPending: boolean;
    foldTargetVersionId: number | null;
  }>;
}

/**
 * Throws {@link ChangeHistoryNotReadyError} unless the file's change history is
 * complete.
 *
 * `foldPending` is the backend's own authoritative queue read
 * (`GET /file-versions/file/:fileMsId/fold-status`, KI-1399) — while it is
 * true a commit-diff fold is queued, retrying or running, and the change-log
 * window is mid-rewrite. That is precisely the incomplete state, and after
 * plan 02's write-path decoupling (David Q3, 2026-08-03: save the version row
 * first, defer the fold) it is the NORMAL state immediately after any write.
 *
 * A probe that cannot answer refuses. The backend's own probe fails OPEN to
 * not-pending on purpose — a UI lock that can hang is worse than a stale row —
 * but that trade does not transfer here: for a machine consumer a wrong
 * "complete" is a fabricated fact, so the client-side default is the opposite.
 */
export async function assertChangeHistoryComplete(
  api: CompletenessProbe,
  fileMsId: string,
): Promise<void> {
  let status: Awaited<ReturnType<CompletenessProbe['getFoldStatus']>>;
  try {
    status = await api.getFoldStatus(fileMsId);
  } catch (err) {
    if (isNotReady(err)) throw unwrap(err);
    // A definitive rejection is the caller's real answer — let it through so
    // the tool reports "not found" / "no access" instead of "retry in 15s".
    if (isDefinitiveRejection(err)) throw err;
    throw new ChangeHistoryNotReadyError({
      reason: 'completeness_unknown',
      fileMsId,
      detail: `fold-status probe failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  if (status.foldPending) {
    throw new ChangeHistoryNotReadyError({
      reason: 'change_history_incomplete',
      fileMsId,
      detail:
        `a commit-diff fold is still pending` +
        (status.foldTargetVersionId == null
          ? ''
          : ` for version ${status.foldTargetVersionId}`),
    });
  }
}
