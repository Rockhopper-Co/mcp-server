import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { registerPrompts } from '../../prompts/index.js';
import { registerResources } from '../../resources/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

// ENG-4349 — every mcp-server surface that renders a stored comment body.
// The stored mention token carries an internal user id and an email address
// (`backend/src/helpers/strings.ts:37`), so a surface that interpolates
// `c.message` verbatim hands the workspace's mention graph to the model.
const MENTION =
  '@{{"id":"u-7","displayName":"Sebastian Perez Lawrence", "email":"sebastian@rockhopper.co"}}';
const BODY = `${MENTION} can you review these changes?`;

const EMAIL_SHAPED = /[\w.+-]+@[\w-]+\.[\w.]+/;

function commentFixture(over: Record<string, unknown> = {}) {
  return {
    internalId: 201,
    message: BODY,
    source: 'rockhopper',
    cellReference: "'Project Accruals'!BS7",
    resolved: false,
    // The author's own name resolves, so nothing else in the line supplies an
    // address — any email in the output came out of the message body.
    authorName: 'Sebastian Perez Lawrence',
    authorEmail: null,
    createdAt: '2026-02-17T19:03:35.000Z',
    updatedAt: '2026-02-17T19:03:35.000Z',
    editedOn: null,
    replies: [],
    ...over,
  };
}

function handlerFor(
  server: ReturnType<typeof createMockMcpServer>,
  kind: 'registerTool' | 'registerPrompt' | 'registerResource',
  name: string,
) {
  return server[kind].mock.calls.find((c) => c[0] === name)?.[2] as (
    ...args: any[]
  ) => Promise<any>;
}

describe('comment mention rendering across surfaces (ENG-4349)', () => {
  it('get_file_comments renders the display name and leaks no address', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([commentFixture()]);
    registerTools(server as any, api as any);

    const text = (
      await handlerFor(server, 'registerTool', 'get_file_comments')({
        fileMsId: 'file-1',
      })
    ).content[0].text;

    expect(text).toContain('@Sebastian Perez Lawrence can you review these changes?');
    expect(text).not.toMatch(/@\{\{/);
    expect(text).not.toMatch(EMAIL_SHAPED);
    expect(text).not.toContain('u-7');
  });

  it('get_file_comments renders mentions inside nested replies too', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([
      commentFixture({
        message: 'parent line',
        replies: [commentFixture({ internalId: 202 })],
      }),
    ]);
    registerTools(server as any, api as any);

    const text = (
      await handlerFor(server, 'registerTool', 'get_file_comments')({
        fileMsId: 'file-1',
      })
    ).content[0].text;

    expect(text).toContain('@Sebastian Perez Lawrence');
    expect(text).not.toMatch(/@\{\{/);
    expect(text).not.toMatch(EMAIL_SHAPED);
  });

  it('the unresolved-comments prompt renders the display name and leaks no address', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([commentFixture()]);
    registerPrompts(server as any, api as any);

    const text = (
      await handlerFor(server, 'registerPrompt', 'unresolved-comments')({
        fileMsId: 'file-1',
      })
    ).messages[0].content.text;

    expect(text).toContain('@Sebastian Perez Lawrence');
    expect(text).not.toMatch(/@\{\{/);
    expect(text).not.toMatch(EMAIL_SHAPED);
  });

  it('the file-comments resource renders the display name and leaks no address', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.getFileComments.mockResolvedValue([commentFixture()]);
    registerResources(server as any, api as any);

    const handler = server.registerResource.mock.calls.find(
      (c) => c[0] === 'file-comments',
    )?.[3] as (uri: URL, vars: Record<string, unknown>) => Promise<any>;
    const result = await handler(
      new URL('rockhopper://files/file-1/comments'),
      { fileMsId: 'file-1' },
    );
    const text = result.contents[0].text;

    expect(text).toContain('Sebastian Perez Lawrence can you review these changes?');
    expect(text).not.toContain('@{{');
    expect(text).not.toMatch(EMAIL_SHAPED);
    expect(text).not.toContain('u-7');
  });

  it('add_comment echoes a rendered body, not the stored token', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.createComment.mockResolvedValue({
      internalId: 301,
      message: BODY,
      cellReference: 'Sheet1!A1',
    });
    registerTools(server as any, api as any, { scope: 'read-write' });

    const text = (
      await handlerFor(server, 'registerTool', 'add_comment')({
        fileMsId: 'file-1',
        message: BODY,
      })
    ).content[0].text;

    expect(text).toContain('@Sebastian Perez Lawrence');
    expect(text).not.toMatch(/@\{\{/);
    expect(text).not.toMatch(EMAIL_SHAPED);
  });

  it('reply_to_comment echoes a rendered body, not the stored token', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    api.replyToComment.mockResolvedValue({ internalId: 302, message: BODY });
    registerTools(server as any, api as any, { scope: 'read-write' });

    const text = (
      await handlerFor(server, 'registerTool', 'reply_to_comment')({
        chatId: 201,
        message: BODY,
        versionInternalId: 101,
      })
    ).content[0].text;

    expect(text).toContain('@Sebastian Perez Lawrence');
    expect(text).not.toMatch(/@\{\{/);
    expect(text).not.toMatch(EMAIL_SHAPED);
  });
});
