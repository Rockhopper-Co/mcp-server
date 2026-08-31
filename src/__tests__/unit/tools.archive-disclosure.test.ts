import { describe, expect, it } from 'vitest';
import { registerResources } from '../../resources/index.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-3402 (plan 28 / REVIEW F20) — the archive predicate lands inside the
 * SHARED `GET /enrolled-files` query, beside the existing `unenrolledAt IS
 * NULL` at `backend src/resources/enrolled-files/enrolled-files.service.ts:2008`.
 * Every reader of that route loses the caller's archived rows at once: the web
 * file list, `list_files`, `search_files` and the `rockhopper://files`
 * resource.
 *
 * Three of those four are copy this package ships, and all three claimed the
 * list was complete — "List **all** Excel files enrolled", "All Excel files
 * enrolled", and a no-match line that named "never added" as the ONLY reason a
 * file could be missing. That is the defect: not the exclusion, which David
 * ruled correct, but a description that keeps overclaiming after the query
 * narrowed. An agent reading it tells a customer they have no such file about
 * a file that exists, is enrolled, and is visible to every teammate.
 *
 * David, 2026-08-25 (REVIEW decision 6, option (a)): archive is a WEB-ONLY
 * affordance. Agents neither archive nor restore. So the fix is disclosure,
 * not tools — and the last spec here pins the "no tools" half, because adding
 * one reds `mcp-gateway`'s `scope-challenge.e2e.test.ts` before anyone touches
 * that repo (`mcp-gateway src/scope-challenge.ts:55-61`).
 *
 * Assertions are on SUBSTANCE — "does this text disclose the exclusion and
 * name the way back" — not on exact wording, so the copy can be improved
 * without a spec edit. What they will not tolerate is silence.
 */

function toolCall(name: string) {
  const server = createMockMcpServer();
  const api = createMockApiClient();
  registerTools(server as any, api as any);
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} is not registered`);
  return { call, api, description: (call[1] as { description: string }).description };
}

function handlerFor(name: string, api: ReturnType<typeof createMockApiClient>) {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} is not registered`);
  return call[2] as (args: any) => Promise<{ content: Array<{ text: string }> }>;
}

describe('ENG-3402 — archive exclusion is disclosed to the model', () => {
  describe('list_files description', () => {
    it('drops the universal claim that it lists ALL enrolled files', () => {
      const { description } = toolCall('list_files');
      expect(description).not.toMatch(/list all excel files enrolled/i);
    });

    it('names the archive exclusion', () => {
      const { description } = toolCall('list_files');
      expect(description).toMatch(/archiv/i);
    });

    it('says an archived file is still enrolled and still visible to teammates', () => {
      const { description } = toolCall('list_files');
      expect(description).toMatch(/still enrolled/i);
      expect(description).toMatch(/teammate|other member|everyone else/i);
    });

    it('names the web app as the only way back, since no tool restores', () => {
      const { description } = toolCall('list_files');
      expect(description).toMatch(/web app/i);
      expect(description).toMatch(/no archive or restore tool/i);
    });
  });

  describe('list_files empty answer', () => {
    it('does not answer a bare negative', async () => {
      const api = createMockApiClient();
      api.listEnrolledFiles.mockResolvedValue([]);
      const result = await handlerFor('list_files', api)({});
      expect(result.content[0].text).not.toBe('No enrolled files found.');
    });

    it('names archive as a reason a file the user expects is absent', async () => {
      const api = createMockApiClient();
      api.listEnrolledFiles.mockResolvedValue([]);
      const result = await handlerFor('list_files', api)({});
      expect(result.content[0].text).toMatch(/archiv/i);
      expect(result.content[0].text).toMatch(/web app/i);
    });

    it('still names the never-added case and its next step', async () => {
      const api = createMockApiClient();
      api.listEnrolledFiles.mockResolvedValue([]);
      const result = await handlerFor('list_files', api)({});
      expect(result.content[0].text).toMatch(/list_unenrolled_files|search_drive_files/);
    });

    it('quotes the search term back when one was given', async () => {
      const api = createMockApiClient();
      api.listEnrolledFiles.mockResolvedValue([]);
      const result = await handlerFor('list_files', api)({ search: 'Becklar' });
      expect(result.content[0].text).toContain('Becklar');
      expect(result.content[0].text).toMatch(/archiv/i);
    });

    it('leaves the non-empty answer alone', async () => {
      const api = createMockApiClient();
      const result = await handlerFor('list_files', api)({});
      expect(result.content[0].text).toMatch(/^Found 2 file\(s\):/);
    });
  });

  describe('search_files', () => {
    it('names the archive exclusion in its description', () => {
      const { description } = toolCall('search_files');
      expect(description).toMatch(/archiv/i);
    });

    it('names archive alongside never-added when nothing matches', async () => {
      const api = createMockApiClient();
      api.listEnrolledFiles.mockResolvedValue([]);
      const result = await handlerFor('search_files', api)({ query: 'Becklar' });
      expect(result.content[0].text).toMatch(/archiv/i);
      // ENG-2200's existing next step must survive the edit.
      expect(result.content[0].text).toContain('search_drive_files');
    });
  });

  describe('rockhopper://files resource', () => {
    it('stops claiming it serves ALL enrolled files and names the exclusion', () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      registerResources(server as any, api as any);
      const call = server.registerResource.mock.calls.find(
        (c) => c[0] === 'enrolled-files',
      );
      const description = (call?.[2] as { description: string }).description;
      expect(description).not.toMatch(/^all excel files enrolled/i);
      expect(description).toMatch(/archiv/i);
    });
  });

  describe('orchestration guide', () => {
    it('stops telling the model that absence means never-added', async () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      registerResources(server as any, api as any);
      const call = server.registerResource.mock.calls.find(
        (c) => c[0] === 'orchestration-guide',
      );
      const handler = call?.[3] as (uri: URL) => Promise<{
        contents: Array<{ text: string }>;
      }>;
      const guide = (
        await handler(new URL('rockhopper://orchestration-guide'))
      ).contents[0].text;
      // The guide is read BEFORE any tool call, so an overclaim here outruns
      // every description fixed above.
      expect(guide).not.toContain('very probably one nobody has added yet');
      expect(guide).toMatch(/archiv/i);
    });
  });

  describe("David's web-only ruling stays enforced", () => {
    it('registers no archive, restore or unarchive tool', () => {
      const server = createMockMcpServer();
      const api = createMockApiClient();
      registerTools(server as any, api as any);
      const names = server.registerTool.mock.calls.map((c) => c[0] as string);
      // A write tool added here reds mcp-gateway's scope-challenge e2e before
      // anyone touches that repo — its write set is derived from two real
      // `tools/list` responses. Adding one is a gateway publish → pin bump →
      // deploy chain, and it is not this ticket.
      expect(names.filter((n) => /archive|restore/i.test(n))).toEqual([]);
    });
  });
});
