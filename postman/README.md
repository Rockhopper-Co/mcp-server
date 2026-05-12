# Postman artifacts (generated)

This folder is the **canonical home** of the Rockhopper MCP Postman collection
and environment JSON files. They are regenerated from the live tool / resource
/ prompt registry in `src/`. `mcp-gateway/postman/` (if it still exists at the
time you read this) is stale and slated for deletion.

## What ships

The Postman public workspace's headline is a single first-class **MCP Request**
created via Postman's web UI (transport=HTTP, URL `{{GATEWAY_URL}}/mcp`,
Bearer auth). That request's "Load Capabilities" button discovers the server's
tools, resources, and prompts at runtime — Postman's MCP UI handles the JSON-RPC
envelope, args input, and session state for you.

The committed JSON in this folder ships:

- `mcp-server.postman_collection.json` — minimal 3-item raw-protocol smoke set
  (`Healthz`, `MCP Initialize`, `MCP Tools List`) plus a rich description that
  points consumers at the MCP Request UI flow. Every published vendor MCP
  collection on the Postman API Network (HubSpot, AWS Labs, Stripe, etc.) is
  built around a single MCP Request — we follow the same pattern.
- 5 environment files:
  - `local`, `dev`, `staging`, `production` — internal use (6 vars including
    `BACKEND_URL` + `OAUTH_*_URL`s).
  - `public` — 2-var template (`GATEWAY_URL` + `ROCKHOPPER_PAT`) matching the
    public workspace's "Production (template)" environment.

## Regenerate

```bash
npm run generate:postman
```

This writes the JSON files in-place. CI runs `generate:postman:check` to verify
no drift between source code and committed JSON.

## Variables

- `GATEWAY_URL` — MCP gateway base URL (per environment)
- `ROCKHOPPER_PAT` — Personal Access Token (`rh_pat_...`)
- `BACKEND_URL` — Rockhopper API base URL (internal envs only)
- `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`, `OAUTH_REGISTER_URL` — OAuth 2.0
  endpoints from `mcp-gateway/src/oauth.ts`. Reference only; PAT-based testing
  doesn't need them.

## Why no per-tool requests?

The previous generator emitted 34 hand-crafted HTTP POST requests with raw
JSON-RPC bodies — one per tool/resource/prompt. Two bugs in the generator
caused ~80% of those to fail on Send (empty `arguments: {}`, object-shaped
resource URIs). The whole pattern was pre-mid-2025 legacy; Postman now has a
first-class MCP Request type whose UI discovers everything at runtime. See
[`knowledge-base/docs/plans/postman-mcp-request-rebuild.md`](../../knowledge-base/docs/plans/postman-mcp-request-rebuild.md)
for the full migration rationale and benchmark against peer vendor collections.
