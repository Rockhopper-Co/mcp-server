import { z } from 'zod';
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  isDefinitiveRejection,
  type CompletenessProbe,
} from './not-ready.js';

/**
 * ENG-7243 — "is the history I am about to print complete?", for the two
 * `get_cell_history` arms.
 *
 * Ledger reads never refuse (R1, David 2026-10-08) and a capable assistant
 * client gets the rows the ledger holds under an UPDATING marker (assistants
 * option 2, same night). The backend tells the two client generations apart by
 * {@link CLIENT_CAPABILITIES_HEADER} (backend
 * `cell-history-pair-coverage.ts!sendsClientCapabilities`, any non-empty
 * value): without it a not-`current` read keeps the strict 503; with it the
 * read serves rows plus {@link LEDGER_FRESHNESS_HEADER}, which the backend sets
 * ONLY when the answer is not `current`
 * (`cell-history-pair-coverage.ts!setLedgerFreshnessHeader`).
 *
 * Two states only — `current` or `updating` (David, 2026-10-09). There is no
 * third "could not check" state here either: anything this module cannot read
 * resolves to `updating`, never to `current`, because a wrong "complete" is
 * the fabricated fact this surface exists to avoid.
 */

/** The request header a capable mcp-server sends on cell-history reads. */
export const CLIENT_CAPABILITIES_HEADER = 'X-Rockhopper-Client-Capabilities';
/** What this server announces: it reads {@link LEDGER_FRESHNESS_HEADER}. */
export const CLIENT_CAPABILITIES_VALUE = 'ledger-freshness';
/** Backend `dto/ledger-read-envelope.ts!LEDGER_FRESHNESS_HEADER`. */
export const LEDGER_FRESHNESS_HEADER = 'X-Ledger-Freshness';

/** The wire answer, as far as this client reads it (backend `LedgerFreshness`). */
export const LedgerFreshnessWireSchema = z
  .object({ state: z.enum(['current', 'updating']) })
  .passthrough();

export interface ReadFreshness {
  state: 'current' | 'updating';
  /** Poll hint: the response's `Retry-After`, else the shared default. */
  retryAfterSeconds: number;
}

export const CURRENT: ReadFreshness = {
  state: 'current',
  retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
};

function retryAfter(headers: { get(name: string): string | null }): number {
  const seconds = Number.parseInt(headers.get('Retry-After') ?? '', 10);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * The freshness a cell-history response states. An absent header is
 * `current` (the backend's contract); a present header that does not parse as
 * `current` is `updating` — the backend only writes it when not current.
 */
export function freshnessFromHeaders(
  headers: { get(name: string): string | null } | undefined,
): ReadFreshness {
  const raw = headers?.get(LEDGER_FRESHNESS_HEADER);
  if (!raw) return CURRENT;
  let state: ReadFreshness['state'] = 'updating';
  try {
    const parsed = LedgerFreshnessWireSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.state === 'current') state = 'current';
  } catch {
    // Unparseable: the header's presence already says "not current".
    state = 'updating';
  }
  return { state, retryAfterSeconds: retryAfter(headers!) };
}

/** Either source saying `updating` wins; `current` needs both. */
export function mergeFreshness(
  a: ReadFreshness,
  b: ReadFreshness,
): ReadFreshness {
  if (a.state === 'updating') return a;
  return b;
}

/**
 * The commit-diff fold probe as a freshness INPUT, never a refusal. A pending
 * fold means the change-log window is mid-rewrite, so the rows are partial:
 * `updating`. A probe that cannot answer is `updating` too. A DEFINITIVE
 * rejection (no such file, no access) is the caller's real answer and is
 * rethrown, as `not-ready.ts!assertChangeHistoryComplete` does.
 */
export async function foldFreshness(
  api: CompletenessProbe,
  fileMsId: string,
): Promise<ReadFreshness> {
  try {
    const status = await api.getFoldStatus(fileMsId);
    return status.foldPending ? { ...CURRENT, state: 'updating' } : CURRENT;
  } catch (err) {
    if (isDefinitiveRejection(err)) throw err;
    const seconds = (err as { retryAfterSeconds?: unknown } | null)
      ?.retryAfterSeconds;
    const fromCause = (err as { cause?: { retryAfterSeconds?: unknown } } | null)
      ?.cause?.retryAfterSeconds;
    const hint = [seconds, fromCause].find(
      (s): s is number => typeof s === 'number' && s > 0,
    );
    return {
      state: 'updating',
      retryAfterSeconds: hint ?? DEFAULT_RETRY_AFTER_SECONDS,
    };
  }
}

/**
 * The line an updating answer OPENS with. `count` rows are printed below it;
 * an empty updating answer says so in the same line rather than as a zero.
 */
export function updatingLine(count: number, retryAfterSeconds: number): string {
  const listed =
    count > 0
      ? `${count} change(s) so far are listed below; more may appear.`
      : 'No change is recorded here so far; more may appear.';
  return (
    'UPDATING — incomplete: Rockhopper is still recording changes to this ' +
    `file. ${listed} Retry in ${retryAfterSeconds} s. Do not report this as ` +
    'the complete history.'
  );
}
