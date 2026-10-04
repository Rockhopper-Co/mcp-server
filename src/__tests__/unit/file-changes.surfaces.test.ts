import { describe, expect, it } from 'vitest';
import { registerResources } from '../../resources/index.js';
import { registerPrompts } from '../../prompts/index.js';
import { DOCUMENT_CHANGES_UNAVAILABLE_MARKER } from '../../document-changes.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-6431 — the `…/changes` resource and the `summarize-file-changes` /
 * `file-overview` prompts read the SPREADSHEET-ONLY lane for every file, so a
 * `.docx`, `.pptx`, Google Doc or Google Slides file reported zero changes by
 * construction. They now share `readFileChanges` with the tool.
 *
 * Every assertion is POSITIVE and BY IDENTITY: the defect IS an empty answer,
 * so a count or emptiness check passes on it. Each document case names the
 * request made (`getDocumentChanges` for that file id) AND a row's own anchor
 * id and stored text, and asserts the spreadsheet lane was NOT called.
 */

type Api = ReturnType<typeof createMockApiClient>;
type PromptResult = { messages: Array<{ content: { text: string } }> };
type ResourceResult = { contents: Array<{ text: string }> };

function resource(api: Api) {
  const server = createMockMcpServer();
  registerResources(server as never, api as never);
  const call = server.registerResource.mock.calls.find(
    (c) => c[0] === 'unattributed-changes',
  );
  const handler = call?.[3] as (
    uri: URL,
    vars: Record<string, unknown>,
  ) => Promise<ResourceResult>;
  return (id: string) =>
    handler(new URL(`rockhopper://files/${id}/changes`), { fileMsId: id });
}

function prompt(api: Api, name: string) {
  const server = createMockMcpServer();
  registerPrompts(server as never, api as never);
  const call = server.registerPrompt.mock.calls.find((c) => c[0] === name);
  const handler = call?.[2] as (a: { fileMsId: string }) => Promise<PromptResult>;
  return async (id: string) =>
    (await handler({ fileMsId: id })).messages[0].content.text;
}

const BASE_ROW = {
  kind: 'block',
  locationKind: 'block',
  containerOrdinal: null,
  containerProviderId: null,
  anchorOrdinal: 4,
  anchorLabel: null,
  changeKind: 'block_edit',
  actorKind: 'human',
  actorPlatformId: 'ms-user-1',
  attributionConfidence: 'credential_bound',
  editorPlatformId: 'ms-user-1',
  occurredAt: '2026-09-15T10:00:00.000Z',
  firstObservedAt: '2026-09-15T10:00:01.000Z',
  truncated: false,
};

/** One distinct row per document model, so no case can pass on another's row. */
const DOCUMENT_CASES = [
  { fileType: 'microsoft_docx', id: 'file-docx', anchor: 'w14-paraId-7A3B', from: 'Net 30 days', to: 'Net 60 days', slide: null },
  { fileType: 'microsoft_pptx', id: 'file-pptx', anchor: 'slide-id-9::12', from: 'Q3 Results', to: 'Q4 Results', slide: 'slide-id-9' },
  { fileType: 'google_doc', id: 'file-gdoc', anchor: 'kix.gdoc-para-1', from: 'Draft terms', to: 'Final terms', slide: null },
  { fileType: 'google_slides', id: 'file-gslides', anchor: 'g-slide-3::7', from: 'Old headline', to: 'New headline', slide: 'g-slide-3' },
] as const;

type DocCase = (typeof DOCUMENT_CASES)[number];

function documentFile(api: Api, c: DocCase, declineReason: string | null = null) {
  api.getEnrolledFile.mockResolvedValue({
    internalId: 20,
    platformId: c.id,
    fileType: c.fileType,
    driveMsId: 'drive-1',
    name: `Doc ${c.id}`,
    hasUncommittedChanges: true,
  });
  api.getDocumentChanges.mockResolvedValue({
    rows:
      declineReason === null
        ? [
            {
              ...BASE_ROW,
              eventId: `evt-${c.id}`,
              anchorProviderId: c.anchor,
              containerProviderId: c.slide,
              fromValue: { v: c.from },
              toValue: { v: c.to },
            },
          ]
        : [],
    truncated: false,
    declineReason,
    windowStart: '2026-09-01T00:00:00.000Z',
    nextCursor: null,
  });
}

function expectDocumentLane(api: Api, c: DocCase) {
  expect(api.getDocumentChanges).toHaveBeenCalledWith(c.id);
  expect(api.getUnattributedChangesPaginated).not.toHaveBeenCalled();
}

describe.each(DOCUMENT_CASES)('ENG-6431 — a $fileType file', (c) => {
  it('the changes resource serves its document rows as JSON', async () => {
    const api = createMockApiClient();
    documentFile(api, c);
    const served = JSON.parse((await resource(api)(c.id)).contents[0].text);
    expectDocumentLane(api, c);
    expect(served.rows[0].anchorProviderId).toBe(c.anchor);
    expect(served.rows[0].toValue).toEqual({ v: c.to });
  });

  it('summarize-file-changes renders its document rows', async () => {
    const api = createMockApiClient();
    documentFile(api, c);
    const text = await prompt(api, 'summarize-file-changes')(c.id);
    expectDocumentLane(api, c);
    expect(text).toContain(c.anchor);
    expect(text).toContain(`"${c.from}" → "${c.to}"`);
  });

  it('file-overview counts its document rows', async () => {
    const api = createMockApiClient();
    documentFile(api, c);
    const text = await prompt(api, 'file-overview')(c.id);
    expectDocumentLane(api, c);
    expect(text).toContain('## Unattributed Changes: 1\n');
  });

  it('a WITHHELD window throws on the resource instead of serving an empty one', async () => {
    const api = createMockApiClient();
    documentFile(api, c, 'no_capture_lane');
    await expect(resource(api)(c.id)).rejects.toThrow(
      DOCUMENT_CHANGES_UNAVAILABLE_MARKER,
    );
    expect(api.getDocumentChanges).toHaveBeenCalledWith(c.id);
  });

  it.each(['summarize-file-changes', 'file-overview'])(
    'a WITHHELD window is named by %s, never rendered as zero',
    async (name) => {
      const api = createMockApiClient();
      documentFile(api, c, 'no_capture_lane');
      const text = await prompt(api, name)(c.id);
      expect(api.getDocumentChanges).toHaveBeenCalledWith(c.id);
      expect(text).toContain(DOCUMENT_CHANGES_UNAVAILABLE_MARKER);
      expect(text).toContain('"declineReason":"no_capture_lane"');
      expect(text).toContain('## Unattributed Changes: unavailable');
    },
  );
});

describe('ENG-6431 — a workbook still reads the paginated spreadsheet lane', () => {
  it('the changes resource serves the paginated envelope', async () => {
    const api = createMockApiClient();
    const served = JSON.parse((await resource(api)('file-1')).contents[0].text);
    expect(api.getUnattributedChangesPaginated).toHaveBeenCalledWith('file-1');
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
    expect(served.changes[0].id).toBe(501);
  });

  it('summarize-file-changes renders the cell row', async () => {
    const api = createMockApiClient();
    const text = await prompt(api, 'summarize-file-changes')('file-1');
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
    expect(text).toContain('## Unattributed Changes (1 total)');
    expect(text).toContain('- **Sheet1!A1**: 1 → 2 — by ms-user-1 — 2026-01-01T00:00:00Z');
  });

  // ENG-6917 — the prompt printed every row as a raw cell edit, so a sheet
  // reorder read `Budget!: {"t":"n","v":0} → {"t":"n","v":2}`. It now uses the
  // tool's shared row vocabulary, so both say the same line.
  it('summarize-file-changes says a sheet reorder in the shared words', async () => {
    const api = createMockApiClient();
    api.getUnattributedChangesPaginated.mockResolvedValue({
      changes: [
        {
          id: 502,
          changeType: 'sheet_reorder',
          sheetName: 'Budget',
          cellAddress: '',
          oldValue: { t: 'n', v: 0 },
          newValue: { t: 'n', v: 2 },
          byUserPlatformId: 'ms-user-1',
          byUserName: 'Ada',
          createdAt: '2026-09-15T10:00:00.000Z',
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    const text = await prompt(api, 'summarize-file-changes')('file-1');
    expect(text).toContain(
      '## Unattributed Changes (1 total)\n' +
        '- **Budget!** (sheet moved): position 1 → 3 — by Ada — 2026-09-15T10:00:00.000Z',
    );
    expect(text).not.toContain('{"t":"n"');
  });

  it('file-overview reports the file total', async () => {
    const api = createMockApiClient();
    const text = await prompt(api, 'file-overview')('file-1');
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
    expect(text).toContain('## Unattributed Changes: 1\n');
  });
});

describe('ENG-6431 — a file type this build does not know', () => {
  it('throws on the resource and is named by the prompts', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue({
      internalId: 30,
      platformId: 'file-x',
      fileType: 'future_format',
      driveMsId: 'drive-1',
      name: 'Mystery',
      hasUncommittedChanges: true,
    });
    await expect(resource(api)('file-x')).rejects.toThrow('unknown_file_type');
    const text = await prompt(api, 'file-overview')('file-x');
    expect(text).toContain('"reason":"unknown_file_type"');
    expect(api.getUnattributedChangesPaginated).not.toHaveBeenCalled();
  });
});
