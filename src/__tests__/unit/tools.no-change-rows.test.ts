// ENG-5410 — `create_version` and `discard_changes` told a native Google Doc
// or Google Slides caller their file had "no uncommitted changes", the exact
// false claim ENG-5073 removed from the web app's version path. Nothing ever
// sets `hasUncommittedChanges` for either type, so that sentence was a finding
// reported about a window that nothing writes to.
//
// The contract these tests pin, and every assertion below names the refusal BY
// IDENTITY rather than checking that something came back: a write with no
// recorded change to make REFUSES WITH A REASON, and the reason is ENG-5073's
// `NO_CHANGE_ROWS_RECORDED` rather than a second vocabulary. A tool that
// returned the old no-op string would satisfy `isError` and a non-empty
// `content`, so neither is asserted anywhere in this file.
import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import {
  NO_CHANGE_ROWS_RECORDED_CODE,
  recordsChangeRows,
} from '../../no-change-rows-recorded.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

type Api = ReturnType<typeof createMockApiClient>;

const handlerFor = (api: Api, tool: 'create_version' | 'discard_changes') => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any, { scope: 'read-write' });
  return server.registerTool.mock.calls.find((c) => c[0] === tool)![2];
};

/** A file the flag calls clean — the only state either refusal is reachable in. */
const cleanFile = (fileType: string | null | undefined, name: string) => {
  const api = createMockApiClient();
  api.getEnrolledFile.mockResolvedValue({
    internalId: 42,
    platformId: 'file-g',
    fileType,
    driveMsId: 'drive-1',
    name,
    hasUncommittedChanges: false,
  });
  return api;
};

const invoke = (
  api: Api,
  tool: 'create_version' | 'discard_changes',
): Promise<any> =>
  handlerFor(api, tool)(
    tool === 'create_version'
      ? { fileMsId: 'file-g', versionType: 'minor', description: 'why' }
      : { fileMsId: 'file-g', description: 'why' },
  );

/** Both Google document types, both tools — the four arms the ticket requires. */
const GOOGLE_DOCUMENT_TYPES = ['google_doc', 'google_slides'] as const;
const WRITE_TOOLS = ['create_version', 'discard_changes'] as const;

describe('the predicate that decides which files record a change-by-change list', () => {
  it('answers false for exactly the two Google document types', () => {
    expect(recordsChangeRows('google_doc')).toBe(false);
    expect(recordsChangeRows('google_slides')).toBe(false);
  });

  it('answers true for every Microsoft type and both Google spreadsheets', () => {
    for (const t of [
      'microsoft_xlsx',
      'microsoft_xlsm',
      'microsoft_docx',
      'microsoft_pptx',
      'gdrive_xlsx',
      'gsheet_native',
    ]) {
      expect(recordsChangeRows(t), t).toBe(true);
    }
  });

  // The safety direction, and it is the whole reason an unknown arm exists:
  // this package ships to customers on their own upgrade schedule, so a
  // `fileType` it has never heard of must keep today's behaviour rather than
  // acquire a new negative claim about a file it cannot name.
  it('answers true for an unknown, absent or null fileType', () => {
    expect(recordsChangeRows('some_type_added_after_this_release')).toBe(true);
    expect(recordsChangeRows(undefined)).toBe(true);
    expect(recordsChangeRows(null)).toBe(true);
  });
});

describe.each(GOOGLE_DOCUMENT_TYPES)(
  'a %s write refuses with a reason instead of reporting no changes',
  (fileType) => {
    it.each(WRITE_TOOLS)('%s names NO_CHANGE_ROWS_RECORDED', async (tool) => {
      const api = cleanFile(fileType, 'Q3 Narrative');
      const text = (await invoke(api, tool)).content[0].text;

      expect(text).toContain(NO_CHANGE_ROWS_RECORDED_CODE);
      expect(JSON.parse(text.slice(text.indexOf('{')))).toMatchObject({
        status: 'no_change_rows_recorded',
        code: NO_CHANGE_ROWS_RECORDED_CODE,
        fileType,
        action: tool === 'create_version' ? 'commit' : 'discard',
      });
    });

    it.each(WRITE_TOOLS)(
      '%s no longer claims the file has no uncommitted changes',
      async (tool) => {
        const api = cleanFile(fileType, 'Q3 Narrative');
        const text: string = (await invoke(api, tool)).content[0].text;

        // Scoped to the CLAIM SENTENCE — the line a client relays to a human —
        // and not to the whole payload, because the guardrail line below it
        // NEGATES these same phrases ("Do NOT say ... is already committed").
        // A whole-text ban reds on that line, which is the copy working.
        const claim = text.split('\n')[1];
        expect(claim).toBeDefined();
        expect(claim).not.toContain('has no uncommitted changes');
        expect(claim).not.toContain('already committed');
        expect(claim).toContain(
          "Rockhopper records this file's versions and the comparison between " +
            'them, not a change-by-change list',
        );
      },
    );

    it.each(WRITE_TOOLS)('%s makes no write against the API', async (tool) => {
      const api = cleanFile(fileType, 'Q3 Narrative');
      await invoke(api, tool);

      expect(api.createVersion).not.toHaveBeenCalled();
      expect(api.discardChanges).not.toHaveBeenCalled();
    });

    // §Never Explain a Platform's Limitations to a Customer — an AI client
    // relays this sentence to a human verbatim, so it carries in-product copy's
    // bar: no vendor named as the reason, no capture mechanism or cadence
    // published, no hedging.
    it.each(WRITE_TOOLS)('%s copy names no vendor and no mechanism', async (tool) => {
      const api = cleanFile(fileType, 'Q3 Narrative');
      const text: string = (await invoke(api, tool)).content[0].text;
      const prose = text.slice(0, text.indexOf('{'));

      for (const banned of [
        'Google',
        'add-on',
        'Apps Script',
        'capture',
        'poll',
        'seconds',
        'may ',
        'might ',
      ]) {
        expect(prose, banned).not.toContain(banned);
      }
    });
  },
);

describe('every other file type is untouched', () => {
  // ENG-4843 gave Word and PowerPoint real capture lanes, so they set the flag
  // and these tools work for them today. A `.docx` that IS clean must still get
  // the plain message — the new reason would be a false claim about it.
  it.each(['microsoft_docx', 'microsoft_pptx', 'microsoft_xlsx'])(
    '%s keeps the plain no-uncommitted-changes message',
    async (fileType) => {
      const api = cleanFile(fileType, 'Board Deck');
      const text = (await invoke(api, 'create_version')).content[0].text;

      expect(text).toContain('has no uncommitted changes to commit');
      expect(text).not.toContain(NO_CHANGE_ROWS_RECORDED_CODE);
    },
  );

  // PERMISSIVE-ONLY, mirroring ENG-5073: the new branch is nested inside the
  // refusal that already existed, so a Google document whose flag somehow IS
  // set still writes. This pins that the change can only ever reword a refusal,
  // never create one.
  it.each(GOOGLE_DOCUMENT_TYPES)(
    'a %s whose flag is set still creates the version',
    async (fileType) => {
      const api = cleanFile(fileType, 'Q3 Narrative');
      api.getEnrolledFile.mockResolvedValue({
        internalId: 42,
        platformId: 'file-g',
        fileType,
        driveMsId: 'drive-1',
        name: 'Q3 Narrative',
        hasUncommittedChanges: true,
      });

      const text = (await invoke(api, 'create_version')).content[0].text;

      expect(api.createVersion).toHaveBeenCalled();
      expect(text).not.toContain(NO_CHANGE_ROWS_RECORDED_CODE);
    },
  );
});
