import type {
  EnrolledFile,
  VersionWriteSubmission,
  WriteRefusedKey,
} from './types.js';
import { refusedBy, refusedSentence, sameEpisode } from './write-refusals.js';

/**
 * A version write (create-version or discard) is QUEUED by the backend: the
 * POST answers `{ status: 'queued', jobId, pendingWrite }` before the write
 * runs. Its outcome is the enrolled file's `pendingWrite` marker, which the
 * backend clears when the write completes (before it pushes
 * `file-write-completed` to socket clients, which this REST client is not)
 * and leaves `failed`, with a reason, when it fails.
 *
 * So a tool reports what it OBSERVED on that marker within a bounded wait,
 * never the submission as if it were the outcome.
 *
 * A write can complete while some items stay unchanged (a locked Smartsheet
 * cell). The row that clears the marker carries `lastWrite`, and when its
 * episode is this write's, a completed outcome names those items.
 */
export type VersionWriteOutcome =
  | { kind: 'no_op'; message: string }
  /** `refused`: the items this write reported it could not change. */
  | { kind: 'completed'; refused: WriteRefusedKey[] }
  | { kind: 'failed'; reason: string | null; error: string | null }
  /** Another write on the file has started since this one ended. */
  | { kind: 'superseded' }
  /** Still in flight when the wait ended. */
  | { kind: 'running'; status: string; reason: string | null };

export interface OutcomeReader {
  getEnrolledFile(fileMsId: string): Promise<EnrolledFile>;
}

export interface AwaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 1_000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function awaitVersionWrite(
  api: OutcomeReader,
  fileMsId: string,
  submission: VersionWriteSubmission,
  opts: AwaitOptions = {},
): Promise<VersionWriteOutcome> {
  if ('noOp' in submission) {
    return { kind: 'no_op', message: submission.message };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? realSleep;
  for (let waited = 0; ; waited += intervalMs) {
    const file = await api.getEnrolledFile(fileMsId);
    const marker = file.pendingWrite ?? null;
    if (marker === null) {
      const refused = refusedBy(file.lastWrite, submission.pendingWrite);
      return { kind: 'completed', refused };
    }
    // The job id repeats across writes; `startedAt` tells ours from a later one.
    if (!sameEpisode(marker, submission.pendingWrite)) {
      return { kind: 'superseded' };
    }
    if (marker.status === 'failed') {
      return {
        kind: 'failed',
        reason: marker.reason ?? null,
        error: marker.error ?? null,
      };
    }
    if (waited >= timeoutMs) {
      return {
        kind: 'running',
        status: marker.status,
        reason: marker.reason ?? null,
      };
    }
    await sleep(intervalMs);
  }
}

/**
 * The outcome as the sentence a tool returns. `done` is what the tool did
 * ("Version v1.2.0 created", "Changes discarded"), said only on completion.
 */
export function versionWriteOutcomeText(
  outcome: VersionWriteOutcome,
  fileName: string,
  done: string,
  op: string,
): { text: string; isError: boolean } {
  switch (outcome.kind) {
    case 'no_op':
      return { text: outcome.message, isError: true };
    case 'completed': {
      const refused = refusedSentence(outcome.refused);
      return {
        text: `${done} for "${fileName}".${refused ? ` ${refused}` : ''}`,
        isError: false,
      };
    }
    case 'failed': {
      const why = [outcome.reason, outcome.error].filter(Boolean).join(': ');
      return {
        text: `The ${op} on "${fileName}" failed${why ? `: ${why}` : '.'}`,
        isError: true,
      };
    }
    case 'superseded':
      return {
        text:
          `The ${op} on "${fileName}" has finished and another write on the ` +
          'file has started since. Call get_file_versions to see the result.',
        isError: false,
      };
    case 'running': {
      const why = outcome.reason ? ` (${outcome.reason})` : '';
      return {
        text:
          `The ${op} on "${fileName}" is still running: ${outcome.status}${why}. ` +
          'Call get_file_versions in a moment to see whether it landed.',
        isError: false,
      };
    }
    default: {
      const unknown: never = outcome;
      throw new Error(`Unhandled version write outcome: ${String(unknown)}`);
    }
  }
}
