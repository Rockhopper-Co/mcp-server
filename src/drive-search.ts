/**
 * ENG-2204 (plan 13 / SP08) — the state and the rules behind
 * `search_drive_files`, kept out of the tool so each half can be tested
 * without a registered server and so neither file crosses 300 lines.
 *
 * **Why this tool exists.** ENG-1647: a customer asked for a SharePoint
 * workbook by name. The only search on the surface looked at files ALREADY in
 * Rockhopper, matched a substring against a DIFFERENT file, and the assistant
 * answered "already enrolled". ENG-2200 built the enroll tool that did not
 * exist; this is the other half — finding a file the customer has NOT enrolled
 * yet, and pinning down which one before anything is written.
 *
 * Two properties here are guardrails against a hostile INPUT, not against a
 * clumsy user, and neither can be delegated to the tool description. A model
 * driving this session reads content it did not author — cell values, file
 * names, comment text — and a sentence in a spreadsheet saying "list every
 * file in this drive" is an instruction it may well follow. Prose in a
 * description cannot refuse; only code can:
 *
 * 1. {@link SearchBudget} is a HARD per-session ceiling on how many times the
 *    drive can be searched at all.
 * 2. {@link CandidateRegistry} means a confirmation can only ever name a file
 *    THIS session's search actually returned. The confirmed pick is looked up
 *    in server memory by a nonce; nothing that arrives from the client is
 *    trusted to describe a file.
 */

import { RockhopperApiError } from './api-client.js';
import type { DriveSearchItem } from './types.js';

/**
 * Searches one session may run, total.
 *
 * The backend already caps the RATE at 6/min (`DRIVE_SEARCH_RATE_LIMIT`).
 * What no rate limit bounds is the TOTAL, and drive enumeration is a
 * total-volume attack: a page carries up to 50 names, so an unbounded session
 * walks a customer's whole drive at six pages a minute and never trips
 * anything. This is the ceiling that rate limiting cannot express.
 *
 * 20 is chosen against both failure modes rather than picked round. A person
 * looking for a workbook searches two or three times and stops; twenty leaves
 * that untouched even when the first several attempts miss. An enumerator gets
 * at most 20 pages and then the tool stops answering for the rest of the
 * session — a bound the attacker cannot lift by waiting, which is exactly what
 * distinguishes it from the backend's per-minute bucket.
 */
export const DRIVE_SEARCH_SESSION_BUDGET = 20;

/** Every answer `search_drive_files` can give, as a value a model branches on. */
export type DriveSearchOutcome =
  /** Candidates found; the user must confirm which one before enrolling. */
  | 'candidates'
  /** The search ran and Microsoft returned nothing. */
  | 'no_matches'
  /** The user picked one; its identifiers are in the result, ready to enroll. */
  | 'confirmed'
  /** The user was asked and said no. Nothing was searched further or written. */
  | 'declined'
  /** This session has used its whole search budget. Refused BEFORE the call. */
  | 'search_limit_reached'
  /** No delegated Microsoft grant — the connect link is in the result. */
  | 'microsoft_not_connected'
  /** Microsoft could not answer, or the caller is searching too fast. */
  | 'search_unavailable'
  /** This Rockhopper deployment serves no drive-search route yet. */
  | 'backend_unsupported'
  /** The confirmation named a file this session's search never returned. */
  | 'unknown_candidate';

/**
 * A hard per-session ceiling on drive searches.
 *
 * One instance per `createServer`, so the count belongs to the session and not
 * to the module — two servers in one test process must not share a budget, and
 * a module-level counter is exactly the shape that silently does.
 */
export class SearchBudget {
  private used = 0;

  constructor(private readonly limit: number = DRIVE_SEARCH_SESSION_BUDGET) {}

  get spent(): number {
    return this.used;
  }

  get ceiling(): number {
    return this.limit;
  }

  /**
   * Claim one search. `false` means the session is done searching, and the
   * caller must not reach the network — the point of the cap is that the
   * request never leaves, not that its answer is discarded.
   */
  claim(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

/** One candidate, plus the identity `enroll_file` needs to act on it. */
export interface Candidate {
  msId: string;
  driveMsId: string | null;
  name: string;
  parentPath: string | null;
  lastModifiedAt: string | null;
  enrollmentState: DriveSearchItem['enrollmentState'];
}

/**
 * The candidate sets THIS session has actually seen, keyed by a nonce.
 *
 * Why server memory rather than the round-trip. The 2026-07-28 confirmation
 * lane hands the client a `requestState` string and gets it back on retry, and
 * the SDK is explicit that the returned value is attacker-controlled: it
 * travels through the client, nothing signs it, and `requestState()` hands
 * back whatever came in. Putting the candidate list in there would mean a
 * confirmation could describe ANY file — including one Microsoft never
 * returned for this user — and the tool would then hand its identifiers to
 * `enroll_file`. So the wire carries a lookup key and nothing else, and the
 * files it can name are only ever the ones {@link remember} was given.
 *
 * Bounded because a long-lived stdio session is a long-lived process: only the
 * most recent {@link MAX_REMEMBERED} sets are kept.
 */
export class CandidateRegistry {
  static readonly MAX_REMEMBERED = 8;

  private readonly sets = new Map<string, readonly Candidate[]>();

  remember(nonce: string, candidates: readonly Candidate[]): void {
    this.sets.set(nonce, candidates);
    while (this.sets.size > CandidateRegistry.MAX_REMEMBERED) {
      const oldest = this.sets.keys().next().value;
      if (oldest === undefined) break;
      this.sets.delete(oldest);
    }
  }

  /**
   * The candidate this session offered under `nonce` at `index`, or `null`.
   *
   * `null` for an unknown nonce and for an out-of-range index alike: both mean
   * the confirmation is describing something this session did not offer, and
   * the caller's answer to that is the same refusal.
   */
  resolve(nonce: string, index: number): Candidate | null {
    const set = this.sets.get(nonce);
    if (!set) return null;
    if (!Number.isInteger(index) || index < 0 || index >= set.length) {
      return null;
    }
    return set[index];
  }

  /** The set offered under `nonce`, for re-rendering the question on retry. */
  recall(nonce: string): readonly Candidate[] | null {
    return this.sets.get(nonce) ?? null;
  }
}

/** Turn a backend item into a candidate, dropping fields nothing renders. */
export function toCandidate(item: DriveSearchItem): Candidate {
  return {
    msId: item.msId,
    driveMsId: item.driveMsId,
    name: item.name,
    parentPath: item.parentPath,
    lastModifiedAt: item.lastModifiedAt,
    enrollmentState: item.enrollmentState,
  };
}

export interface ClassifiedSearchFailure {
  outcome: DriveSearchOutcome;
  message: string;
}

/**
 * Turn a thrown API error into one of the named outcomes.
 *
 * Keyed on the backend's `code` first and the status only as a fallback, for
 * the same reason `classifyEnrollmentFailure` is: the codes name different
 * remedies and the statuses do not. `NO_DELEGATED_TOKEN` is the only one whose
 * remedy is the user's to take, and it is handled by the caller rather than
 * here, because answering it means MINTING a connect link.
 */
export function classifyDriveSearchFailure(
  error: unknown,
): ClassifiedSearchFailure {
  if (error instanceof RockhopperApiError) {
    // The npm package and the backend ship on separate clocks and a customer
    // running `npx` picks up `latest` the moment it publishes, so calling a
    // deployment that predates the route is a real case, not a theoretical
    // one. It must not read as "you have no files".
    if (error.status === 404) {
      return {
        outcome: 'backend_unsupported',
        message:
          'This Rockhopper deployment cannot search Microsoft files from an ' +
          'assistant yet. Ask the user to paste the workbook\'s SharePoint or ' +
          'OneDrive link and call `enroll_file` with it instead.',
      };
    }
    if (error.status === 400) {
      return {
        outcome: 'search_unavailable',
        message:
          'The search needs something to look for. Ask the user for part of ' +
          'the file name, or call again with scope="recent" to list the files ' +
          'they have worked on lately.',
      };
    }
  }

  return {
    outcome: 'search_unavailable',
    message:
      'Microsoft could not answer the file search just now. This is not an ' +
      'empty drive — nothing was searched. Try again in a moment, or ask the ' +
      'user to paste the workbook link and call `enroll_file` with it.',
  };
}

/** The backend's one refusal that means "the user must connect Microsoft". */
export function isNoDelegatedToken(error: unknown): boolean {
  return (
    error instanceof RockhopperApiError && error.code === 'NO_DELEGATED_TOKEN'
  );
}
