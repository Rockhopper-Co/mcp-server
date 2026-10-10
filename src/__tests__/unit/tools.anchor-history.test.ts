// ENG-6433 — `get_cell_history` could address only a spreadsheet cell, so an
// assistant that listed a Word paragraph's or a slide shape's change (named by
// `anchorProviderId`) had no way to follow that element back through history.
// The tool now takes EXACTLY ONE address: a sheet + cell, or an anchorId.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

type Api = ReturnType<typeof createMockApiClient>;

const registration = (api: Api) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_cell_history',
  )!;
};

const schemaOf = (api: Api) =>
  registration(api)[1].inputSchema as {
    safeParse: (v: unknown) => { success: boolean };
  };

const PARAGRAPH = 'w14-paraId-7A3B';

const row = (eventId: string, from: string, to: string) => ({
  eventId,
  kind: 'block',
  containerProviderId: null,
  anchorProviderId: PARAGRAPH,
  anchorLabel: null,
  changeKind: 'block_edit',
  editorPlatformId: 'u-1',
  occurredAt: `2026-09-1${eventId.slice(-1)}T10:00:00.000Z`,
  firstObservedAt: '2026-09-10T10:00:01.000Z',
  fromValue: { v: from },
  toValue: { v: to },
  truncated: false,
  boundVersionId: eventId === '48122' ? 101 : null,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  documentType: 'text',
  anchorId: PARAGRAPH,
  anchorLane: 'both',
  anchorIdentity: 'provider_id',
  history: [row('48122', 'Net 30 days', 'Net 45 days'), row('48127', 'Net 45 days', 'Net 60 days')],
  truncated: false,
  ...over,
});

const withAnchorApi = () => {
  const api = createMockApiClient();
  (api as unknown as { getAnchorHistory: unknown }).getAnchorHistory = vi
    .fn()
    .mockResolvedValue(envelope());
  return api as Api & { getAnchorHistory: ReturnType<typeof vi.fn> };
};

describe('get_cell_history input — exactly one address form', () => {
  const api = createMockApiClient();

  it('accepts a sheet and a cell', () => {
    expect(
      schemaOf(api).safeParse({ fileMsId: 'f', sheetName: 'S', cellAddress: 'A1' })
        .success,
    ).toBe(true);
  });

  it('accepts an anchorId on its own', () => {
    expect(
      schemaOf(api).safeParse({ fileMsId: 'f', anchorId: PARAGRAPH }).success,
    ).toBe(true);
  });

  it('rejects an anchorId sent with a cell address', () => {
    expect(
      schemaOf(api).safeParse({
        fileMsId: 'f',
        sheetName: 'S',
        cellAddress: 'A1',
        anchorId: PARAGRAPH,
      }).success,
    ).toBe(false);
  });

  it('rejects half a cell address, and no address at all', () => {
    const s = schemaOf(api);
    expect(s.safeParse({ fileMsId: 'f', sheetName: 'S' }).success).toBe(false);
    expect(s.safeParse({ fileMsId: 'f', cellAddress: 'A1' }).success).toBe(false);
    expect(
      s.safeParse({ fileMsId: 'f', sheetName: 'S', anchorId: PARAGRAPH }).success,
    ).toBe(false);
    expect(s.safeParse({ fileMsId: 'f' }).success).toBe(false);
  });
});

describe('get_cell_history — one document element by anchorId', () => {
  it('reads that anchor and renders its rows by identity, in order', async () => {
    const api = withAnchorApi();
    const result = await registration(api)[2]({ fileMsId: 'file-docx', anchorId: PARAGRAPH });

    expect(api.getAnchorHistory).toHaveBeenCalledWith(
      'file-docx',
      PARAGRAPH,
      expect.objectContaining({ onFreshness: expect.any(Function) }),
    );
    expect(api.getCellHistory).not.toHaveBeenCalled();
    const text = result.content[0].text as string;
    expect(result.isError).toBeFalsy();
    expect(text).toContain(PARAGRAPH);
    expect(text).toContain('2 change(s)');
    // Both rows, by their own text, oldest first.
    expect(text.indexOf('"Net 30 days"')).toBeGreaterThan(-1);
    expect(text.indexOf('"Net 60 days"')).toBeGreaterThan(text.indexOf('"Net 30 days"'));
  });

  it('says which lane a deck answer covers, as a fact about the result', async () => {
    const api = withAnchorApi();
    api.getAnchorHistory.mockResolvedValue(
      envelope({ documentType: 'presentation', anchorLane: 'task_pane' }),
    );
    const result = await registration(api)[2]({ fileMsId: 'file-pptx', anchorId: 'shape-9' });
    expect(result.content[0].text).toContain('not the whole history of the shape');
  });

  it('renders an empty anchor history as about that element only', async () => {
    const api = withAnchorApi();
    api.getAnchorHistory.mockResolvedValue(envelope({ anchorId: 'nope', history: [], anchorIdentity: null }));
    const result = await registration(api)[2]({ fileMsId: 'file-docx', anchorId: 'nope' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No change recorded for element "nope"');
    expect(result.content[0].text).toContain('never grounds for saying the file is unchanged');
  });

  it('refuses by code when the backend cannot answer for this anchor', async () => {
    const api = withAnchorApi();
    api.getAnchorHistory.mockRejectedValue(
      new RockhopperApiError(422, 'Rockhopper API 422', 'CELL_HISTORY_UNAVAILABLE', null),
    );
    const result = await registration(api)[2]({ fileMsId: 'file-1', anchorId: PARAGRAPH });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('"code":"CELL_HISTORY_UNAVAILABLE"');
    expect(text).toContain(`"anchorId":"${PARAGRAPH}"`);
    expect(text).not.toContain('No change recorded');
  });
});

describe('ApiClient.getAnchorHistory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the SAME cell-history route for the anchor, in the mcp format, with no cell', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ApiClient({ baseUrl: 'https://api.rockhopper.co', token: 'rh_pat_x' });

    const got = await client.getAnchorHistory('file-docx', PARAGRAPH);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/file-versions/file/file-docx/cell-history');
    expect(url.searchParams.get('anchorId')).toBe(PARAGRAPH);
    expect(url.searchParams.get('format')).toBe('mcp');
    expect(url.searchParams.has('cell')).toBe(false);
    expect(got.history.map((h) => h.eventId)).toEqual(['48122', '48127']);
  });
});
