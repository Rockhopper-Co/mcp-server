import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type EnvironmentSeed = {
  fileName: string;
  name: string;
  gatewayUrl: string;
  backendUrl?: string;
  /** If true, emit only the two variables a public consumer needs. */
  publicTemplate?: boolean;
};

const seeds: EnvironmentSeed[] = [
  {
    fileName: 'local.postman_environment.json',
    name: 'Rockhopper MCP Local',
    gatewayUrl: 'http://localhost:8080',
    backendUrl: 'http://localhost:3000',
  },
  {
    fileName: 'dev.postman_environment.json',
    name: 'Rockhopper MCP Dev',
    gatewayUrl: 'https://mcp-dev.rockhopper.co',
    backendUrl: 'https://api-dev.rockhopper.co',
  },
  {
    fileName: 'staging.postman_environment.json',
    name: 'Rockhopper MCP Staging',
    gatewayUrl: 'https://mcp-staging.rockhopper.co',
    backendUrl: 'https://api-staging.rockhopper.co',
  },
  {
    fileName: 'production.postman_environment.json',
    name: 'Rockhopper MCP Production',
    gatewayUrl: 'https://mcp.rockhopper.co',
    backendUrl: 'https://api.rockhopper.co',
  },
  {
    fileName: 'public.postman_environment.json',
    name: 'Production (template)',
    gatewayUrl: 'https://mcp.rockhopper.co',
    publicTemplate: true,
  },
];

for (const seed of seeds) {
  const publicValues = [
    {
      key: 'GATEWAY_URL',
      value: seed.gatewayUrl,
      enabled: true,
      type: 'default',
    },
    {
      key: 'ROCKHOPPER_PAT',
      value: 'YOUR_PAT_HERE',
      enabled: true,
      type: 'secret',
    },
  ];

  /**
   * OAuth route paths must match `mcp-gateway/src/oauth.ts` exactly:
   *   /authorize, /token, /register  (NO `/oauth/` prefix).
   * A leading `/oauth/` prefix was committed in error before 2026-05-11 and
   * would 404 against the live gateway.
   */
  const internalValues = [
    { key: 'GATEWAY_URL', value: seed.gatewayUrl, enabled: true },
    { key: 'BACKEND_URL', value: seed.backendUrl ?? '', enabled: true },
    {
      key: 'ROCKHOPPER_PAT',
      value: '',
      enabled: true,
      type: 'secret',
    },
    {
      key: 'OAUTH_AUTHORIZE_URL',
      value: `${seed.gatewayUrl}/authorize`,
      enabled: true,
    },
    {
      key: 'OAUTH_TOKEN_URL',
      value: `${seed.gatewayUrl}/token`,
      enabled: true,
    },
    {
      key: 'OAUTH_REGISTER_URL',
      value: `${seed.gatewayUrl}/register`,
      enabled: true,
    },
  ];

  const environment = {
    name: seed.name,
    _postman_variable_scope: 'environment',
    _postman_exported_at: '2026-05-11T00:00:00.000Z',
    _postman_exported_using: 'rockhopper postman generator',
    values: seed.publicTemplate ? publicValues : internalValues,
  };

  const outPath = resolve(process.cwd(), 'postman', seed.fileName);
  writeFileSync(outPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}
