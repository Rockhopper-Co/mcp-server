import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

/**
 * `connect_microsoft` — the local half of SP07 §3.
 *
 * WHAT THIS TOOL DELIBERATELY CANNOT DO, and why the shape matters more than
 * the feature. It takes NO authorize URL, no redirect URI, no client id and no
 * scope list. It asks the backend to build the consent URL and relays what
 * comes back.
 *
 * The reason is the threat this tool sits inside. An MCP tool's arguments are
 * chosen by a language model, and that model reads content it did not author —
 * file names, comments, review text. A tool that accepted a URL would let
 * anything that model reads steer where a user's Microsoft consent is sent,
 * and the user would see a real Microsoft consent screen the whole way. So the
 * URL is not a parameter, and the callback re-pins the client id and redirect
 * server-side when it redeems the code. Two independent places refuse to take
 * the caller's word for it.
 */
export function registerConnectMicrosoftTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'connect_microsoft',
    {
      title: 'Connect Microsoft Account',
      description:
        'Start connecting the user\'s Microsoft account so Rockhopper can search ' +
        'their OneDrive and SharePoint files as them. Returns a Microsoft sign-in ' +
        'link the USER must open themselves. Call `microsoft_link_status` afterwards ' +
        'to confirm they finished. Use this when a file search reports that no ' +
        'Microsoft account is connected.',
      inputSchema: z.object({}),
      annotations: {
        // Creates no Rockhopper data by itself — it hands back a link. The
        // grant only exists once the USER completes the consent.
        readOnlyHint: true,
        // It sends the user to Microsoft.
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const handoff = await api.beginMicrosoftConnect();

        return {
          content: [
            {
              type: 'text',
              text:
                'Open this link to connect your Microsoft account:\n\n' +
                `${handoff.authorizeUrl}\n\n` +
                `The link expires at ${handoff.expiresAt}. ` +
                'Rockhopper asks only to READ your files. ' +
                'After you approve, run `microsoft_link_status` to confirm.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to start the Microsoft connection: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'microsoft_link_status',
    {
      title: 'Microsoft Connection Status',
      description:
        'Check whether the user has connected a Microsoft account, which account ' +
        'it is, and what access was granted. Never returns any token.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const status = await api.getMicrosoftLink();

        return {
          content: [
            {
              type: 'text',
              text: status.linked
                ? `Connected${
                    status.msAccountLabel ? ` as ${status.msAccountLabel}` : ''
                  }.` +
                  (status.grantedScopes.length
                    ? ` Granted: ${status.grantedScopes.join(', ')}.`
                    : '') +
                  (status.linkedAt ? ` Connected on ${status.linkedAt}.` : '')
                : 'No Microsoft account is connected. Run `connect_microsoft` to connect one.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read the Microsoft connection: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'disconnect_microsoft',
    {
      title: 'Disconnect Microsoft Account',
      description:
        'Remove the stored Microsoft connection, deleting the credential Rockhopper ' +
        'holds for this user. Requires an interactive login; a personal access token ' +
        'cannot sever a connection it did not create.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = await api.unlinkMicrosoft();

        return {
          content: [
            {
              type: 'text',
              text: result.removed
                ? 'Microsoft account disconnected. The stored credential has been deleted.'
                : 'No Microsoft account was connected.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to disconnect: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
