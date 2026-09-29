import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, CLIENT_TOOL_HEADER } from '../../api-client.js';

/**
 * ENG-2883 (plan 23 SP04) — the local server names the APP that connected to
 * it, so a ledger row can say "Cursor did this" instead of only "some agent
 * did this through the Rockhopper MCP server".
 *
 * A user-minted personal access token carries no tool identity — nothing was
 * recorded when it was created — so `clientInfo` from the MCP handshake is the
 * only name this lane ever has. It is CLIENT-ASSERTED and lands at the weakest
 * class; the header exists so the name is recorded at all, not so it is trusted.
 */
describe('ApiClient client-tool emit (ENG-2883)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const headersOfCall = (n = 0): Record<string, string> =>
    (fetchSpy.mock.calls[n][1] as { headers: Record<string, string> }).headers;

  const client = (): ApiClient =>
    new ApiClient({ baseUrl: 'https://api.rockhopper.co', token: 'rh_pat_test' });

  const write = (c: ApiClient): Promise<unknown> =>
    c.createComment({ fileMsId: 'f1', message: 'hi', versionInternalId: 1 });

  it('stamps the connected client name on write calls', async () => {
    const c = client();
    c.setClientToolProvider(() => ({ name: 'Cursor', version: '1.2.3' }));
    await write(c);
    expect(headersOfCall()[CLIENT_TOOL_HEADER]).toBe('Cursor');
  });

  // The provider is read PER CALL, not captured once: `clientInfo` is unknown
  // until the client finishes `initialize`, which happens after the server is
  // built. Reading it once at construction would record nothing, forever.
  it('reads the provider on every call, not once at construction', async () => {
    const c = client();
    let info: { name: string } | null = null;
    c.setClientToolProvider(() => info);
    await write(c);
    expect(headersOfCall(0)[CLIENT_TOOL_HEADER]).toBeUndefined();

    info = { name: 'Claude Desktop' };
    await write(c);
    expect(headersOfCall(1)[CLIENT_TOOL_HEADER]).toBe('Claude Desktop');
  });

  // A client that named itself nothing gets NO header. An empty header would
  // be a tool called "" — a name we invented out of an absence.
  it('sends no header when the client named itself nothing', async () => {
    const c = client();
    c.setClientToolProvider(() => ({ name: '   ', version: '1' }));
    await write(c);
    expect(headersOfCall()[CLIENT_TOOL_HEADER]).toBeUndefined();
  });

  it('sends no header when nothing installed a provider', async () => {
    await write(client());
    expect(headersOfCall()[CLIENT_TOOL_HEADER]).toBeUndefined();
  });

  // Reads carry no provenance headers at all today, and this must not become
  // the first one — there is no admission and no role row on a read.
  it('stays off read calls', async () => {
    const c = client();
    c.setClientToolProvider(() => ({ name: 'Cursor' }));
    await c.getMe();
    expect(headersOfCall()[CLIENT_TOOL_HEADER]).toBeUndefined();
  });

  // The backend column is 255 wide. A name longer than it would be refused
  // there, far from the client that sent it.
  it('bounds a name longer than the column that stores it', async () => {
    const c = client();
    c.setClientToolProvider(() => ({ name: 'x'.repeat(900) }));
    await write(c);
    expect(headersOfCall()[CLIENT_TOOL_HEADER]).toHaveLength(255);
  });
});
