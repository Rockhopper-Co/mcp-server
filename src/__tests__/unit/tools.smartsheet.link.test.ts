import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * The Smartsheet account-link tools. They come from the same single
 * registration as the Microsoft and Google ones, so the checks that matter
 * here are the Smartsheet-specific words and that the other two are unchanged.
 */
const register = (api: ReturnType<typeof createMockApiClient>) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server;
};

const handlerOf = (
  server: ReturnType<typeof createMockMcpServer>,
  name: string,
) => server.registerTool.mock.calls.find((c) => c[0] === name)![2];

const textOf = (result: { content: Array<{ text: string }> }) =>
  result.content[0].text;

describe('connect_smartsheet / smartsheet_link_status / disconnect_smartsheet', () => {
  it('registers the three on the read floor of a read-only token', () => {
    const server = createMockMcpServer();
    registerTools(server as any, createMockApiClient() as any, {
      scope: 'read-only',
    });
    const names = server.registerTool.mock.calls.map((c) => c[0]);
    for (const name of [
      'connect_smartsheet',
      'smartsheet_link_status',
      'disconnect_smartsheet',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('connect_smartsheet takes no input and hands back the backend-built link', async () => {
    const api = createMockApiClient();
    const server = register(api);
    const spec = server.registerTool.mock.calls.find(
      (c) => c[0] === 'connect_smartsheet',
    )![1];
    expect(Object.keys(spec.inputSchema.shape ?? {})).toHaveLength(0);
    expect(
      spec.inputSchema.parse({ authorizeUrl: 'https://attacker.example/x' }),
    ).toEqual({});

    const result = await handlerOf(server, 'connect_smartsheet')({});
    expect(api.beginSmartsheetConnect).toHaveBeenCalledWith();
    const text = textOf(result);
    expect(text).toContain('https://app.smartsheet.com/b/authorize');
    expect(text).toContain('smartsheet_link_status');
    expect(text).not.toContain('attacker.example');
    expect(text).not.toContain('Microsoft');
  });

  it('says plainly when no Smartsheet account is connected, with a Smartsheet remedy', async () => {
    const server = register(createMockApiClient());
    const text = textOf(await handlerOf(server, 'smartsheet_link_status')({}));
    expect(text).toBe(
      'No Smartsheet account is connected. Run `connect_smartsheet` to connect one.',
    );
  });

  it('reports a connected account by its label', async () => {
    const api = createMockApiClient();
    api.getSmartsheetLink.mockResolvedValue({
      linked: true,
      links: [
        {
          region: 'us',
          status: 'connected',
          accountLabel: 'ana@example.com',
          linkedAt: '2026-11-01T10:00:00.000Z',
        },
      ],
    });
    const text = textOf(
      await handlerOf(register(api), 'smartsheet_link_status')({}),
    );
    expect(text).toContain('Connected as ana@example.com.');
    expect(text).toContain('Connected on 2026-11-01T10:00:00.000Z.');
  });

  it.each([
    ['needs_reconnect', 'connect_smartsheet', true],
    ['scopes_insufficient', 'connect_smartsheet', true],
    ['plan_lacks_api_access', 'plan without API access', false],
  ] as const)(
    'a stored connection in state %s is not reported as connected',
    async (status, expected, suggestsReconnect) => {
      const api = createMockApiClient();
      api.getSmartsheetLink.mockResolvedValue({
        linked: true,
        links: [
          { region: 'us', status, accountLabel: 'a@b.c', linkedAt: null },
        ],
      });
      const text = textOf(
        await handlerOf(register(api), 'smartsheet_link_status')({}),
      );
      expect(text).toContain(expected);
      expect(text).not.toMatch(/^Connected/);
      // A plan without the API is not fixed by connecting again.
      expect(text.includes('Run `connect_smartsheet`')).toBe(suggestsReconnect);
    },
  );

  it('disconnect_smartsheet says a personal access token cannot disconnect', async () => {
    const api = createMockApiClient();
    api.unlinkSmartsheet.mockRejectedValue(new RockhopperApiError(403, 'no'));
    const result = await handlerOf(
      register(api),
      'disconnect_smartsheet',
    )({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing was disconnected');
    expect(textOf(result)).toContain('Smartsheet');
  });

  it('disconnect_smartsheet reports the removal', async () => {
    const text = textOf(
      await handlerOf(register(createMockApiClient()), 'disconnect_smartsheet')(
        {},
      ),
    );
    expect(text).toContain('Smartsheet account disconnected.');
  });

  it('positive control: the Google and Microsoft status text is unchanged', async () => {
    const server = register(createMockApiClient());
    expect(textOf(await handlerOf(server, 'google_link_status')({}))).toBe(
      'No Google account is connected. Run `connect_google` to connect one.',
    );
    expect(textOf(await handlerOf(server, 'microsoft_link_status')({}))).toBe(
      'No Microsoft account is connected. Run `connect_microsoft` to connect one.',
    );
  });
});
