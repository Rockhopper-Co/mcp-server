/**
 * ENG-2823 — one structured line per tool call, for a log an OPERATOR reads.
 *
 * The package already timed every tool call and already knew its name
 * (`installCorrelationScope`). Two things stopped that from being usable
 * telemetry:
 *
 * 1. **The outcome was wrong.** An MCP tool refuses by RETURNING
 *    `{ isError: true }`; it does not throw. Every handler in this package
 *    catches internally and returns that shape, so the catch branch was the
 *    only thing filing anything but `ok` — and a refused enrolment looked
 *    identical in the logs to a successful one. ENG-2816 closed
 *    `search_drive_files` enrolment for four days with a deterministic refusal
 *    on every call, and nothing in CloudWatch could show it.
 *
 * 2. **The line went nowhere collectable.** `logger.ts` writes to a local
 *    rotating file, because stdout IS the stdio transport on a customer's
 *    laptop. That constraint is real and unchanged. Inside an ECS container
 *    the same file is ephemeral disk nothing collects, and the container dies
 *    with it.
 *
 * The sink resolves both without touching the stdio constraint: the FILE line
 * stays exactly where it was, and a host that has somewhere better to put it —
 * the gateway, whose stdout is CloudWatch — supplies a function. The package
 * never chooses a destination.
 *
 * REDACTION — the whole reason this is a typed event and not a free-form
 * object. KI-1350 put JWTs and full SharePoint paths into span descriptions;
 * this is the same surface. The event carries a fixed key set, and every value
 * in it is either a literal from this file or a tool name from our own
 * registration:
 *
 *   - `tool` — our identifier, e.g. `enroll_file`. Never an argument.
 *   - `outcome` — one of three literals.
 *   - `durationMs` — a number.
 *   - `errorName` / `status` — the error's CONSTRUCTOR name and its numeric
 *     HTTP status, on the failure path only.
 *
 * Deliberately absent, and each for a reason rather than by omission:
 * arguments (a query string, a file name, a path, a token all arrive there),
 * result content (cell values), and the error MESSAGE. The message is the
 * tempting one — it is what a human wants — and it is uncontrolled text from
 * an upstream we do not own, which has already been observed carrying a file
 * path. The status code is the diagnostic half of a message with none of the
 * content: 403, 404, 429 and 502 each say what to do next.
 *
 * File names and ids are NOT emitted here even though they are the most useful
 * signal, because this line is per-call and high-volume; the correlation id
 * already stitches a call to the backend's own request log, which records the
 * file under the backend's access controls.
 */

/** Three outcomes, because "did it work" has three answers, not two. */
export type ToolOutcome =
  /** The handler returned a result and did not set `isError`. */
  | 'ok'
  /**
   * The handler returned `isError: true` — a refusal, a scope denial, a
   * not-ready answer. The call WORKED and the answer was no. This is the value
   * that did not exist before, and its absence is the whole defect.
   */
  | 'refused'
  /** The handler threw: a bug, or an upstream that could not be reached. */
  | 'failed';

export interface ToolTelemetryEvent {
  readonly event: 'tool_call';
  readonly tool: string;
  readonly outcome: ToolOutcome;
  readonly durationMs: number;
  /** Failure path only — the error's constructor name, never its message. */
  readonly errorName?: string;
  /** Failure path only — a numeric HTTP status when the error carries one. */
  readonly status?: number;
}

/**
 * Where a host wants tool telemetry to go. Synchronous and returns nothing:
 * a sink that made the caller wait would put a log transport on the latency
 * path of every tool call.
 */
export type ToolTelemetrySink = (event: ToolTelemetryEvent) => void;

/**
 * `isError` off a tool result, without trusting its shape. The SDK types the
 * return as a union with an index signature, and a handler that returns
 * something unexpected must not be reported as a refusal on the strength of a
 * truthy field — only the literal `true` counts.
 */
export function classifyToolResult(result: unknown): ToolOutcome {
  const isError = (result as { isError?: unknown } | null | undefined)?.isError;
  return isError === true ? 'refused' : 'ok';
}

/** The two safe facts an error carries. Neither is its message. */
export function describeError(err: unknown): {
  errorName?: string;
  status?: number;
} {
  const out: { errorName?: string; status?: number } = {};
  if (err instanceof Error) {
    // A subclass that never assigns `this.name` inherits the literal 'Error',
    // which names nothing. Fall through to the constructor in that one case
    // rather than always preferring it: the classes that DO set `name` (the
    // not-ready error, the API client's) mean it deliberately.
    out.errorName =
      err.name === 'Error' ? (err.constructor?.name ?? 'Error') : err.name;
  } else if (err != null) out.errorName = typeof err;
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === 'number') out.status = status;
  return out;
}

/**
 * Hand the event to the sink without ever letting the sink affect the call.
 * A log transport that is down, misconfigured or mid-rotation must not turn a
 * working tool into a failed one — the reverse of what telemetry is for.
 */
export function emitToolTelemetry(
  sink: ToolTelemetrySink | undefined,
  event: ToolTelemetryEvent,
): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Deliberately swallowed, and deliberately not re-logged: the thing that
    // would carry the report is the thing that just failed.
  }
}
