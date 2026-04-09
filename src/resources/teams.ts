import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../api-client.js';

export function registerTeamResources(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerResource(
    'team-detail',
    new ResourceTemplate('rockhopper://teams/{teamId}', {
      list: undefined,
    }),
    {
      title: 'Team Details',
      description: 'Details for a specific team including members and roles',
      mimeType: 'application/json',
    },
    async (uri, { teamId }) => {
      const team = await api.getTeam(Number(teamId));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(team, null, 2),
          },
        ],
      };
    },
  );
}
