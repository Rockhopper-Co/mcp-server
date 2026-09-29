import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
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

  it('registers the Google three on the read floor beside the Microsoft three', () => {
    const names = register(createMockApiClient()).registerTool.mock.calls.map(
      (c) => c[0],
    );
    for (const name of [
      'connect_microsoft',
      'microsoft_link_status',
      'disconnect_microsoft',
      'connect_google',
      'google_link_status',
      'disconnect_google',
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

describe('disconnect_google', () => {
  it('confirms the stored grant was deleted', async () => {
    const api = createMockApiClient();
    const [, spec, handler] = callFor(register(api), 'disconnect_google')!;

    const result = await handler({});

    expect(api.unlinkGoogle).toHaveBeenCalledTimes(1);
    expect(api.unlinkMicrosoft).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe(
      'Google account disconnected. The stored credential has been deleted.',
    );
    expect(spec.annotations.destructiveHint).toBe(true);
  });

  it('is honest when there was nothing to disconnect', async () => {
    const api = createMockApiClient();
    api.unlinkGoogle.mockResolvedValue({ linked: false, removed: false });
    const [, , handler] = callFor(register(api), 'disconnect_google')!;
    expect((await handler({})).content[0].text).toBe(
      'No Google account was connected.',
    );
  });

  it('says plainly that a personal access token cannot disconnect', async () => {
    const api = createMockApiClient();
    api.unlinkGoogle.mockRejectedValue(
      new RockhopperApiError(
        403,
        'Rockhopper API 403: Forbidden — {"message":"Disconnecting a Google account requires interactive login (JWT)"}',
      ),
    );
    const [, , handler] = callFor(register(api), 'disconnect_google')!;

    const result = await handler({});
    const text = result.content[0].text as string;

    expect(result.isError).toBe(true);
    expect(text).toContain('Nothing was disconnected');
    expect(text).toContain('personal access token');
    expect(text).not.toContain('Rockhopper API 403');
  });
});
