import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { registerResources } from '../../resources/index.js';
import { registerPrompts } from '../../prompts/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';
import {
  ChangeHistoryNotReadyError,
  NOT_READY_MARKER,
  isNotReady,
} from '../../not-ready.js';

/**
 * Plan 02 ruling 5 (David, 2026-08-04) — STRICT no-partial on the machine
 * surfaces. Nothing here serves change history until it is complete: an
 * assistant reading this server gets rows or an explicit refusal, never an
 * empty list that reads as "nothing changed".
 *
 * The refusal must be impossible to mistake for data, because the consumer is
 * Claude Desktop / Cursor summarising the answer as fact — there is no banner
 * and no human in the loop.
 */

const PENDING_FOLD = {
  fileMsId: 'file-1',
  foldPending: true,
  foldTargetVersionId: 909,
  checkedAt: '2026-08-04T00:00:00.000Z',
};

const notReadyFromBackend = (): ChangeHistoryNotReadyError =>
  new ChangeHistoryNotReadyError({
    reason: 'still_producing',
    retryAfterSeconds: 42,
    fileMsId: 'file-1',
  });

const toolHandler = (
  api: ReturnType<typeof createMockApiClient>,
  name: string,
) => {
  const server = createMockMcpServer();
  registerTools(server as never, api as never);
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  return call?.[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

const resourceHandler = (api: ReturnType<typeof createMockApiClient>) => {
  const server = createMockMcpServer();
  registerResources(server as never, api as never);
  const call = server.registerResource.mock.calls.find(
    (c) => c[0] === 'unattributed-changes',
  );
  return call?.[3] as (
    uri: { href: string },
    vars: Record<string, unknown>,
  ) => Promise<unknown>;
};

const promptHandler = (
  api: ReturnType<typeof createMockApiClient>,
  name: string,
) => {
  const server = createMockMcpServer();
  registerPrompts(server as never, api as never);
  const call = server.registerPrompt.mock.calls.find((c) => c[0] === name);
  return call?.[2] as (args: Record<string, unknown>) => Promise<unknown>;
};

describe('strict no-partial — change-history surfaces', () => {
  describe('get_cell_history', () => {
    it('refuses to serve rows while a fold is still rewriting the window', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      const result = await toolHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });

      expect(api.getCellHistory).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(NOT_READY_MARKER);
      expect(result.content[0].text).toContain('change_history_incomplete');
    });

    it('never claims "no history" without proving completeness', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);
      api.getCellHistory.mockResolvedValue([]);

      const result = await toolHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });

      expect(result.content[0].text).not.toContain('No history found');
    });

    it('fails CLOSED when the completeness probe itself cannot answer', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockRejectedValue(new Error('ECONNRESET'));

      const result = await toolHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });

      expect(api.getCellHistory).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('completeness_unknown');
    });

    it('serves rows when the fold is complete', async () => {
      const api = createMockApiClient();
      const result = await toolHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });

      expect(api.getCellHistory).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('1 change(s)');
    });

    it('renders a backend not-ready answer as the typed refusal, not an error string', async () => {
      const api = createMockApiClient();
      api.getCellHistory.mockRejectedValue(notReadyFromBackend());

      const result = await toolHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(NOT_READY_MARKER);
      expect(result.content[0].text).toContain('still_producing');
      expect(result.content[0].text).toContain('42');
      expect(result.content[0].text).not.toContain('Failed to get cell history');
    });
  });

  describe('get_unattributed_changes', () => {
    it('refuses the sheet-filtered mode while a fold is pending', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      const result = await toolHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
      });

      expect(api.getUnattributedChangesBySheet).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(NOT_READY_MARKER);
    });

    it('refuses the file-wide paginated mode while a fold is pending', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      const result = await toolHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
      });

      expect(api.getUnattributedChangesPaginated).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain(
        'No unattributed changes found',
      );
    });

    it('serves rows when the fold is complete', async () => {
      const api = createMockApiClient();
      const result = await toolHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
      });

      expect(api.getUnattributedChangesPaginated).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });
  });

  describe('unattributed-changes resource', () => {
    it('throws rather than returning a partial envelope', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      await expect(
        resourceHandler(api)({ href: 'rockhopper://files/file-1/changes' }, {
          fileMsId: 'file-1',
        }),
      ).rejects.toThrow(NOT_READY_MARKER);
      expect(api.getUnattributedChangesPaginated).not.toHaveBeenCalled();
    });
  });

  describe('prompts', () => {
    it('summarize-file-changes refuses to build a prompt from partial data', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      await expect(
        promptHandler(api, 'summarize-file-changes')({ fileMsId: 'file-1' }),
      ).rejects.toThrow(NOT_READY_MARKER);
    });

    it('file-overview refuses while the change history is incomplete', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      await expect(
        promptHandler(api, 'file-overview')({ fileMsId: 'file-1' }),
      ).rejects.toThrow(NOT_READY_MARKER);
    });
  });

  describe('the refusal payload', () => {
    it('carries a machine-readable status an assistant cannot read as data', async () => {
      const api = createMockApiClient();
      api.getFoldStatus.mockResolvedValue(PENDING_FOLD);

      const result = await toolHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
      });

      const json = result.content[0].text.slice(
        result.content[0].text.indexOf('{'),
      );
      expect(JSON.parse(json)).toEqual({
        status: 'not_ready',
        reason: 'change_history_incomplete',
        retryAfterSeconds: expect.any(Number),
        fileMsId: 'file-1',
      });
      expect(result.content[0].text.toLowerCase()).toContain('not an empty');
    });

    it('isNotReady matches the typed error and an error carrying it as cause', () => {
      const typed = notReadyFromBackend();
      expect(isNotReady(typed)).toBe(true);
      expect(isNotReady(new Error('wrapped', { cause: typed }))).toBe(true);
      expect(isNotReady(new Error('plain'))).toBe(false);
    });
  });

  describe('api-client classification', () => {
    it('turns a 429 + Retry-After into the typed not-ready error', async () => {
      const { ApiClient } = await import('../../api-client.js');
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'Retry-After': '90' }),
        text: () => Promise.resolve('producing'),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new ApiClient({
        baseUrl: 'https://api.test',
        token: 't',
      });
      const err = await client
        .getFoldStatus('file-1')
        .then(() => null)
        .catch((e: unknown) => e);

      expect(isNotReady(err)).toBe(true);
      expect((err as ChangeHistoryNotReadyError).retryAfterSeconds).toBe(90);
      vi.unstubAllGlobals();
    });
  });
});
