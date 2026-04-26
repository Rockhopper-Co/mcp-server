import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerPrompts } from '../src/prompts/index.js';
import { registerResources } from '../src/resources/index.js';
import { registerTools } from '../src/tools/index.js';

type SchemaMap = Record<string, z.ZodTypeAny>;

type CapturedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: SchemaMap;
};

type CapturedPrompt = {
  name: string;
  title?: string;
  description?: string;
  argsSchema?: SchemaMap;
};

type CapturedResource = {
  name: string;
  title?: string;
  description?: string;
  uri: string;
};

class CapturingServer {
  readonly tools: CapturedTool[] = [];

  readonly prompts: CapturedPrompt[] = [];

  readonly resources: CapturedResource[] = [];

  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: SchemaMap },
    _handler: unknown,
  ): void {
    this.tools.push({
      name,
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
    });
  }

  registerPrompt(
    name: string,
    config: { title?: string; description?: string; argsSchema?: SchemaMap },
    _handler: unknown,
  ): void {
    this.prompts.push({
      name,
      title: config.title,
      description: config.description,
      argsSchema: config.argsSchema,
    });
  }

  registerResource(
    name: string,
    uriOrTemplate: unknown,
    config: { title?: string; description?: string },
    _handler: unknown,
  ): void {
    const template =
      typeof uriOrTemplate === 'string'
        ? uriOrTemplate
        : ((uriOrTemplate as { uriTemplate?: string })?.uriTemplate ??
          String(uriOrTemplate));
    this.resources.push({
      name,
      title: config.title,
      description: config.description,
      uri: template,
    });
  }
}

function schemaMapToJsonSchema(shape?: SchemaMap): Record<string, unknown> {
  if (!shape || Object.keys(shape).length === 0) {
    return {};
  }
  const objectSchema = z.object(shape);
  return zodToJsonSchema(objectSchema, 'input');
}

function exampleFromJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  const raw = schema as {
    type?: string;
    properties?: Record<string, unknown>;
    anyOf?: unknown[];
    oneOf?: unknown[];
    enum?: unknown[];
    items?: unknown;
  };

  if (raw.enum && raw.enum.length > 0) {
    return raw.enum[0];
  }
  if (raw.anyOf && raw.anyOf.length > 0) {
    return exampleFromJsonSchema(raw.anyOf[0]);
  }
  if (raw.oneOf && raw.oneOf.length > 0) {
    return exampleFromJsonSchema(raw.oneOf[0]);
  }

  switch (raw.type) {
    case 'string':
      return 'example';
    case 'integer':
      return 1;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return raw.items ? [exampleFromJsonSchema(raw.items)] : [];
    case 'object': {
      const properties = raw.properties ?? {};
      const output: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        output[key] = exampleFromJsonSchema(value);
      }
      return output;
    }
    default:
      return null;
  }
}

function buildJsonRpcBody(method: string, params: unknown, id: string): string {
  return JSON.stringify(
    {
      jsonrpc: '2.0',
      id,
      method,
      params,
    },
    null,
    2,
  );
}

const server = new CapturingServer();
const api = {} as never;

registerTools(server as never, api);
registerResources(server as never, api);
registerPrompts(server as never, api);

const smokeItems = [
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
      description: 'Expect 200 with {"status":"ok"}',
    },
  },
  {
    name: 'MCP Initialize',
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Accept', value: 'application/json, text/event-stream' },
      ],
      body: {
        mode: 'raw',
        raw: buildJsonRpcBody(
          'initialize',
          {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'Postman',
              version: '1.0.0',
            },
          },
          'init-1',
        ),
      },
      url: {
        raw: '{{GATEWAY_URL}}/mcp',
        host: ['{{GATEWAY_URL}}'],
        path: ['mcp'],
      },
    },
  },
  {
    name: 'MCP Tools List',
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Accept', value: 'application/json, text/event-stream' },
      ],
      body: {
        mode: 'raw',
        raw: buildJsonRpcBody('tools/list', {}, 'tools-list-1'),
      },
      url: {
        raw: '{{GATEWAY_URL}}/mcp',
        host: ['{{GATEWAY_URL}}'],
        path: ['mcp'],
      },
    },
  },
];

const toolItems = server.tools
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((tool) => {
    const schema = schemaMapToJsonSchema(tool.inputSchema);
    const args = exampleFromJsonSchema(schema);
    const body = buildJsonRpcBody(
      'tools/call',
      {
        name: tool.name,
        arguments: args ?? {},
      },
      `tool-${tool.name}`,
    );

    return {
      name: tool.name,
      request: {
        method: 'POST',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Accept', value: 'application/json, text/event-stream' },
          {
            key: 'Authorization',
            value: 'Bearer {{ACCESS_TOKEN}}',
            disabled: true,
          },
        ],
        body: {
          mode: 'raw',
          raw: body,
        },
        url: {
          raw: '{{GATEWAY_URL}}/mcp',
          host: ['{{GATEWAY_URL}}'],
          path: ['mcp'],
        },
        description: tool.description,
      },
      response: [],
    };
  });

const resourceItems = server.resources
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((resource) => ({
    name: resource.name,
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Accept', value: 'application/json, text/event-stream' },
        {
          key: 'Authorization',
          value: 'Bearer {{ACCESS_TOKEN}}',
          disabled: true,
        },
      ],
      body: {
        mode: 'raw',
        raw: buildJsonRpcBody(
          'resources/read',
          {
            uri: resource.uri,
          },
          `resource-${resource.name}`,
        ),
      },
      url: {
        raw: '{{GATEWAY_URL}}/mcp',
        host: ['{{GATEWAY_URL}}'],
        path: ['mcp'],
      },
      description: resource.description,
    },
    response: [],
  }));

const promptItems = server.prompts
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((prompt) => {
    const schema = schemaMapToJsonSchema(prompt.argsSchema);
    const args = exampleFromJsonSchema(schema);
    return {
      name: prompt.name,
      request: {
        method: 'POST',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Accept', value: 'application/json, text/event-stream' },
          {
            key: 'Authorization',
            value: 'Bearer {{ACCESS_TOKEN}}',
            disabled: true,
          },
        ],
        body: {
          mode: 'raw',
          raw: buildJsonRpcBody(
            'prompts/get',
            {
              name: prompt.name,
              arguments: args ?? {},
            },
            `prompt-${prompt.name}`,
          ),
        },
        url: {
          raw: '{{GATEWAY_URL}}/mcp',
          host: ['{{GATEWAY_URL}}'],
          path: ['mcp'],
        },
        description: prompt.description,
      },
      response: [],
    };
  });

const collection = {
  info: {
    name: 'Rockhopper MCP Server',
    description:
      'Generated Postman collection for MCP gateway smoke testing and tool/resource/prompt calls.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Smoke test',
      item: smokeItems,
    },
    {
      name: 'Tools',
      item: toolItems,
    },
    {
      name: 'Resources',
      item: resourceItems,
    },
    {
      name: 'Prompts',
      item: promptItems,
    },
  ],
  variable: [
    { key: 'GATEWAY_URL', value: 'https://mcp.rockhopper.co' },
    { key: 'ACCESS_TOKEN', value: '' },
  ],
};

const outPath = resolve(process.cwd(), 'postman', 'mcp-server.postman_collection.json');
writeFileSync(outPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

console.log(
  `Wrote ${outPath} (tools=${toolItems.length}, resources=${resourceItems.length}, prompts=${promptItems.length})`,
);
