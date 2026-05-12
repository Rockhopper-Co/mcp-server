/**
 * Generate the Rockhopper MCP Server Postman collection.
 *
 * Why this is small:
 *   The Postman public workspace's headline is a single first-class MCP Request
 *   (transport=HTTP, URL={{GATEWAY_URL}}/mcp, Bearer auth) created via Postman's
 *   web UI. The "Load Capabilities" button on that request discovers our tools,
 *   resources, and prompts at runtime from the live server. We don't ship
 *   per-tool requests — every published vendor MCP collection on the Postman
 *   API Network (HubSpot, AWS Labs, Stripe, Cockroach Labs, etc.) follows this
 *   single-MCP-Request pattern.
 *
 *   This committed JSON exists as a deliberate fallback / "raw protocol view"
 *   for engineers who don't want to use the MCP Request UI, plus a discovery
 *   surface that explains where to go. We still introspect the registered tool
 *   / resource / prompt names so the description's tool list stays in sync.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { registerPrompts } from '../src/prompts/index.js';
import { registerResources } from '../src/resources/index.js';
import { registerTools } from '../src/tools/index.js';

type SchemaMap = Record<string, z.ZodTypeAny>;

class CapturingServer {
  readonly toolNames: string[] = [];

  readonly resourceNames: string[] = [];

  readonly promptNames: string[] = [];

  registerTool(name: string, _config: { inputSchema?: SchemaMap }, _handler: unknown): void {
    this.toolNames.push(name);
  }

  registerResource(
    name: string,
    _uriOrTemplate: unknown,
    _config: { description?: string },
    _handler: unknown,
  ): void {
    this.resourceNames.push(name);
  }

  registerPrompt(
    name: string,
    _config: { argsSchema?: SchemaMap },
    _handler: unknown,
  ): void {
    this.promptNames.push(name);
  }
}

const server = new CapturingServer();
const api = {} as never;

registerTools(server as never, api);
registerResources(server as never, api);
registerPrompts(server as never, api);

const tools = [...server.toolNames].sort();
const resources = [...server.resourceNames].sort();
const prompts = [...server.promptNames].sort();

function bulletList(items: string[]): string {
  return items.map((item) => `- \`${item}\``).join('\n');
}

const description = `# Rockhopper MCP Server

Postman workspace for **Rockhopper's Model Context Protocol (MCP) server**. Connect AI agents (Cursor, Claude Desktop, Claude.ai, ChatGPT) to your Excel files, reviews, comments, and version history in Rockhopper.

## Use the MCP Request (recommended)

The fastest way to test the server is the **MCP Request** item in this workspace. It uses Postman's first-class MCP transport — click **Load Capabilities** and Postman discovers every tool, resource, and prompt the server exposes. No raw JSON-RPC needed.

If you don't see an MCP Request item yet, add one yourself:

1. Click **+ → MCP Request** in the workspace.
2. Transport: **HTTP**.
3. URL: \`{{GATEWAY_URL}}/mcp\`.
4. Authorization: **Bearer Token**, value \`{{ROCKHOPPER_PAT}}\`.
5. Click **Load Capabilities**.

## Raw protocol smoke tests (fallback)

The three items below send raw JSON-RPC requests for engineers who want to inspect the protocol directly without the MCP Request UI:

- \`Healthz\` — gateway is up
- \`MCP Initialize\` — JSON-RPC handshake
- \`MCP Tools List\` — \`tools/list\` returns the advertised tool set

If they pass you're ready to use the MCP Request item (or wire the server into your AI client).

## Connecting an AI client

Drop this into Cursor / Claude Desktop / Claude.ai (\`~/.cursor/mcp.json\` or equivalent):

\`\`\`json
{
  "mcpServers": {
    "rockhopper": {
      "url": "https://mcp.rockhopper.co/mcp",
      "headers": { "Authorization": "Bearer rh_pat_..." }
    }
  }
}
\`\`\`

Get a PAT from **Avatar → Access Tokens** at app.rockhopper.co. See the [Rockhopper MCP setup guide](https://docs.rockhopper.co/it-setup/mcp-server) for full details.

## What the server exposes

**${tools.length} tools**: ${tools.map((t) => `\`${t}\``).join(', ')}.

**${resources.length} resources**: ${resources.map((r) => `\`${r}\``).join(', ')}.

**${prompts.length} prompts**: ${prompts.map((p) => `\`${p}\``).join(', ')}.

## Authentication

Personal Access Tokens (\`rh_pat_...\`) work end-to-end. OAuth 2.0 with Dynamic Client Registration is available for web AI clients — see the [setup guide](https://docs.rockhopper.co/it-setup/mcp-server) for the endpoint URLs and DCR flow.
`;

const initializeBody = JSON.stringify(
  {
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Postman', version: '1.0.0' },
    },
  },
  null,
  2,
);

const toolsListBody = JSON.stringify(
  {
    jsonrpc: '2.0',
    id: 'tools-list-1',
    method: 'tools/list',
    params: {},
  },
  null,
  2,
);

const mcpHeaders = [
  { key: 'Content-Type', value: 'application/json' },
  { key: 'Accept', value: 'application/json, text/event-stream' },
  { key: 'Authorization', value: 'Bearer {{ROCKHOPPER_PAT}}' },
];

const collection = {
  info: {
    name: 'Rockhopper MCP Server',
    description,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  // Flat items (no folder). The Postman API's PUT /collections endpoint
  // currently strips nested folders that aren't pre-existing — keeping the
  // committed JSON flat means a one-shot push from disk to the public
  // workspace round-trips byte-stable. 3 items is small enough that a folder
  // would be visual noise anyway.
  item: [
    {
      name: 'Healthz',
      request: {
        method: 'GET',
        header: [],
        url: {
          raw: '{{GATEWAY_URL}}/healthz',
          host: ['{{GATEWAY_URL}}'],
          path: ['healthz'],
        },
        description: 'Verify the gateway is reachable. Expect 200 with {"status":"ok"}.',
      },
      response: [],
    },
    {
      name: 'MCP Initialize',
      request: {
        method: 'POST',
        header: mcpHeaders,
        body: { mode: 'raw', raw: initializeBody },
        url: {
          raw: '{{GATEWAY_URL}}/mcp',
          host: ['{{GATEWAY_URL}}'],
          path: ['mcp'],
        },
        description:
          "JSON-RPC handshake against the MCP gateway. Returns the server's advertised capabilities and protocol version.",
      },
      response: [],
    },
    {
      name: 'MCP Tools List',
      request: {
        method: 'POST',
        header: mcpHeaders,
        body: { mode: 'raw', raw: toolsListBody },
        url: {
          raw: '{{GATEWAY_URL}}/mcp',
          host: ['{{GATEWAY_URL}}'],
          path: ['mcp'],
        },
        description: 'Returns the list of tools the server advertises via the MCP protocol.',
      },
      response: [],
    },
  ],
  variable: [
    { key: 'GATEWAY_URL', value: 'https://mcp.rockhopper.co' },
    { key: 'ROCKHOPPER_PAT', value: '' },
  ],
};

const outPath = resolve(process.cwd(), 'postman', 'mcp-server.postman_collection.json');
writeFileSync(outPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

console.log(
  `Wrote ${outPath} (tools=${tools.length}, resources=${resources.length}, prompts=${prompts.length}, raw items=3)`,
);
