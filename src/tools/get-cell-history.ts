import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export function registerGetCellHistoryTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'get_cell_history',
    {
      title: 'Get Cell History',
      description:
        'Get the change history for a specific cell in an enrolled file. ' +
        'Shows how the cell value changed across versions.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        sheetName: z.string().describe('Name of the worksheet'),
        cellAddress: z
          .string()
          .describe('Cell address (e.g. "A1", "B12", "Sheet1!C3")'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileMsId, sheetName, cellAddress }) => {
      try {
        const history = await api.getCellHistory(
          fileMsId,
          sheetName,
          cellAddress,
        );

        const summary = history
          .map(
            (h) =>
              `- Version ${h.versionId}: **${JSON.stringify(h.value)}**` +
              (h.changedBy ? ` — by ${h.changedBy}` : '') +
              ` — ${h.changedAt}`,
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: history.length
                ? `Cell ${cellAddress} on "${sheetName}" — ${history.length} change(s):\n\n${summary}`
                : `No history found for ${cellAddress} on "${sheetName}".`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get cell history: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
