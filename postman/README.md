# Postman artifacts (generated)

This folder contains Postman collection and environment JSON files generated
from MCP server tool/resource/prompt definitions. The canonical home for
these files is `mcp-gateway/postman/` — copy them there after regenerating.

## Regenerate

```bash
npm run generate:postman
```

Then copy the output to `mcp-gateway/postman/`.

## CI

`npm run generate:postman:check` verifies generated artifacts are up to date.

## Variables

- `GATEWAY_URL` — MCP gateway base URL (per environment)
- `BACKEND_URL` — Rockhopper API base URL (per environment)
- `ROCKHOPPER_PAT` — Personal Access Token (`rh_pat_...`)
- `OAUTH_*` — OAuth URLs (for reference; not needed for PAT-based testing)
