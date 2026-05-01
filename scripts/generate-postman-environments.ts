import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type EnvironmentSeed = {
  fileName: string;
  name: string;
  gatewayUrl: string;
  backendUrl: string;
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
];

for (const seed of seeds) {
  const environment = {
    name: seed.name,
    _postman_variable_scope: 'environment',
    _postman_exported_at: '2026-04-26T00:00:00.000Z',
    _postman_exported_using: 'rockhopper postman generator',
    values: [
      { key: 'GATEWAY_URL', value: seed.gatewayUrl, enabled: true },
      { key: 'BACKEND_URL', value: seed.backendUrl, enabled: true },
      {
        key: 'ROCKHOPPER_PAT',
        value: '',
        enabled: true,
        type: 'secret',
      },
      {
        key: 'OAUTH_AUTHORIZE_URL',
        value: `${seed.gatewayUrl}/oauth/authorize`,
        enabled: true,
      },
      {
        key: 'OAUTH_TOKEN_URL',
        value: `${seed.gatewayUrl}/oauth/token`,
        enabled: true,
      },
      {
        key: 'OAUTH_REGISTER_URL',
        value: `${seed.gatewayUrl}/oauth/register`,
        enabled: true,
      },
    ],
  };

  const outPath = resolve(process.cwd(), 'postman', seed.fileName);
  writeFileSync(outPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}
