/**
 * A coded billing refusal on a 503 is a refusal, never "still producing".
 *
 * Driven through the REAL ApiClient over a stubbed fetch with real `Headers`,
 * so the status, the body's `code` and the classification in the client are
 * what is under test. The positive controls come first: a 503 or 429 with no
 * billing code must still be the not-ready answer, or the refusal cases below
 * would pass for a client that stopped classifying not-ready at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, RockhopperApiError } from '../../api-client.js';
import {
  BILLING_REFUSAL_MARKER,
  billingRefusalCodeOf,
  billingRefusalToolResult,
} from '../../billing-refusal.js';
import {
  ChangeHistoryNotReadyError,
  NOT_READY_MARKER,
  assertChangeHistoryComplete,
  isNotReady,
} from '../../not-ready.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const UNREADABLE_BODY = {
  statusCode: 503,
  error: 'Service Unavailable',
  message: 'Billing could not be checked; try again',
  code: 'billing_unreadable',
};

type Wire = { status: number; body: unknown; headers?: Record<string, string> };
type Api = ReturnType<typeof createMockApiClient>;
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Stubs fetch to answer every request with `wire`; returns a real client. */
function realClient(wire: Wire): ApiClient {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: wire.status,
        statusText: wire.status === 429 ? 'Too Many Requests' : 'Service Unavailable',
        headers: new Headers(wire.headers ?? {}),
        json: () => Promise.resolve(wire.body),
        text: () =>
          Promise.resolve(
            typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body),
          ),
      }),
    ),
  );
  return new ApiClient({ baseUrl: 'https://api.test', token: 't' });
}

/** A tool whose listed api methods go through the real client over `wire`. */
async function callTool(
  wire: Wire,
  name: string,
  args: Record<string, unknown>,
  methods: ReadonlyArray<keyof Api>,
  setup: (api: Api) => void = () => {},
): Promise<Result> {
  const real = realClient(wire) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const api = createMockApiClient();
  setup(api);
  for (const m of methods) {
    (api[m] as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
      real[m as string](...a),
    );
  }
  const server = createMockMcpServer();
  registerTools(server as never, api as never);
  const call = server.registerTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (await call[2](args)) as Result;
}

const payloadOf = (text: string) => JSON.parse(text.slice(text.lastIndexOf('{')));

const cellArgs = { fileMsId: 'file-1', sheetName: 'Sheet1', cellAddress: 'A1' };
const smartsheetFile = (api: Api) => {
  api.getEnrolledFile.mockResolvedValue({
    internalId: 11,
    platformId: 'file-1',
    fileType: 'smartsheet_sheet',
    name: 'Plan',
  });
};

/** Every change-history tool arm this fix touches, and what it reads. */
const ARMS: Array<{
  label: string;
  name: string;
  args: Record<string, unknown>;
  methods: ReadonlyArray<keyof Api>;
  setup?: (api: Api) => void;
}> = [
  { label: 'get_cell_history (cell)', name: 'get_cell_history', args: cellArgs, methods: ['getCellHistory'] },
  {
    label: 'get_cell_history (anchor)',
    name: 'get_cell_history',
    args: { fileMsId: 'file-1', anchorId: 'p-1' },
    methods: ['getAnchorHistory'],
  },
  {
    label: 'get_cell_history (Smartsheet)',
    name: 'get_cell_history',
    args: { fileMsId: 'file-1', rowAnchorId: 'r', columnAnchorId: 'c' },
    methods: ['getSmartsheetCellHistory'],
    setup: smartsheetFile,
  },
  {
    label: 'get_unattributed_changes (completeness probe)',
    name: 'get_unattributed_changes',
    args: { fileMsId: 'file-1' },
    methods: ['getFoldStatus'],
  },
  {
    label: 'get_unattributed_changes (ledger read)',
    name: 'get_unattributed_changes',
    args: { fileMsId: 'file-1' },
    methods: ['getCompareSummary'],
  },
  { label: 'get_file_versions', name: 'get_file_versions', args: { fileMsId: 'file-1' }, methods: ['getFileVersions'] },
];

describe('the API client: a 429/503 is not-ready unless it carries a billing code', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('positive control: a 503 with no code is still not-ready (still_producing)', async () => {
    const real = realClient({ status: 503, body: 'upstream busy' });
    const err = await real.getCellHistory('file-1', 'Sheet1', 'A1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChangeHistoryNotReadyError);
    expect((err as ChangeHistoryNotReadyError).reason).toBe('still_producing');
    expect(billingRefusalCodeOf(err)).toBeNull();
  });

  it('positive control: a 429 is still not-ready, with or without a non-billing code', async () => {
    const plain = realClient({ status: 429, body: 'producing', headers: { 'Retry-After': '30' } });
    const a = await plain.getFoldStatus('file-1').catch((e: unknown) => e);
    expect(isNotReady(a)).toBe(true);
    expect((a as ChangeHistoryNotReadyError).retryAfterSeconds).toBe(30);
    const busy = realClient({
      status: 429,
      body: { statusCode: 429, message: 'busy', code: 'ledger_read_busy' },
      headers: { 'Retry-After': '2' },
    });
    const b = await busy.getCellHistory('file-1', 'Sheet1', 'A1').catch((e: unknown) => e);
    expect(isNotReady(b)).toBe(true);
    expect((b as ChangeHistoryNotReadyError).reason).toBe('still_producing');
  });

  it('a 503 billing_unreadable is a RockhopperApiError carrying the code and message', async () => {
    const real = realClient({ status: 503, body: UNREADABLE_BODY });
    const err = await real.getCellHistory('file-1', 'Sheet1', 'A1').catch((e: unknown) => e);
    expect(isNotReady(err)).toBe(false);
    expect(err).toBeInstanceOf(RockhopperApiError);
    const api = err as RockhopperApiError;
    expect(api.status).toBe(503);
    expect(api.code).toBe('billing_unreadable');
    expect(api.reason).toBeNull();
    expect(api.serverMessage).toBe('Billing could not be checked; try again');
    expect(billingRefusalCodeOf(err)).toBe('billing_unreadable');
  });

  it('the completeness probe lets the refusal through instead of completeness_unknown', async () => {
    const real = realClient({ status: 503, body: UNREADABLE_BODY });
    const err = await assertChangeHistoryComplete(real, 'file-1').catch((e: unknown) => e);
    expect(isNotReady(err)).toBe(false);
    expect((err as RockhopperApiError).code).toBe('billing_unreadable');
  });

  it('matches the code carried as a cause, and nothing else', () => {
    expect(billingRefusalCodeOf(new Error('x', { cause: { code: 'billing_unreadable' } }))).toBe(
      'billing_unreadable',
    );
    expect(billingRefusalCodeOf({ code: 'plan_excludes_feature' })).toBeNull();
    expect(billingRefusalCodeOf(new Error('x'))).toBeNull();
    expect(billingRefusalCodeOf(null)).toBeNull();
  });
});

describe('change-history tools render billing_unreadable by its code', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const arm of ARMS) {
    it(`positive control: ${arm.label} answers a plain 503 as not-ready`, async () => {
      const out = await callTool(
        { status: 503, body: 'upstream busy' },
        arm.name,
        arm.args,
        arm.methods,
        arm.setup,
      );
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith(`${NOT_READY_MARKER} — `)).toBe(true);
      expect(out.content[0].text).not.toContain(BILLING_REFUSAL_MARKER);
    });

    it(`${arm.label} answers a 503 billing_unreadable as the coded refusal`, async () => {
      const out = await callTool(
        { status: 503, body: UNREADABLE_BODY },
        arm.name,
        arm.args,
        arm.methods,
        arm.setup,
      );
      expect(out).toEqual(billingRefusalToolResult('billing_unreadable'));
      const text = out.content[0].text;
      expect(text.startsWith('BILLING_REFUSED — this is NOT a result and NOT an empty result.')).toBe(
        true,
      );
      expect(payloadOf(text)).toEqual({ status: 'refused', code: 'billing_unreadable' });
      expect(text).not.toContain(NOT_READY_MARKER);
      expect(text).not.toContain('Failed to');
    });
  }

  it('the refusal names the remedy and forbids the empty reading', () => {
    const text = billingRefusalToolResult('billing_unreadable').content[0].text;
    expect(text).toContain(
      "Tell the user that Rockhopper could not confirm their organization's billing " +
        'right now, and that trying again later may work.',
    );
    expect(text).toContain(
      'Do NOT say the file has no changes, no history or no versions, or that its ' +
        'history is empty — none of that is known.',
    );
  });
});
