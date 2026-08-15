import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2198 (SP07 §3, S10). The property under test is mostly a NEGATIVE one:
 * the tool must not give a caller any way to influence where a user's consent
 * is sent.
 */
describe('connect_microsoft', () => {
  const register = (api: ReturnType<typeof createMockApiClient>) => {
    const server = createMockMcpServer();
    registerTools(server as any, api as any);
    return server;
  };

  const handlerFor = (
    server: ReturnType<typeof createMockMcpServer>,
    name: string,
  ) => server.registerTool.mock.calls.find((c) => c[0] === name)?.[2];

  const specFor = (
    server: ReturnType<typeof createMockMcpServer>,
    name: string,
  ) => server.registerTool.mock.calls.find((c) => c[0] === name)?.[1];

  it('registers the three connection tools on the read floor', () => {
    const names = register(createMockApiClient()).registerTool.mock.calls.map(
      (c) => c[0],
    );
    expect(names).toContain('connect_microsoft');
    expect(names).toContain('microsoft_link_status');
    expect(names).toContain('disconnect_microsoft');
  });

  describe('the consent URL is not a parameter', () => {
    it('accepts no input fields at all', () => {
      const server = register(createMockApiClient());
      const schema = specFor(server, 'connect_microsoft')?.inputSchema;

      // An empty object schema is the guarantee: there is no `authorizeUrl`,
      // `redirectUri`, `clientId` or `scope` for a model to fill in.
      const parsed = schema.parse({});
      expect(parsed).toEqual({});
      expect(Object.keys(schema.shape ?? {})).toHaveLength(0);
    });

    it('strips anything a caller tries to smuggle in', () => {
      const server = register(createMockApiClient());
      const schema = specFor(server, 'connect_microsoft')?.inputSchema;

      expect(
        schema.parse({
          redirectUri: 'https://attacker.example/steal',
          clientId: 'attacker-client',
        }),
      ).toEqual({});
    });

    it('relays only the URL the backend built', async () => {
      const api = createMockApiClient();
      const handler = handlerFor(register(api), 'connect_microsoft');

      const result = await handler({});

      expect(api.beginMicrosoftConnect).toHaveBeenCalledWith();
      expect(api.beginMicrosoftConnect).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain(
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=real-client',
      );
    });

    it('reports a failure to start rather than inventing a link', async () => {
      const api = createMockApiClient();
      api.beginMicrosoftConnect.mockRejectedValue(new Error('backend is down'));
      const handler = handlerFor(register(api), 'connect_microsoft');

      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('backend is down');
      expect(result.content[0].text).not.toContain('login.microsoftonline.com');
    });
  });

  describe('microsoft_link_status', () => {
    it('tells an unconnected user what to do next', async () => {
      const handler = handlerFor(
        register(createMockApiClient()),
        'microsoft_link_status',
      );
      const result = await handler({});
      expect(result.content[0].text).toContain('No Microsoft account is connected');
      expect(result.content[0].text).toContain('connect_microsoft');
    });

    it('names the connected account and its grant', async () => {
      const api = createMockApiClient();
      api.getMicrosoftLink.mockResolvedValue({
        linked: true,
        msAccountLabel: 'user@contoso.com',
        msTenantId: 'tenant-1',
        grantedScopes: ['Files.Read.All'],
        linkedAt: '2026-08-14T00:00:00.000Z',
        lastUsedAt: null,
      });
      const handler = handlerFor(register(api), 'microsoft_link_status');

      const result = await handler({});

      expect(result.content[0].text).toContain('user@contoso.com');
      expect(result.content[0].text).toContain('Files.Read.All');
    });

    it('surfaces a read failure as an error', async () => {
      const api = createMockApiClient();
      api.getMicrosoftLink.mockRejectedValue(new Error('unauthorized'));
      const handler = handlerFor(register(api), 'microsoft_link_status');

      const result = await handler({});
      expect(result.isError).toBe(true);
    });
  });

  describe('disconnect_microsoft', () => {
    it('confirms the credential was deleted', async () => {
      const api = createMockApiClient();
      const handler = handlerFor(register(api), 'disconnect_microsoft');

      const result = await handler({});

      expect(api.unlinkMicrosoft).toHaveBeenCalled();
      expect(result.content[0].text).toContain('deleted');
    });

    it('is honest when there was nothing to disconnect', async () => {
      const api = createMockApiClient();
      api.unlinkMicrosoft.mockResolvedValue({ linked: false, removed: false });
      const handler = handlerFor(register(api), 'disconnect_microsoft');

      const result = await handler({});
      expect(result.content[0].text).toContain('No Microsoft account was connected');
    });

    it('reports a refusal rather than claiming success', async () => {
      const api = createMockApiClient();
      api.unlinkMicrosoft.mockRejectedValue(
        new Error('requires interactive login (JWT)'),
      );
      const handler = handlerFor(register(api), 'disconnect_microsoft');

      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('interactive login');
    });

    it('is marked destructive so a client can confirm first', () => {
      const server = register(createMockApiClient());
      const annotations = specFor(server, 'disconnect_microsoft')?.annotations;
      expect(annotations.destructiveHint).toBe(true);
    });
  });
});
