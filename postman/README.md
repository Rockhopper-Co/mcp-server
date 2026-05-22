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
- `mcp-server-full.postman_collection.json` — **full test suite**: REST setup,
  MCP protocol, every `tools/call`, every `prompts/get`, sample `resources/read`,
  and negative cases. Generated from `src/`; use this to exercise all 16 tools.
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

## Full collection workflow

1. Import `mcp-server-full.postman_collection.json` and pick an environment (`staging`, `dev`, `production`, `local`). That environment sets `GATEWAY_URL` and `BACKEND_URL` — the collection does not hardcode them.
2. Set `ROCKHOPPER_PAT` (read-write for **Write Tools**).
3. Run **Setup (REST)** → **MCP Protocol** → **Read Tools** / **MCP Prompts** / **MCP Resources**.
4. **Write Tools** only on staging — they create comments, reviews, and versions.

Tool responses use `result.content[0].text` (markdown summaries), not JSON arrays.
Setup uses REST to populate `fileMsId`, `versionInternalId`, `chatId`, `reviewId`, and `userId`.

## Why two collections?

The minimal collection stays small for the public Postman API Network workspace.
The full collection is regenerated from source (`scripts/generate-postman-collection-full.ts`)
so every tool stays in sync without hand-maintaining 50+ requests.
