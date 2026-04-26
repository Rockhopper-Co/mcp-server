# Postman setup (Rockhopper MCP workspace)

This folder contains generated Postman artifacts for the Rockhopper MCP
workspace.

## Files

- `mcp-server.postman_collection.json`
- `local.postman_environment.json`
- `dev.postman_environment.json`
- `staging.postman_environment.json`
- `production.postman_environment.json`

## Import

1. Postman -> Import -> select the collection JSON.
2. Import one or more environment JSON files.
3. Pick an environment (Dev/Staging/Production).
4. If your target requires auth, set `ACCESS_TOKEN` and enable the
   `Authorization: Bearer {{ACCESS_TOKEN}}` header on MCP requests.

## Regenerate

Run from repo root:

```bash
npm run generate:postman
```

CI enforces that generated artifacts are up to date using
`npm run generate:postman:check`.

## Smoke flow

1. Run `Healthz` (expect 200).
2. Run `MCP Initialize`.
3. Run `MCP Tools List`.

## Notes

- The MCP endpoint is `POST /mcp`.
- `Healthz` is unauthenticated.
- OAuth and token issuance flow is environment-dependent; this collection
  assumes you already have an access token when auth is required.
