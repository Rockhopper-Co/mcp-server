/**
 * Generate a full Rockhopper MCP Postman collection — every tool, prompt, and
 * representative resource read, plus REST setup requests to populate variables.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  promptNames,
  registrySummaryMarkdown,
  staticResources,
  templateResources,
  toolNames,
} from './postman-introspect.js';
import {
  HEALTHZ_URL,
  MCP_HEADERS,
  MCP_URL,
  jsonRpcBody,
  jsonRpcNotification,
  mcpFolder,
  mcpPromptGet,
  mcpRequest,
  mcpResourceRead,
  mcpToolCall,
  postmanEventTests,
  POSTMAN_PICK_LATEST_VERSION_LINES,
  restFolder,
  restGet,
  STANDARD_TOOL_CALL_TESTS,
} from './postman-helpers.js';

const READ_TOOL_COUNT = 7;
const WRITE_TOOL_COUNT = 9;

const description = `# Rockhopper MCP Server (full test suite)

End-to-end Postman collection for **every MCP tool**, **prompt**, and key **resource** reads exposed by the Rockhopper MCP server, plus REST setup calls to populate collection variables.

## Before you run

1. **Select a Postman environment** (\`staging\`, \`dev\`, \`production\`, or \`local\`) — it supplies \`GATEWAY_URL\` and \`BACKEND_URL\` (e.g. staging → \`https://mcp-staging.rockhopper.co\` + \`https://api-staging.rockhopper.co\`).
2. Set \`ROCKHOPPER_PAT\` (\`rh_pat_...\`, **read-write** scope for Write Tools).
3. Run **Setup (REST)** folder first (saves \`fileMsId\`, \`versionInternalId\`, \`chatId\`, \`reviewId\`, \`userId\`).
4. Run **MCP Protocol**, then **Read Tools** / **MCP Prompts** / **MCP Resources**.
5. **Write Tools** mutate data — use staging only.

## MCP Request UI

For interactive discovery without raw JSON-RPC, add Postman's **MCP Request** pointing at \`{{GATEWAY_URL}}/mcp\` with Bearer \`{{ROCKHOPPER_PAT}}\` and click **Load Capabilities**.

## Registry (from source)

${registrySummaryMarkdown()}

## Authentication

Bearer \`{{ROCKHOPPER_PAT}}\`. OAuth 2.0 DCR for web clients — see [setup guide](https://docs.rockhopper.co/it-setup/mcp-server).
`;

const setupFolder = restFolder(
  'Setup (REST)',
  'Populate collection variables from the REST API. Run this folder before MCP tool calls.',
  [
    restGet(
      'GET /users/me → userId',
      '/users/me',
      'Saves `userId` for create_review_request reviewerIds.',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const u = pm.response.json();',
        "pm.test('Has id', () => pm.expect(u.id).to.exist);",
        "if (u.id != null) pm.collectionVariables.set('userId', String(u.id));",
      ],
    ),
    restGet(
      'GET /enrolled-files → fileMsId',
      '/enrolled-files',
      'Saves `fileMsId` from the first enrolled file.',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const files = pm.response.json();',
        "pm.test('Array', () => pm.expect(files).to.be.an('array'));",
        "if (files.length > 0 && files[0].platformId) {",
        "  pm.collectionVariables.set('fileMsId', files[0].platformId);",
        '}',
      ],
    ),
    restGet(
      'GET /file-versions/file/{fileMsId} → versionInternalId (latest semver)',
      '/file-versions/file/{{fileMsId}}',
      'Saves `versionInternalId` for the latest major.minor.patch (skips wasDiscarded when possible).',
      [
        ...POSTMAN_PICK_LATEST_VERSION_LINES,
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const versions = pm.response.json();',
        "pm.test('Array', () => pm.expect(versions).to.be.an('array'));",
        'const latest = pickLatestVersionBySemver(versions);',
        "pm.test('Latest version has semver', () => {",
        '  pm.expect(latest).to.exist;',
        "  pm.expect(latest.majorVersion).to.be.a('number');",
        "  pm.expect(latest.minorVersion).to.be.a('number');",
        "  pm.expect(latest.patchVersion).to.be.a('number');",
        '});',
        'if (latest && latest.internalId != null) {',
        "  pm.collectionVariables.set('versionInternalId', String(latest.internalId));",
        '}',
      ],
    ),
    restGet(
      'GET /file-chat/{fileMsId} → chatId',
      '/file-chat/{{fileMsId}}',
      'Saves `chatId` from the first comment thread (if any).',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const chats = pm.response.json();',
        "if (Array.isArray(chats) && chats.length > 0 && chats[0].id != null) {",
        "  pm.collectionVariables.set('chatId', String(chats[0].id));",
        '}',
      ],
    ),
    restGet(
      'GET /reviews/versions/{latest versionId}/requests → reviewId',
      '/reviews/versions/{{versionInternalId}}/requests',
      'Resolves latest version by major.minor.patch, then saves reviewId from the first request on that version.',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const reviews = pm.response.json();',
        "if (Array.isArray(reviews) && reviews.length > 0 && reviews[0].id != null) {",
        "  pm.collectionVariables.set('reviewId', String(reviews[0].id));",
        '}',
      ],
      [
        ...POSTMAN_PICK_LATEST_VERSION_LINES,
        'const base = pm.environment.get("BACKEND_URL") || pm.collectionVariables.get("BACKEND_URL");',
        'const fileMsId = pm.collectionVariables.get("fileMsId");',
        'const pat = pm.environment.get("ROCKHOPPER_PAT") || pm.collectionVariables.get("ROCKHOPPER_PAT");',
        'if (!base || !fileMsId || !pat) {',
        '  throw new Error("Run Setup through enrolled-files first (need BACKEND_URL, fileMsId, ROCKHOPPER_PAT)");',
        '}',
        'const versionRes = await pm.sendRequest({',
        '  url: `${base}/file-versions/file/${fileMsId}`,',
        '  method: "GET",',
        '  header: { Authorization: `Bearer ${pat}` },',
        '});',
        'const latest = pickLatestVersionBySemver(versionRes.json());',
        'if (!latest || latest.internalId == null) {',
        '  throw new Error("No file version found to resolve latest major.minor.patch");',
        '}',
        "pm.collectionVariables.set('versionInternalId', String(latest.internalId));",
      ],
    ),
  ],
);

const protocolFolder = mcpFolder(
  'MCP Protocol',
  'Handshake and capability discovery. Run after Setup when using Collection Runner.',
  [
    {
      name: 'Healthz',
      request: {
        method: 'GET',
        header: [],
        url: HEALTHZ_URL,
        description: 'Expect 200 {"status":"ok"}.',
      },
      event: [
        postmanEventTests([
          "pm.test('Status 200', () => pm.response.to.have.status(200));",
          "pm.test('status ok', () => pm.expect(pm.response.json().status).to.eql('ok'));",
        ]),
      ],
    },
    mcpRequest(
      'MCP Initialize',
      'init-1',
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Postman', version: '1.0.0' },
      },
      'JSON-RPC handshake.',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const r = pm.response.json();',
        "pm.test('protocolVersion', () => pm.expect(r.result.protocolVersion).to.exist);",
        "pm.test('serverInfo', () => pm.expect(r.result.serverInfo).to.exist);",
      ],
    ),
    {
      name: 'notifications/initialized',
      request: {
        method: 'POST',
        header: MCP_HEADERS,
        body: { mode: 'raw', raw: jsonRpcNotification('notifications/initialized') },
        url: MCP_URL,
        description: 'Client initialized notification (no JSON-RPC id).',
      },
      event: [
        postmanEventTests([
          "pm.test('Accepted', () => pm.expect(pm.response.code).to.be.oneOf([200, 202, 204]));",
        ]),
      ],
    },
    mcpRequest(
      'tools/list',
      'tools-list-1',
      'tools/list',
      {},
      'Lists advertised tools.',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        'const r = pm.response.json();',
        "pm.test('tools array', () => pm.expect(r.result.tools).to.be.an('array'));",
        `pm.test('tool count ${READ_TOOL_COUNT}-${READ_TOOL_COUNT + WRITE_TOOL_COUNT}', () => {`,
        '  const n = r.result.tools.length;',
        `  pm.expect(n).to.be.at.least(${READ_TOOL_COUNT}).and.at.most(${READ_TOOL_COUNT + WRITE_TOOL_COUNT});`,
        '});',
      ],
    ),
    mcpRequest('resources/list', 'res-list-1', 'resources/list', {}, 'Static resources.', [
      "pm.test('Status 200', () => pm.response.to.have.status(200));",
      "pm.expect(pm.response.json().result.resources).to.be.an('array');",
    ]),
    mcpRequest(
      'resources/templates/list',
      'res-tpl-1',
      'resources/templates/list',
      {},
      'URI templates for parameterized resources.',
      [
        "pm.test('Status 200', () => pm.response.to.have.status(200));",
        "pm.expect(pm.response.json().result.resourceTemplates).to.be.an('array');",
      ],
    ),
    mcpRequest('prompts/list', 'prompts-list-1', 'prompts/list', {}, 'Lists prompts.', [
      "pm.test('Status 200', () => pm.response.to.have.status(200));",
      `pm.expect(pm.response.json().result.prompts.length).to.be.at.least(${promptNames.length});`,
    ]),
    mcpRequest('ping', 'ping-1', 'ping', undefined, 'Liveness ping.', [
      "pm.test('Status 200', () => pm.response.to.have.status(200));",
    ]),
  ],
);

const readToolsFolder = mcpFolder(
  'Read Tools',
  'tools/call for read-only tools. Requires Setup + MCP Initialize.',
  [
    mcpToolCall('list_files', 10, 'list_files', {}, 'List all enrolled files.'),
    mcpToolCall('list_files (search)', 11, 'list_files', { search: '{{searchQuery}}' }, 'Filter by search term.'),
    mcpToolCall('search_files', 12, 'search_files', { query: '{{searchQuery}}' }, 'Search files by name.'),
    mcpToolCall(
      'get_file_versions',
      13,
      'get_file_versions',
      { fileMsId: '{{fileMsId}}' },
      'Version history for fileMsId.',
    ),
    mcpToolCall(
      'get_file_comments',
      14,
      'get_file_comments',
      { fileMsId: '{{fileMsId}}' },
      'Comments on file.',
    ),
    mcpToolCall(
      'get_reviews (by fileMsId)',
      15,
      'get_reviews',
      { fileMsId: '{{fileMsId}}' },
      'Reviews for latest version.',
    ),
    mcpToolCall(
      'get_reviews (by versionId)',
      16,
      'get_reviews',
      { versionId: '{{versionInternalId}}' },
      'Reviews for a specific version (versionId = versionInternalId).',
    ),
    mcpToolCall(
      'get_cell_history',
      17,
      'get_cell_history',
      {
        fileMsId: '{{fileMsId}}',
        sheetName: '{{sheetName}}',
        cellAddress: '{{cellAddress}}',
      },
      'Change history for one cell.',
    ),
    mcpToolCall(
      'get_unattributed_changes',
      18,
      'get_unattributed_changes',
      { fileMsId: '{{fileMsId}}' },
      'Pending unattributed changes.',
    ),
    mcpToolCall(
      'get_unattributed_changes (sheet filter)',
      19,
      'get_unattributed_changes',
      { fileMsId: '{{fileMsId}}', sheetName: '{{sheetName}}' },
      'Unattributed changes on one sheet.',
    ),
  ],
);

const writeToolsFolder = mcpFolder(
  'Write Tools',
  'tools/call for mutating tools. Requires read-write PAT and staging. Run Setup first.',
  [
    mcpToolCall(
      'add_comment',
      20,
      'add_comment',
      {
        fileMsId: '{{fileMsId}}',
        message: 'Postman smoke test comment',
        versionInternalId: '{{versionInternalId}}',
      },
      'Add a file comment.',
    ),
    mcpToolCall(
      'add_comment (cell)',
      21,
      'add_comment',
      {
        fileMsId: '{{fileMsId}}',
        message: 'Postman cell-scoped comment',
        versionInternalId: '{{versionInternalId}}',
        cellReference: '{{cellAddress}}',
      },
      'Comment anchored to a cell.',
    ),
    mcpToolCall(
      'reply_to_comment',
      22,
      'reply_to_comment',
      {
        chatId: '{{chatId}}',
        message: 'Postman reply',
        versionInternalId: '{{versionInternalId}}',
      },
      'Reply to chatId from Setup. Skips gracefully if chatId unset.',
      [
        ...STANDARD_TOOL_CALL_TESTS,
        "if (!pm.collectionVariables.get('chatId')) {",
        "  pm.test.skip('No chatId — run Setup or add_comment first');",
        '}',
      ],
    ),
    mcpToolCall(
      'resolve_comment',
      23,
      'resolve_comment',
      { chatId: '{{chatId}}' },
      'Resolve comment thread.',
      [
        ...STANDARD_TOOL_CALL_TESTS,
        "if (!pm.collectionVariables.get('chatId')) {",
        "  pm.test.skip('No chatId — run Setup or add_comment first');",
        '}',
      ],
    ),
    mcpToolCall(
      'create_review_request',
      24,
      'create_review_request',
      {
        versionId: '{{versionInternalId}}',
        subject: 'Postman smoke test review',
        reviewerIds: ['{{userId}}'],
      },
      'Creates review; reviewerIds uses userId from /users/me.',
    ),
    mcpToolCall(
      'approve_review',
      25,
      'approve_review',
      { reviewId: '{{reviewId}}', notes: 'Approved via Postman' },
      'Approve pending review.',
      [
        ...STANDARD_TOOL_CALL_TESTS,
        "if (!pm.collectionVariables.get('reviewId')) {",
        "  pm.test.skip('No reviewId — run Setup or create_review_request first');",
        '}',
      ],
    ),
    mcpToolCall(
      'cancel_review',
      26,
      'cancel_review',
      { reviewId: '{{reviewId}}' },
      'Cancel pending review.',
      [
        ...STANDARD_TOOL_CALL_TESTS,
        "if (!pm.collectionVariables.get('reviewId')) {",
        "  pm.test.skip('No reviewId — run Setup or create_review_request first');",
        '}',
      ],
    ),
    mcpToolCall(
      'create_version',
      27,
      'create_version',
      {
        fileMsId: '{{fileMsId}}',
        versionType: 'patch',
        description: 'Postman smoke test version',
      },
      'Commit uncommitted changes (file must have live edits).',
    ),
    mcpToolCall(
      'discard_changes',
      28,
      'discard_changes',
      {
        fileMsId: '{{fileMsId}}',
        description: 'Discarded via Postman smoke test',
      },
      'Discard uncommitted changes.',
    ),
    mcpToolCall(
      'update_file_description',
      29,
      'update_file_description',
      { fileMsId: '{{fileMsId}}', name: 'Postman Test File' },
      'Rename enrolled file display name.',
    ),
  ],
);

const promptsFolder = mcpFolder(
  'MCP Prompts',
  'prompts/get for every registered prompt.',
  promptNames.map((name, index) =>
    mcpPromptGet(
      `prompts/get - ${name}`,
      40 + index,
      name,
      { fileMsId: '{{fileMsId}}' },
      `Expand prompt ${name} for fileMsId.`,
    ),
  ),
);

const resourceReads: ReturnType<typeof mcpResourceRead>[] = [
  mcpResourceRead(
    'resources/read - rockhopper://orchestration-guide',
    60,
    'rockhopper://orchestration-guide',
    'Static markdown orchestration guide.',
    [
      "pm.expect(pm.response.json().result.contents[0].mimeType).to.eql('text/markdown');",
    ],
  ),
  mcpResourceRead(
    'resources/read - rockhopper://files',
    61,
    'rockhopper://files',
    'Workspace file listing (JSON).',
    [
      "pm.expect(pm.response.json().result.contents[0].mimeType).to.eql('application/json');",
    ],
  ),
  mcpResourceRead(
    'resources/read - rockhopper://files/{fileMsId}',
    62,
    'rockhopper://files/{{fileMsId}}',
    'Single file metadata.',
  ),
  mcpResourceRead(
    'resources/read - rockhopper://files/{fileMsId}/versions',
    63,
    'rockhopper://files/{{fileMsId}}/versions',
    'Version list resource.',
  ),
  mcpResourceRead(
    'resources/read - rockhopper://versions/{versionId}',
    64,
    'rockhopper://versions/{{versionInternalId}}',
    'Single version metadata.',
  ),
  mcpResourceRead(
    'resources/read - rockhopper://files/{fileMsId}/comments',
    65,
    'rockhopper://files/{{fileMsId}}/comments',
    'Comments resource.',
  ),
  mcpResourceRead(
    'resources/read - rockhopper://versions/{versionId}/reviews',
    66,
    'rockhopper://versions/{{versionInternalId}}/reviews',
    'Reviews on a version.',
  ),
  mcpResourceRead(
    'resources/read - rockhopper://reviews/{reviewId}',
    67,
    'rockhopper://reviews/{{reviewId}}',
    'Single review resource.',
    [
      "if (!pm.collectionVariables.get('reviewId')) {",
      "  pm.test.skip('No reviewId from Setup');",
      '}',
    ],
  ),
  mcpResourceRead(
    'resources/read - rockhopper://files/{fileMsId}/changes',
    68,
    'rockhopper://files/{{fileMsId}}/changes',
    'Unattributed changes resource.',
  ),
];

const resourcesFolder = mcpFolder(
  'MCP Resources',
  `resources/read for ${staticResources.length} static + sample templated URIs.`,
  resourceReads,
);

const errorsFolder = mcpFolder('Error Handling', 'Negative cases.', [
  {
    name: '401 - missing Authorization',
    request: {
      method: 'GET',
      header: [],
      url: '{{BACKEND_URL}}/users/me',
      description: 'No Authorization header.',
    },
    event: [postmanEventTests(["pm.test('Status 401', () => pm.response.to.have.status(401));"])],
  },
  mcpToolCall(
    'tools/call - get_file_versions (missing fileMsId)',
    90,
    'get_file_versions',
    {},
    'Tool error when required fileMsId omitted.',
    [
      "pm.test('Status 200', () => pm.response.to.have.status(200));",
      'const r = pm.response.json();',
      "pm.test('Tool error content', () => {",
      "  const text = (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '';",
      "  pm.expect(text.length).to.be.above(0);",
      '});',
    ],
  ),
  {
    name: '404 - nonexistent file (REST)',
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{ROCKHOPPER_PAT}}' }],
      url: '{{BACKEND_URL}}/enrolled-files/00000000-0000-0000-0000-000000000000',
    },
    event: [
      postmanEventTests([
        'const code = pm.response.code;',
        "pm.test('404 or 400', () => pm.expect([400, 404]).to.include(code));",
      ]),
    ],
  },
  mcpRequest(
    'tools/call - unknown tool',
    91,
    'tools/call',
    { name: 'nonexistent_tool', arguments: {} },
    'JSON-RPC error for unknown tool name.',
    [
      'const r = pm.response.json();',
      "pm.test('Has error', () => pm.expect(r.error || (r.result && r.result.isError)).to.exist);",
    ],
  ),
]);

const collection = {
  info: {
    name: 'Rockhopper MCP Server (full)',
    description,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    setupFolder,
    protocolFolder,
    readToolsFolder,
    writeToolsFolder,
    promptsFolder,
    resourcesFolder,
    errorsFolder,
  ],
  // GATEWAY_URL and BACKEND_URL are intentionally omitted — set them via the
  // active Postman environment (staging / dev / production / local), not here.
  variable: [
    { key: 'ROCKHOPPER_PAT', value: '' },
    { key: 'fileMsId', value: '' },
    { key: 'versionInternalId', value: '' },
    { key: 'chatId', value: '' },
    { key: 'reviewId', value: '' },
    { key: 'userId', value: '' },
    { key: 'searchQuery', value: 'a' },
    { key: 'sheetName', value: 'Sheet1' },
    { key: 'cellAddress', value: 'A1' },
  ],
};

const outPath = resolve(process.cwd(), 'postman', 'mcp-server-full.postman_collection.json');
writeFileSync(outPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

const toolCallCount = readToolsFolder.item!.length + writeToolsFolder.item!.length;
console.log(
  `Wrote ${outPath} (tools=${toolNames.length}, tool_calls=${toolCallCount}, prompts=${promptNames.length}, resource_reads=${resourceReads.length})`,
);
