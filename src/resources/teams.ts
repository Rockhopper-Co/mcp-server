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
      // ENG-2230: NOT `Number(teamId)`. A team is keyed on a version-7 uuid
      // (ENG-1966) and `Number('0198f3a1-…')` is `NaN`, which would request
      // `/teams/NaN` — a uuid refused on the customer's machine, the same
      // defect class as the reviewerIds schema. The raw path variable is
      // interpolated straight into the URL, so a numeric id produces a
      // byte-identical request to what `Number()` produced before.
      const team = await api.getTeam(
        Array.isArray(teamId) ? teamId[0] : teamId,
      );
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
