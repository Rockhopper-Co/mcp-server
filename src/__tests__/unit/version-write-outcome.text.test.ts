// The sentence each version-write outcome becomes, and the real wait between
// two reads of the write marker. Each non-completed sentence is checked
// against the completed one on the same file, so a renderer that answered
// every outcome the same way would fail here.
import { describe, expect, it, vi } from 'vitest';
import type { EnrolledFile } from '../../types.js';
import {
  awaitVersionWrite,
  versionWriteOutcomeText,
  type VersionWriteOutcome,
} from '../../version-write-outcome.js';
import { queuedWrite } from './test-helpers.js';

const FILE = 'Close Tracker';
const completed = versionWriteOutcomeText(
  { kind: 'completed', refused: [] },
  FILE,
  'Changes discarded',
  'discard',
);

describe('versionWriteOutcomeText', () => {
  it('positive control: a completed write says what was done, as a success', () => {
    expect(completed).toEqual({
      text: 'Changes discarded for "Close Tracker".',
      isError: false,
    });
  });

  it('a superseded write sends the caller to the version list, not a claim', () => {
    const out = versionWriteOutcomeText(
      { kind: 'superseded' },
      FILE,
      'Changes discarded',
      'discard',
    );
    expect(out.isError).toBe(false);
    expect(out.text).toBe(
      'The discard on "Close Tracker" has finished and another write on the ' +
        'file has started since. Call get_file_versions to see the result.',
    );
    expect(out.text).not.toContain('Changes discarded');
  });

  it('a running write names its status and reason, and claims nothing', () => {
    const out = versionWriteOutcomeText(
      { kind: 'running', status: 'waiting', reason: 'locked' },
      FILE,
      'Version v1.2.0 created',
      'version commit',
    );
    expect(out.isError).toBe(false);
    expect(out.text).toBe(
      'The version commit on "Close Tracker" is still running: waiting ' +
        '(locked). Call get_file_versions in a moment to see whether it landed.',
    );
    expect(out.text).not.toContain('v1.2.0 created');
  });

  it('a running write with no reason prints no empty brackets', () => {
    const out = versionWriteOutcomeText(
      { kind: 'running', status: 'processing', reason: null },
      FILE,
      'Changes discarded',
      'discard',
    );
    expect(out.text).toContain('is still running: processing. Call');
    expect(out.text).not.toContain('()');
  });

  it('a failed write with neither reason nor error ends at "failed."', () => {
    const out = versionWriteOutcomeText(
      { kind: 'failed', reason: null, error: null },
      FILE,
      'Changes discarded',
      'discard',
    );
    expect(out).toEqual({
      text: 'The discard on "Close Tracker" failed.',
      isError: true,
    });
  });

  it('an outcome outside the union throws by name instead of rendering', () => {
    const bogus = { kind: 'vanished' } as unknown as VersionWriteOutcome;
    expect(() =>
      versionWriteOutcomeText(bogus, FILE, 'Changes discarded', 'discard'),
    ).toThrow('Unhandled version write outcome');
  });
});

describe('awaitVersionWrite with the real timer', () => {
  it('sleeps between reads when no sleep is injected, then reports completed', async () => {
    const submitted = queuedWrite('discard', 'discard:sheet-1');
    const sheet: EnrolledFile = {
      internalId: 7,
      platformId: 'sheet-1',
      fileType: 'smartsheet_sheet',
      driveMsId: '',
      name: FILE,
      hasUncommittedChanges: true,
    };
    const getEnrolledFile = vi
      .fn()
      .mockResolvedValueOnce({ ...sheet, pendingWrite: submitted.pendingWrite })
      .mockResolvedValue({ ...sheet, pendingWrite: null });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      const outcome = await awaitVersionWrite(
        { getEnrolledFile },
        'sheet-1',
        submitted,
        { intervalMs: 1 },
      );
      expect(outcome).toEqual({ kind: 'completed', refused: [] });
      // Two reads with one real 1 ms wait between them.
      expect(getEnrolledFile).toHaveBeenCalledTimes(2);
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 1);
    } finally {
      timer.mockRestore();
    }
  });
});
