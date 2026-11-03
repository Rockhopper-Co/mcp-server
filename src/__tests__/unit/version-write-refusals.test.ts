// A version write can COMPLETE while some items stay unchanged (a locked
// Smartsheet cell). The row that clears the write marker carries `lastWrite`;
// these specs pin that a completed outcome names refused items only when
// `lastWrite` is THIS write's episode, and otherwise makes no claim. Every
// "no claim" case runs beside a positive control on the same fixture that
// proves the refusal sentence does render when the episode matches.
import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../../tools/index.js';
import type { EnrolledFile, LastWrite, WriteRefusedKey } from '../../types.js';
import {
  awaitVersionWrite,
  versionWriteOutcomeText,
} from '../../version-write-outcome.js';
import { refusedSentence } from '../../write-refusals.js';
import {
  createMockApiClient,
  createMockMcpServer,
  queuedWrite,
} from './test-helpers.js';

const sheet: EnrolledFile = {
  internalId: 7,
  platformId: 'sheet-1',
  fileType: 'smartsheet_sheet',
  driveMsId: '',
  name: 'Close Tracker',
  hasUncommittedChanges: true,
};

const submitted = queuedWrite('discard', 'discard:sheet-1');
const TWO_LOCKED: WriteRefusedKey[] = [
  { key: 'smartsheet:cell:101:201', reason: 'locked' },
  { key: 'smartsheet:cell:102:201', reason: 'locked' },
];
const PLAIN = 'Changes discarded for "Close Tracker".';
const WITH_REFUSALS = `${PLAIN} 2 cells were not written: locked.`;

/** A cleared row whose `lastWrite` is this write's episode, unless overridden. */
const cleared = (over: Partial<LastWrite> | null = {}): EnrolledFile => ({
  ...sheet,
  pendingWrite: null,
  lastWrite:
    over === null
      ? null
      : {
          op: 'discard',
          jobId: submitted.jobId,
          startedAt: submitted.pendingWrite.startedAt,
          completedAt: '2026-01-02T00:00:05.000Z',
          refusedKeys: TWO_LOCKED,
          ...over,
        },
});

async function textFor(row: EnrolledFile) {
  const api = { getEnrolledFile: vi.fn().mockResolvedValue(row) };
  const outcome = await awaitVersionWrite(api, 'sheet-1', submitted);
  return {
    outcome,
    ...versionWriteOutcomeText(outcome, 'Close Tracker', 'Changes discarded', 'discard'),
  };
}

describe('a completed write and its refused items', () => {
  it('names how many cells were not written and why, when the episode is ours', async () => {
    const { outcome, text, isError } = await textFor(cleared());
    expect(outcome).toEqual({ kind: 'completed', refused: TWO_LOCKED });
    expect(text).toBe(WITH_REFUSALS);
    expect(text).not.toContain('smartsheet:cell');
    expect(isError).toBe(false);
  });

  it('a lastWrite from a later write (same job id) makes no claim', async () => {
    const later = await textFor(cleared({ startedAt: '2026-01-03T00:00:00.000Z' }));
    expect(later.outcome).toEqual({ kind: 'completed', refused: [] });
    expect(later.text).toBe(PLAIN);
    // Positive control: the same fixture with our episode renders the claim.
    expect((await textFor(cleared())).text).toBe(WITH_REFUSALS);
  });

  it('a lastWrite with another job id makes no claim', async () => {
    const other = await textFor(cleared({ jobId: 'create-version:sheet-1' }));
    expect(other.text).toBe(PLAIN);
    expect((await textFor(cleared())).text).toBe(WITH_REFUSALS);
  });

  it('refusedKeys null (not reported) makes no claim', async () => {
    const unreported = await textFor(cleared({ refusedKeys: null }));
    expect(unreported.outcome).toEqual({ kind: 'completed', refused: [] });
    expect(unreported.text).toBe(PLAIN);
    expect((await textFor(cleared())).text).toBe(WITH_REFUSALS);
  });

  it('refusedKeys [] (none refused) is the plain completion', async () => {
    const none = await textFor(cleared({ refusedKeys: [] }));
    expect(none.text).toBe(PLAIN);
    expect((await textFor(cleared())).text).toBe(WITH_REFUSALS);
  });

  it('a null or absent lastWrite (older backend) makes no claim', async () => {
    expect((await textFor(cleared(null))).text).toBe(PLAIN);
    const { lastWrite: _dropped, ...absent } = cleared();
    expect((await textFor(absent)).text).toBe(PLAIN);
    expect((await textFor(cleared())).text).toBe(WITH_REFUSALS);
  });
});

describe('refusedSentence', () => {
  it('groups by reason, most frequent first, counting cells and rows apart', () => {
    expect(
      refusedSentence([
        { key: 'smartsheet:cell:1:9', reason: 'scopes_insufficient' },
        { key: 'smartsheet:cell:2:9', reason: 'locked' },
        { key: 'smartsheet:cell:3:9', reason: 'locked' },
        { key: 'row:44', reason: 'refused' },
      ]),
    ).toBe(
      '3 cells and 1 row were not written: locked (2), ' +
        'the connection lacks write permission (1), refused (1).',
    );
  });

  it('says each named reason in plain words, and an unknown one as refused', () => {
    const one = (reason: string) =>
      refusedSentence([{ key: 'smartsheet:cell:1:2', reason }]);
    expect(one('read_only')).toBe(
      '1 cell was not written: read-only for the connected account.',
    );
    expect(one('row_gone')).toBe('1 cell was not written: the row no longer exists.');
    expect(one('needs_reconnect')).toBe(
      '1 cell was not written: the connection needs reconnecting.',
    );
    expect(one('constructor')).toBe('1 cell was not written: refused.');
    expect(refusedSentence([{ key: 'row:5', reason: 'refused' }])).toBe(
      '1 row was not written: refused.',
    );
  });

  it('an unknown reason joins the refused group rather than a group of its own', () => {
    expect(
      refusedSentence([
        { key: 'smartsheet:cell:1:2', reason: 'refused' },
        { key: 'smartsheet:cell:1:3', reason: 'vendor_new_code' },
      ]),
    ).toBe('2 cells were not written: refused.');
  });

  it('no refused items is no sentence', () => {
    expect(refusedSentence([])).toBe('');
  });
});

describe('discard_changes reports refused cells end to end', () => {
  async function discard(row: EnrolledFile) {
    const api = createMockApiClient();
    api.discardChanges.mockResolvedValue(submitted);
    api.getEnrolledFile.mockResolvedValueOnce(sheet).mockResolvedValueOnce(row);
    const server = createMockMcpServer();
    registerTools(server as any, api as any, { scope: 'read-write' });
    const handler = server.registerTool.mock.calls.find(
      (c) => c[0] === 'discard_changes',
    )![2];
    return handler({ fileMsId: 'sheet-1', description: 'why' });
  }

  it('the tool text carries the refusal sentence before the reason', async () => {
    const result = await discard(cleared());
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(`${WITH_REFUSALS}\nReason: "why"`);
  });

  it('positive control: the same discard with a mismatched episode is plain', async () => {
    const result = await discard(cleared({ startedAt: '2026-01-04T00:00:00.000Z' }));
    expect(result.content[0].text).toBe(`${PLAIN}\nReason: "why"`);
  });
});
