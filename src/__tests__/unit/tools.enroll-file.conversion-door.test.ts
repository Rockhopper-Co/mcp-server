import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-9660 (plan 121 SP31) — `enroll_file` after the write: the DOOR's answer
 * wins over the lookup taken before it (ENG-2536), for the conversion too.
 *
 * The door's wire shape is the one ENG-9399 (every enrollment door converts,
 * backend `feat/eng-9399-enrollment-converts--b42e` 9a2362031) produces: each
 * per-file outcome of the 201 carries `conversion: { state, reason }`
 * (`QueuedEnrollmentFileOutcome extends ConversionAnswerFields`,
 * `dto/enrolled-file-conversion-state.dto.ts`), the outcome word stays one of
 * the three, and a Google outcome may carry no `msId`
 * (`enrolled-files.service.ts:1267` sends `file.msId`, which a Google body
 * never has; the stub's msId is minted later, at `:1316`).
 *
 * The race this pins: two members enroll the same Drive `.docx` a few
 * milliseconds apart. B's `info/bulk` shows no link row, so B writes; the door
 * then finds A's pending claim and says so.
 *
 * Planted changes that red these:
 * - not reading `serverFile.conversion` (`serverConversionOf` returning
 *   undefined): the pending test answers "is being added", the refused test
 *   answers `enrolled` and no error.
 * - `answerId` ignoring the server's `msId` for a joined converted record: the
 *   withheld-Google-id test answers the original's id, which no tool resolves.
 * - dropping the Office-name test in `idChangesOnConversion`: the fresh
 *   `.docx` test loses its explicit note; making it unconditional reds the
 *   native Sheet control.
 */

type Api = ReturnType<typeof createMockApiClient>;

const ORIGINAL = 'orig-docx-1';
const GOOGLE_URL = `https://drive.google.com/file/d/${ORIGINAL}/view`;

function handlerFor(api: Api) {
  const server = createMockMcpServer();
  registerTools(server as never, api as never, { capabilities: ['files:write'] });
  const call = server.registerTool.mock.calls.find((c) => c[0] === 'enroll_file');
  return call?.[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function payloadOf(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text.split('\n').at(-1) ?? '{}') as {
    outcome: string;
    fileMsId?: string;
    conversion?: { state: string; reason: string | null };
    enrollmentId?: string;
    idChangesOnConversion?: boolean;
  };
}

/** A Google link nobody has added; the pre-write lookup sees NO conversion. */
function freshGoogleLink(api: Api, id = ORIGINAL, name = 'Board Memo.docx') {
  api.resolveEnrollmentUrl.mockResolvedValue({
    msId: id,
    driveMsId: null,
    provider: 'google',
    name,
    listItemUniqueId: null,
    webUrl: `https://drive.google.com/file/d/${id}/view`,
    enrollmentState: 'not_enrolled',
  });
  api.getEnrollmentInfo.mockResolvedValue([
    { isEnrolled: false, enrollmentState: 'not_enrolled', isInUserWorkspace: false },
  ]);
}

function doorAnswers(api: Api, file: Record<string, unknown>) {
  api.createEnrolledFile.mockResolvedValue({
    enrollmentId: 'enr-9',
    status: 'queued',
    files: [{ platformId: ORIGINAL, outcome: 'enrolled', ...file }],
  });
}

describe("enroll_file reads the door's conversion answer after the write", () => {
  it('the door answers pending after the pre-write read showed no conversion', async () => {
    const api = createMockApiClient();
    freshGoogleLink(api);
    doorAnswers(api, { conversion: { state: 'pending', reason: null } });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });
    const payload = payloadOf(result);
    const text = result.content[0].text;

    // The write RAN (the lookup said nothing), and its answer is the door's.
    expect(api.createEnrolledFile).toHaveBeenCalledTimes(1);
    expect(payload.outcome).toBe('conversion_pending');
    expect(payload.conversion).toEqual({ state: 'pending', reason: null });
    expect(payload.enrollmentId).toBe('enr-9');
    expect(text).toContain('converting it to Google format');
    expect(text).not.toContain('is being added');
    expect(result.isError).toBeUndefined();
  });

  it('the door answers refused after the pre-write read showed none', async () => {
    const api = createMockApiClient();
    freshGoogleLink(api);
    doorAnswers(api, { conversion: { state: 'refused', reason: 'encrypted' } });

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });

    expect(payloadOf(result)).toMatchObject({
      outcome: 'conversion_refused',
      conversion: { state: 'refused', reason: 'encrypted' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('password-protected or encrypted');
    expect(result.content[0].text).toContain('was not added');
  });

  it("a door that joined a record whose Google id was withheld answers the record's msId", async () => {
    const api = createMockApiClient();
    // Converted by another organization: W6 withholds the converted file from
    // a caller who cannot open it yet, so only the door knows the record.
    freshGoogleLink(api);
    api.getEnrollmentInfo.mockResolvedValue([
      {
        isEnrolled: false,
        enrollmentState: 'not_enrolled',
        isInUserWorkspace: false,
        conversion: { state: 'converted' },
      },
    ]);
    doorAnswers(api, {
      msId: 'rec-msid-7',
      outcome: 'already_enrolled',
      conversion: { state: 'converted', reason: null },
    });

    const payload = payloadOf(
      await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' }),
    );

    expect(payload.outcome).toBe('already_enrolled');
    expect(payload.fileMsId).toBe('rec-msid-7');
    expect(payload.idChangesOnConversion).toBeUndefined();
  });

  it("a fresh Office file whose answer carries no msId says its id changes at the conversion", async () => {
    const api = createMockApiClient();
    freshGoogleLink(api);
    doorAnswers(api, {});

    const result = await handlerFor(api)({ url: GOOGLE_URL, share_with: 'me' });
    const payload = payloadOf(result);

    expect(payload.outcome).toBe('enrolled');
    // The only id there is: the original's, and the answer says so.
    expect(payload.fileMsId).toBe(ORIGINAL);
    expect(payload.idChangesOnConversion).toBe(true);
    expect(result.content[0].text).toContain('`search_files` or `list_files`');
  });

  it('positive control: a fresh native Google Sheet gets no such note', async () => {
    const api = createMockApiClient();
    freshGoogleLink(api, 'gsheet-5', 'Budget');
    api.createEnrolledFile.mockResolvedValue({
      enrollmentId: 'enr-9',
      status: 'queued',
      files: [{ platformId: 'gsheet-5', outcome: 'enrolled' }],
    });

    const result = await handlerFor(api)({
      url: 'https://drive.google.com/file/d/gsheet-5/view',
      share_with: 'me',
    });

    expect(payloadOf(result)).toMatchObject({ outcome: 'enrolled', fileMsId: 'gsheet-5' });
    expect(payloadOf(result).idChangesOnConversion).toBeUndefined();
    expect(result.content[0].text).not.toContain('`list_files`');
    expect(result.content[0].text).toContain('is being added to Rockhopper');
  });
});
