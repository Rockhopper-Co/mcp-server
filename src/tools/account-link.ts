import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RockhopperApiError, type ApiClient } from '../api-client.js';
import {
  ACCOUNT_LINK_PROVIDERS,
  connectToolName,
  statusToolName,
  type AccountLinkProvider,
} from '../account-link-providers.js';

/**
 * The account-link tools — `connect_<provider>`, `<provider>_link_status` and
 * `disconnect_<provider>` — registered ONCE per row of
 * `ACCOUNT_LINK_PROVIDERS` (ENG-6414 widened this from Microsoft alone to
 * Microsoft and Google). Everything below is written about Microsoft, where it
 * started; every word of it holds for Google too.
 *
 * `connect_microsoft` — the local half of SP07 §3.
 *
 * A REPAIR PATH, NOT A SETUP PATH, since ENG-2790. A user who signs in
 * through `mcp.rockhopper.co` gets the delegated Graph grant in the same
 * consent that signs them in, so this tool is no longer the way anyone
 * normally arrives at a working link. It stays because the grant can end
 * up missing for reasons sign-in cannot fix on its own — the user revoked
 * it in Microsoft, the handover at sign-in failed, or the session is a
 * local stdio one with a personal access token, which carries no Microsoft
 * sign-in of its own and therefore still needs this.
 *
 * Deleting it would have left `disconnect_microsoft` as a one-way door.
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
export function registerAccountLinkTools(
  server: McpServer,
  api: ApiClient,
): void {
  for (const provider of ACCOUNT_LINK_PROVIDERS) {
    registerProviderLinkTools(server, api, provider);
  }
}

const failure = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function registerProviderLinkTools(
  server: McpServer,
  api: ApiClient,
  p: AccountLinkProvider,
): void {
  const connectName = connectToolName(p);
  const statusName = statusToolName(p);

  server.registerTool(
    connectName,
    {
      title: `Connect ${p.label} Account`,
      description:
        `Start connecting the user's ${p.label} account so Rockhopper can ` +
        `${p.purpose} as them. Returns a ${p.label} sign-in link the USER must ` +
        `open themselves. Call \`${statusName}\` afterwards to confirm they ` +
        `finished. Use this when a file search reports that no ${p.label} ` +
        'account is connected.',
      inputSchema: z.object({}),
      annotations: {
        // Creates no Rockhopper data by itself — it hands back a link. The
        // grant only exists once the USER completes the consent.
        readOnlyHint: true,
        // It sends the user to the provider.
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const handoff = await p.begin(api);

        return {
          content: [
            {
              type: 'text',
              text:
                `Open this link to connect your ${p.label} account:\n\n` +
                `${handoff.authorizeUrl}\n\n` +
                `The link expires at ${handoff.expiresAt}. ` +
                (p.readOnlyConsent
                  ? 'Rockhopper asks only to READ your files. '
                  : '') +
                `After you approve, run \`${statusName}\` to confirm.`,
            },
          ],
        };
      } catch (error) {
        return failure(
          `Failed to start the ${p.label} connection: ${errorText(error)}`,
        );
      }
    },
  );

  server.registerTool(
    statusName,
    {
      title: `${p.label} Connection Status`,
      description: p.statusDescription,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const status = await p.status(api);

        return {
          content: [
            {
              type: 'text',
              text: status.linked
                ? `Connected${status.account ? ` as ${status.account}` : ''}.` +
                  (status.grantedScopes.length
                    ? ` Granted: ${status.grantedScopes.join(', ')}.`
                    : '') +
                  (status.linkedAt ? ` Connected on ${status.linkedAt}.` : '')
                : `No ${p.label} account is connected. Run \`${connectName}\` to connect one.`,
            },
          ],
        };
      } catch (error) {
        return failure(
          `Failed to read the ${p.label} connection: ${errorText(error)}`,
        );
      }
    },
  );

  server.registerTool(
    `disconnect_${p.key}`,
    {
      title: `Disconnect ${p.label} Account`,
      description:
        `Remove the stored ${p.label} connection, deleting the credential Rockhopper ` +
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
        const result = await p.unlink(api);

        return {
          content: [
            {
              type: 'text',
              text: result.removed
                ? `${p.label} account disconnected. The stored credential has been deleted.`
                : `No ${p.label} account was connected.`,
            },
          ],
        };
      } catch (error) {
        // The backend refuses a disconnect from a personal access token or API
        // key with a 403 (`requireInteractiveAuth`). Said plainly, so the
        // model does not relay a raw HTTP body or report a success.
        if (error instanceof RockhopperApiError && error.status === 403) {
          return failure(
            `Nothing was disconnected. Rockhopper removes a ${p.label} ` +
              'connection only for someone signed in interactively, and this ' +
              'session uses a personal access token. Ask the user to ' +
              `disconnect ${p.label} from Rockhopper in their browser.`,
          );
        }
        return failure(`Failed to disconnect: ${errorText(error)}`);
      }
    },
  );
}
