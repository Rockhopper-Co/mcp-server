import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-9660 (plan 121 SP31) — `enroll_file` on an Office file in Google Drive,
 * answered from what `info/bulk` says BEFORE any write (W6).
 *
 * WHAT IS ASSERTED is the id the answer hands back, by value, because that id
 * is what the model passes to every other tool. One rule: the id `list_files`
 * and `search_files` show (`platformId`), which for a converted original is
 * the Google file's id, never the original's, and never the record's random
 * `msId` for an ordinary Google file.
 *
 * Planted changes that red these:
 * - `answerId` returning `target.fileId` alone: the converted-original test
 *   answers `orig-docx-1` instead of `gdoc-7`.
 * - `answerId` returning `info.enrolledFileMsId` first: the native Sheet test
 *   answers `uuid-rec-5`.
 * - dropping the Google `getEnrollmentInfo` call in `resolveTarget`: every
 *   conversion test loses its `conversion` field and its outcome.
 * - dropping the own-id check in `conversionSentence`: the converted file's
 *   own link says it was converted from an Office file.
 * - the pending sentence ignoring `callerHasFile`: the untracked pending test
 *   sends the model to `search_files`, which never lists the file for them.
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
    idChangesOnConversion?: boolean;
  };
}

/** A Google link resolves; `info/bulk` answers its Drive id per W6. */
function googleLink(
  api: Api,
  enrollmentState: 'enrolled' | 'hidden' | 'not_enrolled',
  info: Record<string, unknown>,
  file: { id: string; name: string } = { id: ORIGINAL, name: 'Board Memo.docx' },
) {
  api.resolveEnrollmentUrl.mockResolvedValue({
    msId: file.id,
    driveMsId: null,
    provider: 'google',
    name: file.name,
    listItemUniqueId: null,
    webUrl: `https://drive.google.com/file/d/${file.id}/view`,
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
  it("answers the Google file's id and name, never the original's", async () => {
    const api = createMockApiClient();
    googleLink(api, 'enrolled', {
      enrolledFileMsId: 'rec-msid-7',
      internalId: 7,
      name: 'Board Memo',
      convertedFile: CONVERTED,
      conversion: { state: 'converted' },
    });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });
    const payload = payloadOf(result);
    const text = result.content[0].text;

    expect(payload.outcome).toBe('already_enrolled');
    expect(payload.fileMsId).toBe('gdoc-7');
    expect(payload.name).toBe('Board Memo');
    expect(payload.convertedFile?.platformId).toBe('gdoc-7');
    expect(payload.conversion?.state).toBe('converted');
    // The text and `detail` name the same id (one id, not two).
    expect(text).toContain('(id gdoc-7)');
    expect(text).toContain('converted this Office file');
    expect(payload.idChangesOnConversion).toBeUndefined();
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

  it("a native Google Sheet answers its Drive id, never the record's random msId", async () => {
    const api = createMockApiClient();
    googleLink(
      api,
      'enrolled',
      { enrolledFileMsId: 'uuid-rec-5', internalId: 5, name: 'Budget' },
      { id: 'gsheet-5', name: 'Budget' },
    );

    const payload = payloadOf(
      await handlerFor(api)({ url: 'https://drive.google.com/file/d/gsheet-5/view', share_with: 'me' }),
    );

    expect(payload.outcome).toBe('already_enrolled');
    expect(payload.fileMsId).toBe('gsheet-5');
    expect(payload.conversion).toBeUndefined();
  });

  it("the converted Google file's own link says nothing about an Office file", async () => {
    const api = createMockApiClient();
    // W6 reads the link row by EITHER Drive id, so the converted file's own id
    // carries `conversion: converted` too.
    googleLink(
      api,
      'enrolled',
      { enrolledFileMsId: 'rec-msid-7', name: 'Board Memo', convertedFile: CONVERTED, conversion: { state: 'converted' } },
      { id: 'gdoc-7', name: 'Board Memo' },
    );

    const result = await handlerFor(api)({
      url: 'https://docs.google.com/document/d/gdoc-7/edit',
      share_with: 'me',
    });

    expect(payloadOf(result)).toMatchObject({ outcome: 'already_enrolled', fileMsId: 'gdoc-7' });
    expect(result.content[0].text).not.toContain('Office file');
    expect(result.content[0].text).toContain('"Board Memo" is already in Rockhopper');
  });
});

describe('enroll_file speaks each conversion state', () => {
  it('pending, not tracked for this user: conversion_pending, no write, enroll again later', async () => {
    const api = createMockApiClient();
    googleLink(api, 'not_enrolled', { conversion: { state: 'pending', reason: null } });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });
    const text = result.content[0].text;

    expect(payloadOf(result).outcome).toBe('conversion_pending');
    expect(result.isError).toBeUndefined();
    expect(text).toContain('converting it to Google format');
    // `search_files` lists only this user's files, so it would never show it.
    expect(text).toContain('call `enroll_file` again');
    expect(text).not.toContain('`search_files`');
    expect(api.createEnrolledFile).not.toHaveBeenCalled();
  });

  it('positive control: pending on a file this user already holds points at search_files', async () => {
    const api = createMockApiClient();
    googleLink(api, 'enrolled', { conversion: { state: 'pending', reason: null } });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(payloadOf(result).outcome).toBe('already_enrolled');
    expect(result.content[0].text).toContain('check again with `search_files`');
    expect(result.content[0].text).not.toContain('call `enroll_file` again');
  });

  it('refused: conversion_refused with the stored reason said, nothing written', async () => {
    const api = createMockApiClient();
    googleLink(api, 'not_enrolled', {
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
    googleLink(api, 'not_enrolled', {
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

  it('kept_as_office: the kept record answers by its Drive id, and says why it stayed Office', async () => {
    const api = createMockApiClient();
    googleLink(api, 'enrolled', {
      enrolledFileMsId: 'rec-kept-3',
      name: 'Macros.xlsm',
      conversion: { state: 'kept_as_office', reason: 'over_cell_limit' },
    });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(payloadOf(result)).toMatchObject({
      outcome: 'already_enrolled',
      fileMsId: ORIGINAL,
      conversion: { state: 'kept_as_office' },
    });
    expect(result.content[0].text).toContain('Google could not convert it');
  });
});
