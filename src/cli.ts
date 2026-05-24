#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient } from './api-client.js';
import {
  AuthResolutionError,
  resolveAuth,
} from './auth/resolve-auth.js';
import { createServer } from './server.js';

const ROCKHOPPER_API_URL =
  process.env.ROCKHOPPER_API_URL || 'https://api.rockhopper.co';

// ENG-1444: auth resolution order is
//   1. ROCKHOPPER_TOKEN env var (Personal Access Token — headless / CI)
//   2. Stored OAuth bundle in the OS keychain (prior device-grant flow)
//   3. Device-grant flow (prints code to stderr, polls for approval)
let resolved;
try {
  resolved = await resolveAuth({
    baseUrl: ROCKHOPPER_API_URL,
    patFromEnv: process.env.ROCKHOPPER_TOKEN,
  });
} catch (err) {
  if (err instanceof AuthResolutionError) {
    if (err.code === 'pat_malformed') {
      console.error(`Error: ${err.message}`);
      console.error(
        'Tokens start with "rh_pat_". Check that the full token was copied correctly.',
      );
    } else if (err.code === 'device_grant_failed') {
      console.error(`Error: Could not complete sign-in.\n${err.message}`);
      console.error(
        'You can also set ROCKHOPPER_TOKEN to a Personal Access Token (Settings → Personal Access Tokens) and re-launch.',
      );
    } else {
      console.error(`Error: ${err.message}`);
    }
  } else {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.exit(1);
}

const apiClient = new ApiClient({
  baseUrl: ROCKHOPPER_API_URL,
  token: resolved.accessToken,
});

try {
  await apiClient.getMe();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('401') || msg.includes('403')) {
    if (resolved.source === 'pat') {
      console.error(
        'Error: ROCKHOPPER_TOKEN is invalid or expired.\n' +
          'Create a new Personal Access Token in Rockhopper Settings and set it as ROCKHOPPER_TOKEN.',
      );
    } else {
      console.error(
        `Error: Stored OAuth token is invalid (source: ${resolved.source}).\n` +
          'Re-launch the MCP server — it will run the device-grant flow again.',
      );
    }
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
