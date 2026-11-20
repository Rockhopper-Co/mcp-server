import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-9660 (plan 121 SP31) — `enroll_file` on an Office file in Google Drive
 * answers for the Google record Rockhopper converted it into.
 *
 * WHAT IS ASSERTED is the id the answer hands back, by value, because that id
 * is what the model passes to every other tool. Before this change the URL
 * branch never read `info/bulk`, so it could not see the conversion (W6), and
 * the answer carried `fileId`: the ORIGINAL's Drive id, which no tool resolves
 * once the record is re-pointed at the converted file.
 *
 * Planted changes that red these:
 * - `answerId` returning `target.fileId`: the converted-original tests answer
 *   `orig-docx-1` instead of the record's id.
 * - dropping the Google `getEnrollmentInfo` call in `resolveTarget`: every
 *   conversion test loses its `conversion` field and its outcome.
 * - `fileMsId: answerId(target)` after the write (ignoring the server's
 *   `msId`): the post-write test answers `orig-docx-1`.
 */

type Api = ReturnType<typeof createMockApiClient>;

const ORIGINAL = 'orig-docx-1';
const GOOGLE_URL = `https://drive.google.com/file/d/${ORIGINAL}/view`;
const CONVERTED = {
  platformId: 'gdoc-7',
  fileType: 'google_doc',
  name: 'Board Memo',
  editorUrl: 'https://docs.google.com/document/d/gdoc-7/edit',
};

function handlerFor(api: Api) {
  const server = createMockMcpServer();
  registerTools(server as never, api as never, { capabilities: ['files:write'] });
  const call = server.registerTool.mock.calls.find((c) => c[0] === 'enroll_file');
  return call?.[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/** The JSON line every answer ends with. */
function payloadOf(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text.split('\n').at(-1) ?? '{}') as {
    outcome: string;
    fileMsId?: string;
    name?: string | null;
    conversion?: { state: string; reason: string | null };
    convertedFile?: { platformId: string };
  };
}

/** The original's link resolves; `info/bulk` answers it per W6. */
function original(
  api: Api,
  enrollmentState: 'enrolled' | 'hidden' | 'not_enrolled',
  info: Record<string, unknown>,
) {
  api.resolveEnrollmentUrl.mockResolvedValue({
    msId: ORIGINAL,
    driveMsId: null,
    provider: 'google',
    name: 'Board Memo.docx',
    listItemUniqueId: null,
    webUrl: GOOGLE_URL,
    enrollmentState,
  });
  api.getEnrollmentInfo.mockResolvedValue([
    {
      isEnrolled: enrollmentState === 'enrolled',
      enrollmentState,
      isInUserWorkspace: enrollmentState === 'enrolled',
      ...info,
    },
  ]);
}

describe('enroll_file on an Office file Rockhopper converted', () => {
  it("answers the converted record's id and name, never the original's", async () => {
    const api = createMockApiClient();
    original(api, 'enrolled', {
      enrolledFileMsId: 'rec-msid-7',
      internalId: 7,
      name: 'Board Memo',
      convertedFile: CONVERTED,
      conversion: { state: 'converted' },
    });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });
    const payload = payloadOf(result);

    expect(payload.outcome).toBe('already_enrolled');
    expect(payload.fileMsId).toBe('rec-msid-7');
    expect(payload.name).toBe('Board Memo');
    expect(payload.convertedFile?.platformId).toBe('gdoc-7');
    expect(payload.conversion?.state).toBe('converted');
    expect(result.content[0].text).toContain('(id gdoc-7)');
    // The conversion was read in the Drive id space, for the original's id.
    expect(api.getEnrollmentInfo).toHaveBeenCalledWith([ORIGINAL], 'google');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('positive control: a Microsoft link reads no conversion and answers its own id', async () => {
    const api = createMockApiClient();
    api.resolveEnrollmentUrl.mockResolvedValue({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      provider: 'microsoft',
      name: 'Plan.xlsx',
      listItemUniqueId: 'liuid-9',
      webUrl: 'https://contoso.sharepoint.com/x',
      enrollmentState: 'enrolled',
    });

    const payload = payloadOf(
      await handlerFor(api)({ url: 'https://contoso.sharepoint.com/x', share_with: 'me' }),
    );

    expect(payload.outcome).toBe('already_enrolled');
    expect(payload.fileMsId).toBe('ms-item-9');
    expect(payload.conversion).toBeUndefined();
    expect(api.getEnrollmentInfo).not.toHaveBeenCalled();
  });

  it("after a write, answers the record the server enrolled (the converted one)", async () => {
    const api = createMockApiClient();
    // Converted by another organization: not tracked for this caller yet, and
    // the converted file is withheld until they can open it (W6).
    original(api, 'not_enrolled', { conversion: { state: 'converted' } });
    api.createEnrolledFile.mockResolvedValue({
      enrollmentId: 'enr-9',
      status: 'queued',
      files: [{ msId: 'rec-msid-7', platformId: ORIGINAL, outcome: 'already_enrolled' }],
    });

    const payload = payloadOf(
      await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' }),
    );

    expect(api.createEnrolledFile).toHaveBeenCalledTimes(1);
    expect(payload.outcome).toBe('already_enrolled');
    expect(payload.fileMsId).toBe('rec-msid-7');
  });
});

describe('enroll_file speaks each conversion state', () => {
  it('pending: conversion_pending, and nothing is written', async () => {
    const api = createMockApiClient();
    original(api, 'not_enrolled', { conversion: { state: 'pending', reason: null } });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(payloadOf(result).outcome).toBe('conversion_pending');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('converting it to Google format');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('refused: conversion_refused with the stored reason said, nothing written', async () => {
    const api = createMockApiClient();
    original(api, 'not_enrolled', {
      conversion: { state: 'refused', reason: 'over_size_limit' },
    });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(payloadOf(result)).toMatchObject({
      outcome: 'conversion_refused',
      conversion: { state: 'refused', reason: 'over_size_limit' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('larger than Google will convert');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
    expect(api.enrollFileSharedWith).not.toHaveBeenCalled();
  });

  it('waiting_for_member: the write runs (it resumes) and the remedy is named', async () => {
    const api = createMockApiClient();
    original(api, 'not_enrolled', {
      conversion: { state: 'waiting_for_member', reason: 'no_write_grant' },
    });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(api.createEnrolledFile).toHaveBeenCalledTimes(1);
    expect(payloadOf(result).conversion).toEqual({
      state: 'waiting_for_member',
      reason: 'no_write_grant',
    });
    expect(result.content[0].text).toContain('`connect_google`');
    expect(result.content[0].text).toContain('full Drive access');
  });

  it('kept_as_office: the kept record answers, and says why it stayed Office', async () => {
    const api = createMockApiClient();
    original(api, 'enrolled', {
      enrolledFileMsId: 'rec-kept-3',
      name: 'Macros.xlsm',
      conversion: { state: 'kept_as_office', reason: 'over_cell_limit' },
    });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(payloadOf(result)).toMatchObject({
      outcome: 'already_enrolled',
      fileMsId: 'rec-kept-3',
      conversion: { state: 'kept_as_office' },
    });
    expect(result.content[0].text).toContain('Google could not convert it');
  });
});
