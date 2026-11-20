import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-6414 — the Google Drive half of the account-link tools. Both providers
 * go through ONE registration (`tools/account-link.ts`); the Microsoft three
 * keep their own byte-for-byte assertions in `tools.connect-microsoft.test.ts`.
 */
const register = (api: ReturnType<typeof createMockApiClient>) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server;
};

const callFor = (server: ReturnType<typeof createMockMcpServer>, name: string) =>
  server.registerTool.mock.calls.find((c) => c[0] === name);

const GOOGLE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=real-google-client';

describe('account-link tools — both providers, one registration', () => {
  it.each([
    ['microsoft', 'beginMicrosoftConnect'],
    ['google', 'beginGoogleConnect'],
  ] as const)(
    'connect_%s takes no input and strips a smuggled URL',
    async (provider, beginCall) => {
      const api = createMockApiClient();
      const [, spec, handler] = callFor(register(api), `connect_${provider}`)!;

      expect(Object.keys(spec.inputSchema.shape ?? {})).toHaveLength(0);
      expect(
        spec.inputSchema.parse({ authorizeUrl: 'https://attacker.example/x' }),
      ).toEqual({});

      const result = await handler({ authorizeUrl: 'https://attacker.example/x' });
      expect(api[beginCall]).toHaveBeenCalledWith();
      expect(result.content[0].text).not.toContain('attacker.example');
    },
  );

  it('registers the Google two on the read floor beside the Microsoft two', () => {
    const names = register(createMockApiClient()).registerTool.mock.calls.map(
      (c) => c[0],
    );
    for (const name of [
      'connect_microsoft',
      'microsoft_link_status',
      'connect_google',
      'google_link_status',
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('connect_google', () => {
  it('relays the backend-built Google link and its expiry', async () => {
    const api = createMockApiClient();
    const [, , handler] = callFor(register(api), 'connect_google')!;

    const result = await handler({});
    const text = result.content[0].text as string;

    expect(api.beginGoogleConnect).toHaveBeenCalledTimes(1);
    expect(api.beginMicrosoftConnect).not.toHaveBeenCalled();
    expect(text).toContain(GOOGLE_URL);
    expect(text).toContain('2026-09-28T21:00:00.000Z');
    expect(text).toContain('google_link_status');
    expect(text).not.toContain('Microsoft');
  });

  it('reports a backend failure rather than inventing a link', async () => {
    const api = createMockApiClient();
    api.beginGoogleConnect.mockRejectedValue(new Error('backend is down'));
    const [, , handler] = callFor(register(api), 'connect_google')!;

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('backend is down');
    expect(result.content[0].text).not.toContain('accounts.google.com');
  });
});

describe('google_link_status', () => {
  it('tells an unconnected user to run connect_google', async () => {
    const [, , handler] = callFor(
      register(createMockApiClient()),
      'google_link_status',
    )!;
    const text = (await handler({})).content[0].text;
    expect(text).toBe(
      'No Google account is connected. Run `connect_google` to connect one.',
    );
  });

  it('names the connected account and nothing else', async () => {
    const api = createMockApiClient();
    api.getGoogleLink.mockResolvedValue({
      linked: true,
      googleAccountLabel: 'user@example.com',
    });
    const [, , handler] = callFor(register(api), 'google_link_status')!;

    expect((await handler({})).content[0].text).toBe(
      'Connected as user@example.com.',
    );
  });

  it('surfaces a read failure as an error', async () => {
    const api = createMockApiClient();
    api.getGoogleLink.mockRejectedValue(new Error('unauthorized'));
    const [, , handler] = callFor(register(api), 'google_link_status')!;
    expect((await handler({})).isError).toBe(true);
  });
});

describe('no disconnect tool (ENG-9682)', () => {
  it('registers connect and status for every provider and no disconnect', () => {
    const names = register(createMockApiClient()).registerTool.mock.calls.map(
      (c) => c[0],
    );
    // Positive control: the tools that stay are registered.
    for (const provider of ['microsoft', 'google', 'smartsheet']) {
      expect(names).toContain(`connect_${provider}`);
      expect(names).toContain(`${provider}_link_status`);
    }
    expect(names.filter((n) => n.startsWith('disconnect_'))).toEqual([]);
  });
});
