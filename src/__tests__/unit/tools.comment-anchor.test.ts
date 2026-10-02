import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';
import { registerPrompts } from '../../prompts/index.js';
import { registerTools } from '../../tools/index.js';
import { captureCatalogue } from '../goldens/tool-catalogue.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-6435 — `add_comment` pins a comment to a paragraph, slide or shape, and
 * every comment reader says where an existing one is pinned. The backend has
 * accepted `anchor` on POST /file-chat and returned it on GET since ENG-3294;
 * this client neither sent nor rendered it.
 */

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

function toolHandler(
  api: ReturnType<typeof createMockApiClient> | ApiClient,
  name: string,
): Handler {
  const server = createMockMcpServer();
  registerTools(server as never, api as never, { scope: 'read-write' });
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`${name} not registered`);
  return call[2] as Handler;
}

const paragraphAnchor = {
  anchorKind: 'block',
  providerAnchorId: '1A2B3C4D',
  observedVersionInternalId: 77,
};

const resolved = (over: Record<string, unknown>) => ({
  anchorStableId: 'a-uuid',
  locationKind: null,
  containerStableId: null,
  subLocator: null,
  observedVersionInternalId: 77,
  presentInLatestCommitted: null,
  latestCommittedVersionId: null,
  ...over,
});

const comment = (anchor: Record<string, unknown>, message: string) => ({
  internalId: 5,
  message,
  cellReference: null,
  resolved: false,
  authorName: 'Alice',
  authorEmail: null,
  createdAt: '2026-09-28T00:00:00Z',
  anchor,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('add_comment anchor (write)', () => {
  it('forwards anchor, observedVersionInternalId included, to the API', async () => {
    const api = createMockApiClient();
    const handler = toolHandler(api, 'add_comment');
    const result = await handler({
      fileMsId: 'doc-1',
      message: 'Tighten this paragraph',
      versionInternalId: 77,
      anchor: paragraphAnchor,
    });
    expect(result.isError).toBeUndefined();
    expect(api.createComment).toHaveBeenCalledWith({
      fileMsId: 'doc-1',
      message: 'Tighten this paragraph',
      cellReference: undefined,
      versionInternalId: 77,
      anchor: paragraphAnchor,
    });
  });

  it('puts anchor in the POST body; without one the body is unchanged', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ internalId: 1, message: 'm' }), {
        status: 200,
      });
    });
    const client = new ApiClient({ baseUrl: 'https://x', token: 't' });
    await client.createComment({
      fileMsId: 'f',
      message: 'm',
      cellReference: 'Sheet1!A1',
      versionInternalId: 3,
    });
    await client.createComment({
      fileMsId: 'f',
      message: 'm',
      versionInternalId: 3,
      anchor: paragraphAnchor,
    } as never);
    expect(bodies[0]).toBe(
      '{"fileMsId":"f","message":"m","cellReference":"Sheet1!A1","versionInternalId":3}',
    );
    expect(JSON.parse(bodies[1]).anchor).toEqual(paragraphAnchor);
  });

  it('a backend 400 for an anchor on a spreadsheet is an isError naming cellReference', async () => {
    const refusal =
      'Spreadsheet comments are not anchored through document_anchor. ' +
      'Use cellReference, which remains the spreadsheet anchor.';
    // Refuses ONLY when the anchor reached the wire, as the backend does — so
    // this cannot pass on a client that drops the anchor.
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) =>
      'anchor' in JSON.parse(String(init.body))
        ? new Response(JSON.stringify({ statusCode: 400, message: refusal }), {
            status: 400,
            statusText: 'Bad Request',
          })
        : new Response(JSON.stringify({ internalId: 1, message: 'm' }), {
            status: 200,
          }),
    );
    const handler = toolHandler(
      new ApiClient({ baseUrl: 'https://x', token: 't' }),
      'add_comment',
    );
    const result = await handler({
      fileMsId: 'xlsx-1',
      message: 'm',
      versionInternalId: 3,
      anchor: paragraphAnchor,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cellReference');
  });

  it.each(['oslide:256', 'oslide:256/oshape:7'])(
    'refuses a task-pane PowerPoint id (%s) without calling the API',
    async (providerAnchorId) => {
      const api = createMockApiClient();
      const handler = toolHandler(api, 'add_comment');
      const result = await handler({
        fileMsId: 'deck-1',
        message: 'm',
        versionInternalId: 3,
        anchor: { anchorKind: 'shape', providerAnchorId },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(providerAnchorId);
      expect(api.createComment).not.toHaveBeenCalled();
    },
  );

  it('publishes an anchor schema with no exclusiveMinimum, type array or $ref', async () => {
    const tools = await captureCatalogue({ scope: 'read-write' });
    const addComment = tools.find((t) => t.name === 'add_comment');
    const schema = addComment?.inputSchema as {
      properties: Record<string, unknown>;
    };
    const anchor = JSON.stringify(schema.properties.anchor);
    expect(anchor).toContain('observedVersionInternalId');
    expect(anchor).toContain('providerAnchorId');
    expect(anchor).not.toContain('exclusiveMinimum');
    expect(anchor).not.toMatch(/"type":\[/);
    expect(anchor).not.toContain('$ref');
  });
});

describe('comment location (read)', () => {
  const paragraph = comment(
    resolved({ anchorKind: 'block', providerAnchorId: '1A2B3C4D' }),
    'on a paragraph',
  );
  const shape = comment(
    resolved({ anchorKind: 'shape', providerAnchorId: 'slide:256/shape:7' }),
    'on a shape',
  );

  it('get_file_comments prints a paragraph and a shape anchor in the location slot', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([paragraph, shape]);
    const text = (await toolHandler(api, 'get_file_comments')({ fileMsId: 'd' }))
      .content[0].text;
    expect(text).toContain('**Alice** [paragraph 1A2B3C4D]: on a paragraph');
    expect(text).toContain('**Alice** [shape slide:256/shape:7]: on a shape');
  });

  it('the unresolved-comments prompt prints the same location', async () => {
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([paragraph, shape]);
    const server = createMockMcpServer();
    registerPrompts(server as never, api as never);
    const call = server.registerPrompt.mock.calls.find(
      (c) => c[0] === 'unresolved-comments',
    );
    const result = await (call?.[2] as Handler)({ fileMsId: 'd' });
    const text = (result as unknown as {
      messages: { content: { text: string } }[];
    }).messages[0].content.text;
    expect(text).toContain('**Alice** [paragraph 1A2B3C4D]: "on a paragraph"');
    expect(text).toContain('**Alice** [shape slide:256/shape:7]: "on a shape"');
  });
});
