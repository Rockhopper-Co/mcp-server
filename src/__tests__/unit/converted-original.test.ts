import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-9660 (plan 121 SP31) — an id an AI client stored for an Office file in
 * Google Drive BEFORE Rockhopper converted it still gets an answer.
 *
 * The backend resolves a tool's file id by `msId` or `platformId`
 * (`FileUserAccessGuard`); the conversion re-points `platformId` at the Google
 * file, so the original's Drive id is refused with the uniform deny. The tool
 * now names the Google file the record tracks (W6), and asserts it by value.
 *
 * Planted changes that red these:
 * - not wrapping the client in `registerTools`: the first test answers the
 *   bare 403, with no `gdoc-7` in it.
 * - dropping the `convertedFile.platformId === fileId` check: the "converted
 *   file's own id" test rewrites a real refusal.
 * - dropping `error.code === null`: the coded-refusal test makes a lookup.
 * - retrying against the new id: `getFileVersions` is called twice.
 */

type Api = ReturnType<typeof createMockApiClient>;

const FORBIDDEN = new RockhopperApiError(
  403,
  'Rockhopper API 403: Forbidden — {"message":"Forbidden resource"}',
  null,
);

const CONVERTED = {
  platformId: 'gdoc-7',
  fileType: 'google_doc',
  name: 'Board Memo',
  editorUrl: null,
};

function versionsTool(api: Api) {
  const server = createMockMcpServer();
  registerTools(server as never, api as never, {});
  const call = server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_file_versions',
  );
  return call?.[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function infoAnswers(api: Api, info: Record<string, unknown>) {
  api.getEnrollmentInfo.mockResolvedValue([
    { isEnrolled: true, enrollmentState: 'enrolled', isInUserWorkspace: true, ...info },
  ]);
}

describe("a tool given an original's id after its conversion", () => {
  it("answers the Google file's id instead of a bare refusal, and does not retry", async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockRejectedValue(FORBIDDEN);
    infoAnswers(api, { convertedFile: CONVERTED, conversion: { state: 'converted' } });

    const result = await versionsTool(api)({ fileMsId: 'orig-docx-1' });
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain('id gdoc-7: call again with that id');
    expect(text).toContain('"Board Memo"');
    expect(api.getEnrollmentInfo).toHaveBeenCalledWith(['orig-docx-1'], 'google');
    // Told, never redirected: the user stays in the loop.
    expect(api.getFileVersions).toHaveBeenCalledTimes(1);
    expect(api.getFileVersions).toHaveBeenCalledWith('orig-docx-1');
  });

  it('positive control: the same refusal with no conversion is the refusal that shipped', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockRejectedValue(FORBIDDEN);
    infoAnswers(api, { enrollmentState: 'not_enrolled', isEnrolled: false });

    const text = (await versionsTool(api)({ fileMsId: 'someone-elses' })).content[0].text;

    expect(text).toBe(`Failed to get versions: ${FORBIDDEN.message}`);
    // The lookup RAN, so the unchanged text is its answer, not a skipped path.
    expect(api.getEnrollmentInfo).toHaveBeenCalledWith(['someone-elses'], 'google');
  });

  it("leaves a refusal of the converted file's OWN id alone", async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockRejectedValue(FORBIDDEN);
    infoAnswers(api, { convertedFile: CONVERTED, conversion: { state: 'converted' } });

    const text = (await versionsTool(api)({ fileMsId: 'gdoc-7' })).content[0].text;

    expect(api.getEnrollmentInfo).toHaveBeenCalledTimes(1);
    expect(text).toBe(`Failed to get versions: ${FORBIDDEN.message}`);
  });

  it('makes no lookup for a refusal that carries its own code', async () => {
    const api = createMockApiClient();
    const coded = new RockhopperApiError(404, 'Rockhopper API 404', 'SOME_CODE');
    api.getFileVersions.mockRejectedValue(coded);

    const text = (await versionsTool(api)({ fileMsId: 'orig-docx-1' })).content[0].text;

    expect(api.getEnrollmentInfo).not.toHaveBeenCalled();
    expect(text).toBe(`Failed to get versions: ${coded.message}`);
  });

  it('rethrows the original refusal when the lookup itself fails', async () => {
    const api = createMockApiClient();
    api.getFileVersions.mockRejectedValue(FORBIDDEN);
    api.getEnrollmentInfo.mockRejectedValue(new RockhopperApiError(500, 'boom', null));

    const text = (await versionsTool(api)({ fileMsId: 'orig-docx-1' })).content[0].text;

    expect(api.getEnrollmentInfo).toHaveBeenCalledTimes(1);
    expect(text).toBe(`Failed to get versions: ${FORBIDDEN.message}`);
  });
});
