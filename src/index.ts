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

const apiClient = new ApiClient({
  baseUrl: ROCKHOPPER_API_URL,
  token: ROCKHOPPER_TOKEN,
});

const server = createServer(apiClient);

const transport = new StdioServerTransport();
await server.connect(transport);
