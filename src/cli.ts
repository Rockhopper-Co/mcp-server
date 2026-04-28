#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient } from './api-client.js';
import { createServer } from './server.js';

const ROCKHOPPER_API_URL =
  process.env.ROCKHOPPER_API_URL || 'https://api.rockhopper.co';
const ROCKHOPPER_TOKEN = process.env.ROCKHOPPER_TOKEN;

if (!ROCKHOPPER_TOKEN) {
  console.error(
    'Error: ROCKHOPPER_TOKEN environment variable is required.\n' +
      'Create a Personal Access Token in Rockhopper Settings and set it as ROCKHOPPER_TOKEN.',
  );
  process.exit(1);
}

if (!ROCKHOPPER_TOKEN.startsWith('rh_pat_')) {
  console.error(
    'Error: ROCKHOPPER_TOKEN does not look like a valid Personal Access Token.\n' +
      'Tokens start with "rh_pat_". Check that the full token was copied correctly.',
  );
  process.exit(1);
}

const apiClient = new ApiClient({
  baseUrl: ROCKHOPPER_API_URL,
  token: ROCKHOPPER_TOKEN,
});

try {
  await apiClient.getMe();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('401') || msg.includes('403')) {
    console.error(
      'Error: ROCKHOPPER_TOKEN is invalid or expired.\n' +
        'Create a new Personal Access Token in Rockhopper Settings and set it as ROCKHOPPER_TOKEN.',
    );
  } else {
    console.error(
      `Error: Could not reach Rockhopper API at ${ROCKHOPPER_API_URL}.\n` +
        `Details: ${msg}`,
    );
  }
  process.exit(1);
}

const server = createServer(apiClient);

const transport = new StdioServerTransport();
await server.connect(transport);
