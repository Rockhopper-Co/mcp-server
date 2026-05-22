/** Shared Postman collection v2.1 builders. */

export const MCP_HEADERS = [
  { key: 'Content-Type', value: 'application/json' },
  { key: 'Accept', value: 'application/json, text/event-stream' },
  { key: 'Authorization', value: 'Bearer {{ROCKHOPPER_PAT}}' },
];

export const MCP_URL = {
  raw: '{{GATEWAY_URL}}/mcp',
  host: ['{{GATEWAY_URL}}'],
  path: ['mcp'],
};

export const HEALTHZ_URL = {
  raw: '{{GATEWAY_URL}}/healthz',
  host: ['{{GATEWAY_URL}}'],
  path: ['healthz'],
};

/** Pick highest major.minor.patch; prefer non-discarded versions (matches create_version tool). */
export const POSTMAN_PICK_LATEST_VERSION_LINES = [
  'function pickLatestVersionBySemver(versions) {',
  '  if (!Array.isArray(versions) || versions.length === 0) return null;',
  '  const pool = versions.filter((v) => v && v.wasDiscarded !== true);',
  '  const list = pool.length ? pool : versions;',
  '  return list.reduce((best, v) => {',
  '    if (!best) return v;',
  '    if (v.majorVersion !== best.majorVersion) {',
  '      return v.majorVersion > best.majorVersion ? v : best;',
  '    }',
  '    if (v.minorVersion !== best.minorVersion) {',
  '      return v.minorVersion > best.minorVersion ? v : best;',
  '    }',
  '    return v.patchVersion > best.patchVersion ? v : best;',
  '  }, null);',
  '}',
];

export const STANDARD_TOOL_CALL_TESTS = [
  "pm.test('Status 200', () => pm.response.to.have.status(200));",
  'const r = pm.response.json();',
  "pm.test('JSON-RPC result', () => pm.expect(r.result).to.exist);",
  "pm.test('Tool content', () => {",
  "  const content = r.result.content;",
  "  pm.expect(content).to.be.an('array').that.is.not.empty;",
  "  pm.expect(content[0].text).to.be.a('string');",
  '});',
];

export const STANDARD_PROMPT_GET_TESTS = [
  "pm.test('Status 200', () => pm.response.to.have.status(200));",
  'const r = pm.response.json();',
  "pm.test('Prompt messages', () => {",
  "  pm.expect(r.result.messages).to.be.an('array').that.is.not.empty;",
  '});',
];

export function postmanEventTests(lines: string[]): { listen: string; script: { exec: string[]; type: string } } {
  return {
    listen: 'test',
    script: {
      exec: lines,
      type: 'text/javascript',
    },
  };
}

/** Postman vars that must appear as JSON numbers (unquoted) in tool arguments. */
const NUMERIC_COLLECTION_VARS = new Set([
  'versionInternalId',
  'versionId',
  'chatId',
  'reviewId',
  'userId',
]);

function serializeArgValue(value: unknown): string {
  if (typeof value === 'string' && /^\{\{[a-zA-Z0-9_]+\}\}$/.test(value)) {
    const varName = value.slice(2, -2);
    if (NUMERIC_COLLECTION_VARS.has(varName)) {
      return value;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeArgValue).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${serializeArgValue(v)}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
}

function serializeToolArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args).map(
    ([k, v]) => `${JSON.stringify(k)}: ${serializeArgValue(v)}`,
  );
  return `{\n    ${entries.join(',\n    ')}\n  }`;
}

export function jsonRpcBody(
  id: string | number | undefined,
  method: string,
  params?: Record<string, unknown>,
): string {
  const payload: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
  };
  if (id !== undefined) {
    payload.id = id;
  }
  if (params !== undefined) {
    payload.params = params;
  }
  return JSON.stringify(payload, null, 2);
}

export function jsonRpcNotification(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method }, null, 2);
}

export function jsonRpcToolCallBody(id: number, toolName: string, args: Record<string, unknown>): string {
  return `{\n  "jsonrpc": "2.0",\n  "id": ${id},\n  "method": "tools/call",\n  "params": {\n    "name": ${JSON.stringify(toolName)},\n    "arguments": ${serializeToolArguments(args)}\n  }\n}`;
}

export interface PostmanItem {
  name: string;
  request: Record<string, unknown>;
  event?: ReturnType<typeof postmanEventTests>[];
  description?: string;
  item?: PostmanItem[];
}

export function mcpRequest(
  name: string,
  id: string | number,
  method: string,
  params: Record<string, unknown> | undefined,
  description: string,
  testLines: string[] = STANDARD_TOOL_CALL_TESTS,
): PostmanItem {
  return {
    name,
    request: {
      method: 'POST',
      header: MCP_HEADERS,
      body: { mode: 'raw', raw: jsonRpcBody(id, method, params) },
      url: MCP_URL,
      description,
    },
    event: [postmanEventTests(testLines)],
  };
}

export function mcpToolCall(
  name: string,
  id: number,
  toolName: string,
  args: Record<string, unknown>,
  description: string,
  testLines?: string[],
): PostmanItem {
  return {
    name,
    request: {
      method: 'POST',
      header: MCP_HEADERS,
      body: { mode: 'raw', raw: jsonRpcToolCallBody(id, toolName, args) },
      url: MCP_URL,
      description,
    },
    event: [postmanEventTests(testLines ?? STANDARD_TOOL_CALL_TESTS)],
  };
}

export function mcpPromptGet(
  name: string,
  id: number,
  promptName: string,
  args: Record<string, unknown>,
  description: string,
): PostmanItem {
  return mcpRequest(
    name,
    id,
    'prompts/get',
    { name: promptName, arguments: args },
    description,
    STANDARD_PROMPT_GET_TESTS,
  );
}

export function mcpResourceRead(
  name: string,
  id: number,
  uri: string,
  description: string,
  extraTests: string[] = [],
): PostmanItem {
  const tests = [
    "pm.test('Status 200', () => pm.response.to.have.status(200));",
    'const r = pm.response.json();',
    "pm.test('Resource contents', () => {",
    "  pm.expect(r.result.contents).to.be.an('array').that.is.not.empty;",
    '});',
    ...extraTests,
  ];
  return mcpRequest(name, id, 'resources/read', { uri }, description, tests);
}

export function restGet(
  name: string,
  path: string,
  description: string,
  testLines: string[],
  prerequestLines?: string[],
): PostmanItem {
  const event: PostmanItem['event'] = [];
  if (prerequestLines?.length) {
    event.push({
      listen: 'prerequest',
      script: { exec: prerequestLines, type: 'text/javascript' },
    });
  }
  event.push(postmanEventTests(testLines));
  return {
    name,
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{ROCKHOPPER_PAT}}' }],
      url: `{{BACKEND_URL}}${path}`,
      description,
    },
    event,
  };
}

export function restFolder(name: string, description: string, items: PostmanItem[]): PostmanItem {
  return { name, description, item: items };
}

export function mcpFolder(name: string, description: string, items: PostmanItem[]): PostmanItem {
  return { name, description, item: items };
}
