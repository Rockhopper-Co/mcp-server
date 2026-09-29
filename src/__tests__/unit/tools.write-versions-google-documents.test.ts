// ENG-6428 — `create_version` and `discard_changes` on a Google Doc or Google
// Slides file whose flag is clean said `NO_CHANGE_ROWS_RECORDED`, a claim that
// Rockhopper keeps no change-by-change list for the file. ENG-5404 made that
// false: Google documents now get change rows through the same document lane
// as `.docx` and `.pptx`, so a clean Google document gets the same plain answer
// a clean Word document gets.
//
// Every assertion names the text that must be PRESENT (the ordinary sentence)
// as well as the refusal that must be absent, so a tool that returned nothing
// could not pass.
import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

type Api = ReturnType<typeof createMockApiClient>;
type WriteTool = 'create_version' | 'discard_changes';

/** The retired refusal code, as a literal: its module no longer exists. */
const RETIRED_CODE = 'NO_CHANGE_ROWS_RECORDED';

const handlerFor = (api: Api, tool: WriteTool) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any, { scope: 'read-write' });
  return server.registerTool.mock.calls.find((c) => c[0] === tool)![2];
};

const fileOf = (fileType: string, hasUncommittedChanges: boolean) => {
  const api = createMockApiClient();
  api.getEnrolledFile.mockResolvedValue({
    internalId: 42,
    platformId: 'file-g',
    fileType,
    driveMsId: 'drive-1',
    name: 'Q3 Narrative',
    hasUncommittedChanges,
  });
  return api;
};

const invoke = (api: Api, tool: WriteTool): Promise<any> =>
  handlerFor(api, tool)(
    tool === 'create_version'
      ? { fileMsId: 'file-g', versionType: 'minor', description: 'why' }
      : { fileMsId: 'file-g', description: 'why' },
  );

const GOOGLE_DOCUMENT_TYPES = ['google_doc', 'google_slides'] as const;
const VERB: Record<WriteTool, string> = {
  create_version: 'commit',
  discard_changes: 'discard',
};

describe.each(GOOGLE_DOCUMENT_TYPES)('a clean %s', (fileType) => {
  it.each(['create_version', 'discard_changes'] as const)(
    '%s returns the ordinary no-uncommitted-changes answer',
    async (tool) => {
      const api = fileOf(fileType, false);
      const result = await invoke(api, tool);
      const text: string = result.content[0].text;

      expect(text).toBe(
        `File "Q3 Narrative" has no uncommitted changes to ${VERB[tool]}.`,
      );
      expect(text).not.toContain(RETIRED_CODE);
      expect(result.isError).toBe(true);
      expect(api.createVersion).not.toHaveBeenCalled();
      expect(api.discardChanges).not.toHaveBeenCalled();
    },
  );
});

describe.each(GOOGLE_DOCUMENT_TYPES)('a %s with uncommitted changes', (fileType) => {
  it('create_version creates the version', async () => {
    const api = fileOf(fileType, true);
    const text: string = (await invoke(api, 'create_version')).content[0].text;

    expect(api.createVersion).toHaveBeenCalled();
    expect(text).not.toContain(RETIRED_CODE);
  });

  it('discard_changes discards', async () => {
    const api = fileOf(fileType, true);
    await invoke(api, 'discard_changes');

    expect(api.discardChanges).toHaveBeenCalledWith('file-g', {
      description: 'why',
    });
  });
});
