import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-5397 — `get_unattributed_changes` answered a Word document and a
 * PowerPoint deck with "No unattributed changes found for this file."
 *
 * That sentence was produced by a reader that cannot see a document's rows AT
 * ALL. `unattributed_change` is a spreadsheet-only table — its `sheetName`
 * column is NOT NULL and the sheet route additionally filters
 * `changeType = 'cell'` — so both routes the client called returned `[]` for a
 * `.docx` by construction, every time, forever. The customer was told their
 * file was clean.
 *
 * ## WHY EVERY ASSERTION HERE IS POSITIVE, BY IDENTITY
 *
 * The defect IS an empty list. So `expect(rows).toHaveLength(0)` and
 * `expect(text).not.toContain('change')` both PASS on the broken behaviour —
 * they are satisfied by a tool that has learned nothing and said nothing. Every
 * test below therefore names the thing that must be PRESENT: the refusal
 * marker, its reason code, or a specific row rendered by its anchor id.
 *
 * The same rule kills the tempting `expect(result.isError).toBe(true)` on its
 * own: a tool that refuses for the WRONG reason passes it. Each refusal is
 * pinned to its REASON, so adding a new earlier refusal cannot silently
 * re-point these at a clause they were not written for.
 */

function handlerFor(api: ReturnType<typeof createMockApiClient>, name: string) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find((c) => c[0] === name)?.[2];
}

function changesHandler(api: ReturnType<typeof createMockApiClient>) {
  return handlerFor(api, 'get_unattributed_changes');
}

/** A `.docx`. The fixture's default file is a workbook. */
function wordFile(api: ReturnType<typeof createMockApiClient>) {
  api.getEnrolledFile.mockResolvedValue({
    internalId: 12,
    platformId: 'file-doc',
    fileType: 'microsoft_docx',
    driveMsId: 'drive-1',
    name: 'Contract.docx',
    hasUncommittedChanges: true,
  });
}

function deckFile(api: ReturnType<typeof createMockApiClient>) {
  api.getEnrolledFile.mockResolvedValue({
    internalId: 13,
    platformId: 'file-deck',
    fileType: 'microsoft_pptx',
    driveMsId: 'drive-1',
    name: 'Board.pptx',
    hasUncommittedChanges: true,
  });
}

function googleDoc(api: ReturnType<typeof createMockApiClient>) {
  api.getEnrolledFile.mockResolvedValue({
    internalId: 14,
    platformId: 'file-gdoc',
    fileType: 'google_doc',
    driveMsId: 'drive-1',
    name: 'Notes',
    hasUncommittedChanges: true,
  });
}

/** One served paragraph change, shaped as the backend's row contract. */
const PARAGRAPH_ROW = {
  eventId: '48122',
  kind: 'block',
  locationKind: 'block',
  containerOrdinal: null,
  containerProviderId: null,
  anchorOrdinal: 4,
  anchorProviderId: 'w14-paraId-7A3B',
  anchorLabel: null,
  changeKind: 'block_edit',
  actorKind: 'human',
  actorPlatformId: 'ms-user-1',
  attributionConfidence: 'credential_bound',
  editorPlatformId: 'ms-user-1',
  occurredAt: '2026-09-15T10:00:00.000Z',
  firstObservedAt: '2026-09-15T10:00:01.000Z',
  fromValue: { v: 'Net 30 days' },
  toValue: { v: 'Net 60 days' },
  truncated: false,
};

const SHAPE_ROW = {
  eventId: '48130',
  kind: 'shape',
  locationKind: 'shape',
  containerOrdinal: null,
  containerProviderId: 'slide-id-9',
  anchorOrdinal: 2,
  anchorProviderId: 'slide-id-9::12',
  anchorLabel: 'Title 1',
  changeKind: 'shape_edit',
  actorKind: 'human',
  actorPlatformId: 'ms-user-2',
  attributionConfidence: 'credential_bound',
  editorPlatformId: 'ms-user-2',
  occurredAt: '2026-09-15T11:00:00.000Z',
  firstObservedAt: '2026-09-15T11:00:01.000Z',
  fromValue: { v: 'Q3 Results' },
  toValue: { v: 'Q4 Results' },
  truncated: false,
};

function served(rows: unknown[], declineReason: string | null = null) {
  return {
    rows,
    truncated: false,
    declineReason,
    windowStart: '2026-09-01T00:00:00.000Z',
  };
}

describe('get_unattributed_changes on a document', () => {
  it('returns the paragraph rows a Word document actually has (ENG-5397)', async () => {
    const api = createMockApiClient();
    wordFile(api);
    api.getDocumentChanges.mockResolvedValue(served([PARAGRAPH_ROW]));

    const result = await changesHandler(api)({ fileMsId: 'file-doc' });
    const text = result.content[0].text as string;

    // The row, by its own identity — not a count, and not "is not empty".
    expect(text).toContain('w14-paraId-7A3B');
    expect(text).toContain('Net 30 days');
    expect(text).toContain('Net 60 days');
    expect(result.isError).toBeFalsy();
  });

  it('reads the DOCUMENT lane and never the spreadsheet one', async () => {
    const api = createMockApiClient();
    wordFile(api);
    api.getDocumentChanges.mockResolvedValue(served([PARAGRAPH_ROW]));

    await changesHandler(api)({ fileMsId: 'file-doc' });

    expect(api.getDocumentChanges).toHaveBeenCalledWith('file-doc');
    // The spreadsheet reader answers `[]` for a document by construction, so
    // calling it at all is how the wrong negative was produced.
    expect(api.getUnattributedChangesPaginated).not.toHaveBeenCalled();
    expect(api.getUnattributedChangesBySheet).not.toHaveBeenCalled();
  });

  it('returns the shape rows a deck actually has, naming the slide by its id', async () => {
    const api = createMockApiClient();
    deckFile(api);
    api.getDocumentChanges.mockResolvedValue(served([SHAPE_ROW]));

    const text = (await changesHandler(api)({ fileMsId: 'file-deck' }))
      .content[0].text as string;

    expect(text).toContain('slide-id-9');
    expect(text).toContain('Q3 Results');
    expect(text).toContain('Q4 Results');
  });

  it('REFUSES a withheld deck window, naming the decline reason', async () => {
    const api = createMockApiClient();
    deckFile(api);
    api.getDocumentChanges.mockResolvedValue(
      served([], 'presentation_structural_unrebased'),
    );

    const result = await changesHandler(api)({ fileMsId: 'file-deck' });
    const text = result.content[0].text as string;

    // Pinned to the REASON, so a different refusal cannot satisfy this test.
    expect(text).toContain('DOCUMENT_CHANGES_UNAVAILABLE');
    expect(text).toContain('presentation_structural_unrebased');
    expect(result.isError).toBe(true);
  });

  it('REFUSES a Google Doc, which has no capture lane at all', async () => {
    const api = createMockApiClient();
    googleDoc(api);
    api.getDocumentChanges.mockResolvedValue(served([]));

    const result = await changesHandler(api)({ fileMsId: 'file-gdoc' });
    const text = result.content[0].text as string;

    expect(text).toContain('DOCUMENT_CHANGES_UNAVAILABLE');
    expect(text).toContain('no_capture_lane');
    expect(result.isError).toBe(true);
  });

  it('REFUSES a file type it does not recognise instead of guessing', async () => {
    const api = createMockApiClient();
    api.getEnrolledFile.mockResolvedValue({
      internalId: 15,
      platformId: 'file-x',
      fileType: 'microsoft_vsdx',
      driveMsId: 'drive-1',
      name: 'Diagram.vsdx',
      hasUncommittedChanges: true,
    });

    const result = await changesHandler(api)({ fileMsId: 'file-x' });
    const text = result.content[0].text as string;

    expect(text).toContain('DOCUMENT_CHANGES_UNAVAILABLE');
    expect(text).toContain('unknown_file_type');
    expect(result.isError).toBe(true);
  });

  it('REFUSES a sheetName on a document rather than ignoring it', async () => {
    const api = createMockApiClient();
    wordFile(api);
    api.getDocumentChanges.mockResolvedValue(served([PARAGRAPH_ROW]));

    const result = await changesHandler(api)({
      fileMsId: 'file-doc',
      sheetName: 'Summary',
    });
    const text = result.content[0].text as string;

    expect(text).toContain('DOCUMENT_CHANGES_UNAVAILABLE');
    expect(text).toContain('sheet_filter_not_applicable');
    expect(result.isError).toBe(true);
    // A refusal must leave the read undone, or it is a warning, not a refusal.
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
  });

  it('says the window was truncated when more rows exist than were served', async () => {
    const api = createMockApiClient();
    wordFile(api);
    api.getDocumentChanges.mockResolvedValue({
      rows: [PARAGRAPH_ROW],
      truncated: true,
      declineReason: null,
      windowStart: '2026-09-01T00:00:00.000Z',
    });

    const text = (await changesHandler(api)({ fileMsId: 'file-doc' }))
      .content[0].text as string;

    expect(text).toContain('w14-paraId-7A3B');
    expect(text.toLowerCase()).toContain('more');
  });

  /**
   * An honest zero on a Microsoft document IS allowed — the capture lane exists
   * and the window was served and was empty. What must never happen is that
   * sentence arriving from a reader that could not have seen a row.
   *
   * Asserted positively: the answer must NAME the window it covers, which a
   * blind "none found" never could.
   */
  it('reports a served-and-empty Word window as such, naming the window', async () => {
    const api = createMockApiClient();
    wordFile(api);
    api.getDocumentChanges.mockResolvedValue(served([]));

    const result = await changesHandler(api)({ fileMsId: 'file-doc' });
    const text = result.content[0].text as string;

    expect(text).toContain('2026-09-01');
    expect(result.isError).toBeFalsy();
  });

  it('still refuses a document while its enrolment read has not landed', async () => {
    const api = createMockApiClient();
    wordFile(api);
    api.getFileVersions.mockResolvedValue([]);
    api.getDocumentChanges.mockResolvedValue(served([]));

    const result = await changesHandler(api)({ fileMsId: 'file-doc' });
    const text = result.content[0].text as string;

    expect(text).toContain('CHANGE_HISTORY_NOT_READY');
    expect(text).toContain('enrollment_incomplete');
    expect(result.isError).toBe(true);
  });
});

describe('get_unattributed_changes on a spreadsheet is unchanged', () => {
  it('still reads the paginated spreadsheet lane', async () => {
    const api = createMockApiClient();
    api.getUnattributedChangesPaginated.mockResolvedValue({
      changes: [
        {
          sheetName: 'Summary',
          cellAddress: 'B4',
          changeType: 'cell',
          oldValue: 1,
          newValue: 2,
          byUserPlatformId: 'ms-user-1',
          byUserName: 'Grace Hopper',
          createdAt: '2026-09-15T10:00:00.000Z',
        },
      ],
      totalCount: 1,
      nextCursor: null,
    });

    const text = (await changesHandler(api)({ fileMsId: 'file-1' })).content[0]
      .text as string;

    expect(text).toContain('Summary!B4');
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
  });

  it('still serves the sheet-filtered spreadsheet mode', async () => {
    const api = createMockApiClient();
    api.getUnattributedChangesBySheet.mockResolvedValue([
      {
        sheetName: 'Summary',
        cellAddress: 'C9',
        changeType: 'cell',
        oldValue: 'a',
        newValue: 'b',
        byUserPlatformId: 'ms-user-1',
        createdAt: '2026-09-15T10:00:00.000Z',
      },
    ]);

    const text = (
      await changesHandler(api)({ fileMsId: 'file-1', sheetName: 'Summary' })
    ).content[0].text as string;

    expect(text).toContain('Summary!C9');
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
  });
});
