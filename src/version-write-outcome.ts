import type {
  EnrolledFile,
  PendingWriteMarker,
  VersionWriteSubmission,
} from './types.js';

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
 * Not covered: which cells a Smartsheet write refused. The backend serves
 * them on no record this client can read, so a completed write here says
 * nothing about them either way.
 */
export type VersionWriteOutcome =
  | { kind: 'no_op'; message: string }
  | { kind: 'completed' }
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

/**
 * The job id is deterministic per op and file, so it repeats across writes;
 * `startedAt` is what tells this write's marker from a later one's.
 */
const isOurs = (marker: PendingWriteMarker, submitted: PendingWriteMarker) =>
  marker.jobId === submitted.jobId && marker.startedAt === submitted.startedAt;

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
    const marker = (await api.getEnrolledFile(fileMsId)).pendingWrite ?? null;
    if (marker === null) return { kind: 'completed' };
    if (!isOurs(marker, submission.pendingWrite)) return { kind: 'superseded' };
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
    case 'completed':
      return { text: `${done} for "${fileName}".`, isError: false };
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
