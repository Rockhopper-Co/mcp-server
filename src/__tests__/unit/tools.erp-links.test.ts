import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecordKey } from '../../erp-links.js';
import {
  registerErpLinkWriteTools,
  registerListErpLinksTool,
} from '../../tools/erp-links.js';
import { createMockMcpServer } from './test-helpers.js';

/**
 * ENG-8441 — the JD Edwards record-link tools. The routes are keyed by the
 * file's INTERNAL id, so every test pins that the platform id was resolved
 * and the internal id (not the platform id) reached the API.
 */

const INTERNAL_ID = 41;

const link = {
  linkId: '12',
  connectionId: '3',
  recordKind: 'billing_batch',
  recordKey: { batchNumber: 4471, batchType: 'G' },
  displayLabel: 'October billing',
  createdAt: '2026-11-20T10:00:00.000Z',
  removedAt: null,
};

function stubApi() {
  return {
    getEnrolledFile: vi.fn().mockResolvedValue({ internalId: INTERNAL_ID }),
    listErpLinks: vi
      .fn()
      .mockResolvedValue({ data: [link], total: 1, page: 1, limit: 100 }),
    listErpLinkStatuses: vi.fn().mockResolvedValue({
      data: [
        {
          linkId: '12',
          status: 'A',
          meaning: 'Approved',
          observedAt: '2026-11-20T11:00:00.000Z',
          source: 'event',
        },
      ],
      total: 1,
      page: 1,
      limit: 100,
    }),
    createErpLink: vi.fn().mockResolvedValue(link),
    removeErpLink: vi.fn().mockResolvedValue(link),
  };
}

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

let api: ReturnType<typeof stubApi>;
let tools: Map<string, Handler>;

beforeEach(() => {
  api = stubApi();
  const server = createMockMcpServer();
  registerListErpLinksTool(server as never, api as never);
  registerErpLinkWriteTools(server as never, api as never);
  tools = new Map(
    server.registerTool.mock.calls.map(
      (c): [string, Handler] => [c[0] as string, c[2] as Handler],
    ),
  );
});

const call = (name: string, args: Record<string, unknown>) => {
  const handler = tools.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler(args);
};

describe('list_erp_links', () => {
  it('shows each link with its own status, read by internal id', async () => {
    const result = await call('list_erp_links', { fileMsId: 'file-1' });
    expect(api.getEnrolledFile).toHaveBeenCalledWith('file-1');
    expect(api.listErpLinks).toHaveBeenCalledWith(INTERNAL_ID);
    expect(api.listErpLinkStatuses).toHaveBeenCalledWith(INTERNAL_ID);
    const text = result.content[0].text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain('"October billing" billing_batch');
    expect(text).toContain('batchNumber 4471, batchType G');
    expect(text).toContain('linkId: 12, connectionId: 3');
    expect(text).toContain('A (Approved), seen 2026-11-20T11:00:00.000Z');
  });

  it('says a link has no status yet rather than inventing one', async () => {
    api.listErpLinkStatuses.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
    });
    const result = await call('list_erp_links', { fileMsId: 'file-1' });
    expect(result.content[0].text).toContain('no status seen yet');
  });

  it('says when a file has no links', async () => {
    api.listErpLinks.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
    });
    const result = await call('list_erp_links', { fileMsId: 'file-1' });
    expect(result.content[0].text).toBe(
      'This file is not linked to any JD Edwards record.',
    );
  });

  it('passes the API refusal through as an error', async () => {
    api.listErpLinks.mockRejectedValue(new Error('No access to the file'));
    const result = await call('list_erp_links', { fileMsId: 'file-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No access to the file');
  });
});

describe('link_erp_record', () => {
  it('sends only the kind’s own key fields, to the internal id', async () => {
    const result = await call('link_erp_record', {
      fileMsId: 'file-1',
      connectionId: '3',
      recordKind: 'billing_batch',
      batchNumber: 4471,
      batchType: 'G',
      businessUnit: 'IGNORED',
      displayLabel: 'October billing',
    });
    expect(api.createErpLink).toHaveBeenCalledWith(INTERNAL_ID, {
      connectionId: '3',
      recordKind: 'billing_batch',
      recordKey: { batchNumber: 4471, batchType: 'G' },
      displayLabel: 'October billing',
    });
    expect(result.content[0].text).toBe(
      'Linked billing_batch batchNumber 4471, batchType G (linkId: 12).',
    );
  });

  it('refuses a key missing a field, naming it, and calls nothing', async () => {
    const result = await call('link_erp_record', {
      fileMsId: 'file-1',
      connectionId: '3',
      recordKind: 'lease',
      leaseNumber: 15368,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('needs leaseVersion');
    expect(api.getEnrolledFile).not.toHaveBeenCalled();
    expect(api.createErpLink).not.toHaveBeenCalled();
  });

  it('passes the backend refusal through as an error', async () => {
    api.createErpLink.mockRejectedValue(new Error('erp_link_exists'));
    const result = await call('link_erp_record', {
      fileMsId: 'file-1',
      connectionId: '3',
      recordKind: 'property',
      businessUnit: 'BU100',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('erp_link_exists');
  });
});

describe('unlink_erp_record', () => {
  it('removes the named link on the internal id', async () => {
    const result = await call('unlink_erp_record', {
      fileMsId: 'file-1',
      linkId: '12',
    });
    expect(api.removeErpLink).toHaveBeenCalledWith(INTERNAL_ID, '12');
    expect(result.content[0].text).toContain('Unlinked billing_batch');
  });
});

describe('buildRecordKey', () => {
  it('builds each kind from its own fields', () => {
    expect(
      buildRecordKey('expense_participation', {
        businessUnit: 'BU100',
        epClass: 'CAM',
        leaseNumber: 1,
      }),
    ).toEqual({ key: { businessUnit: 'BU100', epClass: 'CAM' } });
    expect(buildRecordKey('property', {})).toEqual({
      missing: ['businessUnit'],
    });
  });
});
