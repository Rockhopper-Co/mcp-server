import type { LastWrite, WriteRefusedKey } from './types.js';

/** The two fields that identify one write episode (the job id repeats). */
export interface WriteEpisode {
  jobId: string;
  startedAt: string;
}

export const sameEpisode = (a: WriteEpisode, b: WriteEpisode) =>
  a.jobId === b.jobId && a.startedAt === b.startedAt;

/**
 * The items THIS write refused, read off the file's `lastWrite`. Empty when
 * `lastWrite` is absent, belongs to another write, or reported nothing: a
 * completed write then makes no claim about refused items either way.
 */
export function refusedBy(
  lastWrite: LastWrite | null | undefined,
  submitted: WriteEpisode,
): WriteRefusedKey[] {
  if (!lastWrite || !sameEpisode(lastWrite, submitted)) return [];
  return lastWrite.refusedKeys ?? [];
}

/** Plain words for each named refusal; an unknown name reads as `refused`. */
const REASON_TEXT = new Map<string, string>([
  ['locked', 'locked'],
  ['scopes_insufficient', 'the connection lacks write permission'],
  ['read_only', 'read-only for the connected account'],
  ['row_gone', 'the row no longer exists'],
  ['needs_reconnect', 'the connection needs reconnecting'],
  ['refused', 'refused'],
]);

const reasonText = (reason: string) => REASON_TEXT.get(reason) ?? 'refused';

/** A `row:<id>` key is a whole row that could not be restored. */
const isRow = (key: string) => key.startsWith('row:');

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * One sentence naming how many items a completed write did not change and
 * why, grouped by reason, most frequent first. Keys are never printed: their
 * ids are opaque numbers with no readable form. Empty for no refused items.
 */
export function refusedSentence(refused: readonly WriteRefusedKey[]): string {
  if (refused.length === 0) return '';
  const rows = refused.filter((r) => isRow(r.key)).length;
  const cells = refused.length - rows;
  const parts = [
    cells > 0 ? count(cells, 'cell') : '',
    rows > 0 ? count(rows, 'row') : '',
  ].filter(Boolean);
  const verb = refused.length === 1 ? 'was' : 'were';
  const groups = new Map<string, number>();
  for (const r of refused) {
    const label = reasonText(r.reason);
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const ranked = [...groups].sort((a, b) => b[1] - a[1]);
  const why =
    ranked.length === 1
      ? ranked[0][0]
      : ranked.map(([label, n]) => `${label} (${n})`).join(', ');
  return `${parts.join(' and ')} ${verb} not written: ${why}.`;
}
