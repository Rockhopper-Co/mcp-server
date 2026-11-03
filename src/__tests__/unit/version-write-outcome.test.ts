// A version write is QUEUED by the backend. These specs pin that the tools
// report what the file row's write marker shows afterwards, never the queued
// envelope as if it were the outcome. Every refusal or partial outcome is
// paired with a positive control on the same fixture that proves the
// completed path renders.
import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../../tools/index.js';
import type { EnrolledFile, PendingWriteMarker } from '../../types.js';
import {
  awaitVersionWrite,
  versionWriteOutcomeText,
} from '../../version-write-outcome.js';
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
const ours = (over: Partial<PendingWriteMarker> = {}): EnrolledFile => ({
  ...sheet,
  pendingWrite: { ...submitted.pendingWrite, ...over },
});
const cleared: EnrolledFile = { ...sheet, pendingWrite: null };
const SMARTSHEET_REFUSAL =
  'Smartsheet write refused for sheet-1: sheet_locked';

/** A reader that serves the given rows in order, then repeats the last. */
function reader(...rows: EnrolledFile[]) {
  const getEnrolledFile = vi.fn();
  for (const r of rows) getEnrolledFile.mockResolvedValueOnce(r);
  getEnrolledFile.mockResolvedValue(rows[rows.length - 1]);
  return { getEnrolledFile };
}

describe('awaitVersionWrite', () => {
  it('waits while the marker is ours, then reports completed once it clears', async () => {
    const api = reader(ours(), ours(), cleared);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const outcome = await awaitVersionWrite(api, 'sheet-1', submitted, {
      sleep,
      intervalMs: 10,
    });
    expect(outcome).toEqual({ kind: 'completed' });
    // It read the row three times: the queued envelope alone decided nothing.
    expect(api.getEnrolledFile).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('reports a failed write with the backend reason and error', async () => {
    const api = reader(ours({ status: 'failed', error: SMARTSHEET_REFUSAL }));
    const outcome = await awaitVersionWrite(api, 'sheet-1', submitted);
    expect(outcome).toEqual({
      kind: 'failed',
      reason: null,
      error: SMARTSHEET_REFUSAL,
    });
  });

  it('stops at the bound and says the write is still running', async () => {
    const api = reader(ours({ status: 'waiting', reason: 'locked' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const outcome = await awaitVersionWrite(api, 'sheet-1', submitted, {
      sleep,
      intervalMs: 10,
      timeoutMs: 30,
    });
    expect(outcome).toEqual({ kind: 'running', status: 'waiting', reason: 'locked' });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('a later write with the same job id is not mistaken for this one', async () => {
    const later = ours({ startedAt: '2026-01-03T00:00:00.000Z' });
    const outcome = await awaitVersionWrite(reader(later), 'sheet-1', submitted);
    expect(outcome).toEqual({ kind: 'superseded' });
  });

  it('a no-op body is the backend sentence, and reads no marker', async () => {
    const api = reader(cleared);
    const message = 'Nothing was discarded: this file has no uncommitted changes.';
    const outcome = await awaitVersionWrite(api, 'sheet-1', {
      noOp: true,
      reason: 'no_uncommitted_changes',
      message,
    });
    expect(outcome).toEqual({ kind: 'no_op', message });
    expect(api.getEnrolledFile).not.toHaveBeenCalled();
    expect(versionWriteOutcomeText(outcome, 'x', 'done', 'discard')).toEqual({
      text: message,
      isError: true,
    });
  });
});

type Api = ReturnType<typeof createMockApiClient>;

async function call(api: Api, tool: 'create_version' | 'discard_changes') {
  const server = createMockMcpServer();
  registerTools(server as any, api as any, { scope: 'read-write' });
  const handler = server.registerTool.mock.calls.find((c) => c[0] === tool)![2];
  return handler(
    tool === 'create_version'
      ? { fileMsId: 'sheet-1', versionType: 'minor', description: 'why' }
      : { fileMsId: 'sheet-1', description: 'why' },
  );
}

describe('discard_changes on a Smartsheet sheet', () => {
  it('says the discard failed when the write fails after it was queued', async () => {
    const api = createMockApiClient();
    api.discardChanges.mockResolvedValue(submitted);
    api.getEnrolledFile
      .mockResolvedValueOnce(sheet)
      .mockResolvedValueOnce(ours({ status: 'failed', error: SMARTSHEET_REFUSAL }));
    const result = await call(api, 'discard_changes');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(SMARTSHEET_REFUSAL);
    expect(result.content[0].text).not.toContain('Changes discarded');
  });

  it('positive control: the same discard whose marker clears says discarded', async () => {
    const api = createMockApiClient();
    api.discardChanges.mockResolvedValue(submitted);
    api.getEnrolledFile.mockResolvedValueOnce(sheet).mockResolvedValueOnce(cleared);
    const result = await call(api, 'discard_changes');
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(
      'Changes discarded for "Close Tracker".\nReason: "why"',
    );
  });
});

describe('create_version on a Smartsheet sheet', () => {
  const queued = queuedWrite('create-version', 'create-version:sheet-1');

  it('names the version it asked for once the commit completes', async () => {
    const api = createMockApiClient();
    api.createVersion.mockResolvedValue(queued);
    api.getEnrolledFile.mockResolvedValueOnce(sheet).mockResolvedValueOnce(cleared);
    const result = await call(api, 'create_version');
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(
      'Version v1.1.0 created for "Close Tracker".\nDescription: "why"',
    );
  });

  it('a failed commit never claims a version was created', async () => {
    const api = createMockApiClient();
    api.createVersion.mockResolvedValue(queued);
    api.getEnrolledFile.mockResolvedValueOnce(sheet).mockResolvedValueOnce({
      ...sheet,
      pendingWrite: { ...queued.pendingWrite, status: 'failed', reason: 'superseded' },
    });
    const result = await call(api, 'create_version');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('version commit');
    expect(result.content[0].text).toContain('superseded');
    expect(result.content[0].text).not.toContain('created');
  });

  it('a no-op answer renders the backend sentence, not a version', async () => {
    const api = createMockApiClient();
    const message = 'No new version was created: this file has no uncommitted changes.';
    api.createVersion.mockResolvedValue({
      noOp: true,
      reason: 'no_uncommitted_changes',
      message,
    });
    api.getEnrolledFile.mockResolvedValue(sheet);
    const result = await call(api, 'create_version');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(message);
  });
});
