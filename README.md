# Rockhopper MCP Server

MCP (Model Context Protocol) server for Rockhopper. Lets AI tools like Claude, Cursor, and Copilot interact with your Rockhopper workspace — enrolled files, version history, reviews, comments, and cell-level change tracking.

## Prerequisites

- Node.js 20+
- A Rockhopper account with at least one enrolled file
- (Optional) A Personal Access Token — only required for headless / CI / scripted setups

## Authentication

The server supports two auth modes. **OAuth (recommended)** is the default — no token to copy and paste. **PAT** stays available for headless scenarios.

### OAuth (recommended)

On first launch, the server prints a short verification code to stderr and a URL to visit. Sign in once in your browser — the resulting bearer token is stored in your OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). Subsequent launches pick the token up silently.

Nothing to configure — just launch the server with no `ROCKHOPPER_TOKEN` set:

```bash
npx @rockhopper-co/mcp-server
```

You'll see (on stderr):

```
Rockhopper — sign in to authorize this MCP client.
Open: https://app.rockhopper.co/device?user_code=ABCD2345
(or visit https://app.rockhopper.co/device and enter code: ABCD2345)
```

Tokens default to a 60-minute lifetime. When yours expires, the next launch silently re-runs the device flow.

> **Linux**: requires `libsecret` to be installed (`apt-get install libsecret-1-dev` on Debian/Ubuntu, `dnf install libsecret` on Fedora). If unavailable, fall back to the PAT path below.

### Personal Access Token (headless / CI)

For non-interactive setups, generate a PAT in the Rockhopper web app under **Settings > Personal Access Tokens** (`read-only` or `read-write` scope) and set it as `ROCKHOPPER_TOKEN`. PATs take precedence over OAuth — if `ROCKHOPPER_TOKEN` is set, the device-grant flow is skipped.

## Setup

### 1. Install

```bash
npm install -g @rockhopper-co/mcp-server
```

Or run directly with npx:

```bash
npx @rockhopper-co/mcp-server
```

### 2. Configure your AI tool

#### Claude Desktop / Claude Code

Add to your MCP config (`~/.claude/mcp.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "rockhopper": {
      "command": "npx",
      "args": ["-y", "@rockhopper-co/mcp-server"],
      "env": {
        "ROCKHOPPER_API_URL": "https://api.rockhopper.co"
      }
    }
  }
}
```

Leave `ROCKHOPPER_TOKEN` out to use OAuth (recommended). Set it if you want PAT auth instead.

#### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "rockhopper": {
      "command": "npx",
      "args": ["-y", "@rockhopper-co/mcp-server"],
      "env": {
        "ROCKHOPPER_API_URL": "https://api.rockhopper.co"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ROCKHOPPER_TOKEN` | No | — | Personal Access Token (starts with `rh_pat_`). When unset, OAuth device-grant flow runs on first launch. |
| `ROCKHOPPER_API_URL` | No | `https://api.rockhopper.co` | Rockhopper API base URL |
| `ROCKHOPPER_MCP_LOG_DIR` | No | `~/.rockhopper/mcp-server/` | Directory for the local diagnostic logfile (see below). |
| `ROCKHOPPER_MCP_LOG_DISABLE` | No | — | Set truthy (`1` / `true`) to disable local diagnostic logging entirely. |
| `ROCKHOPPER_MCP_LOG_LEVEL` | No | `info` | Diagnostic log level (`fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent`). |

## Diagnostic Logging

The server writes a **local diagnostic logfile** to `~/.rockhopper/mcp-server/`
(rotated, size-capped at ~5 MB × 5 files, named `mcp-server.<n>.log`). It
records request latency and the client-side failures the API never sees —
network-unreachable errors, local auth rejections, response schema drift, and
uncaught crashes — so you can hand the file to Rockhopper support when
something misbehaves.

- **Local only.** Nothing is transmitted anywhere — the file stays on your
  machine. There is no remote telemetry.
- **Redacted.** Tokens, the `Authorization` header, request/response bodies,
  tool arguments, and cell data are **never** written. Lines carry only
  event name, HTTP method, URL pathname (no query string), status code,
  duration, tool name, a correlation id, and error type/message.
- **Configurable.** Point it elsewhere with `ROCKHOPPER_MCP_LOG_DIR`, change
  verbosity with `ROCKHOPPER_MCP_LOG_LEVEL`, or turn it off with
  `ROCKHOPPER_MCP_LOG_DISABLE=1`. If the file can't be opened, logging
  silently disables — it never interferes with the server.

## Postman

A starter Postman collection + environment files are available in
`postman/` for gateway smoke testing (`/healthz`, `/mcp initialize`,
`/mcp tools/list`) across local/dev/staging/production.

Regenerate artifacts with:

```bash
npm run generate:postman
```

## Available Tools

| Tool | Description |
|------|-------------|
| `list_files` | List enrolled Excel files with optional search filter |
| `get_file_versions` | Get version history for a specific file |
| `get_file_comments` | Get comments and threaded discussions on a file |
| `get_reviews` | Get review requests for a version or file |
| `get_cell_history` | Get change history for a specific cell across versions |
| `search_files` | Search files **already enrolled** in Rockhopper, by name |
| `search_drive_files` | Find a workbook in the user's own OneDrive / SharePoint, including files Rockhopper has never seen; returns candidates to confirm with the user before `enroll_file` |
| `get_unattributed_changes` | Get pending cell changes not yet committed to a version |

## Available Resources

| Resource | URI | Description |
|----------|-----|-------------|
| Enrolled Files | `rockhopper://files` | All enrolled files in workspace |
| File Detail | `rockhopper://files/{fileMsId}` | Details for a specific file |
| File Versions | `rockhopper://files/{fileMsId}/versions` | Version history for a file |
| Version Detail | `rockhopper://versions/{versionId}` | Single version details |
| File Comments | `rockhopper://files/{fileMsId}/comments` | Comments on a file |
| Version Reviews | `rockhopper://versions/{versionId}/reviews` | Reviews for a version |
| Review Detail | `rockhopper://reviews/{reviewId}` | Single review details |
| Team Detail | `rockhopper://teams/{teamId}` | Team details with members |
| Unattributed Changes | `rockhopper://files/{fileMsId}/changes` | Pending changes |

## Available Prompts

| Prompt | Description |
|--------|-------------|
| `summarize-file-changes` | Summarize recent version changes and unattributed edits for a file |
| `pending-reviews` | Show all pending review requests for the latest version of a file |
| `unresolved-comments` | List all unresolved comments on a file for follow-up |
| `file-overview` | Comprehensive overview: versions, comments, reviews, and changes |

## Write Tools (requires `read-write` scope)

| Tool | Description |
|------|-------------|
| `create_version` | Commit uncommitted changes as a new semver version (major/minor/patch) |
| `discard_changes` | Discard all uncommitted changes, revert to latest committed version |
| `add_comment` | Add a comment to an enrolled file (optionally at a cell) |
| `reply_to_comment` | Reply to an existing comment thread |
| `resolve_comment` | Mark a comment as resolved (author only) |
| `create_review_request` | Request a review on a file version |
| `approve_review` | Approve a review request (assigned reviewer only) |
| `cancel_review` | Cancel a pending review request (requester only) |
| `update_file_description` | Update the display name of an enrolled file |

## Identifiers

Users and teams are named by a **uuid** (`id`) — for example `0198f3a1-2b4c-7d8e-9f01-23456789abcd`. This is the identifier to send as a `reviewerIds` entry on `create_review_request`, and as `{teamId}` in `rockhopper://teams/{teamId}`. Read it from the team resource, where every record carries both an `id` (uuid) and an `internalId` (number).

The legacy numeric `internalId` is **also accepted** for users and teams, and the two spellings can be mixed in one `reviewerIds` array — nothing you have written today stops working. It is accepted until **2027-09-14** and removed after, so migrate to the uuid before then.

Everything else keeps its existing type: `fileMsId` is a string, and version and comment ids stay numeric.

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (auto-restart on changes)
npm run dev

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## Security

- Tokens are scoped to the creating user — the MCP server can only access data the user has permission to see
- `read-only` tokens cannot perform write operations (comments, reviews)
- All API calls go through Rockhopper's existing authorization guards
- Tokens can be revoked instantly from the Settings page
- The MCP server runs locally and communicates with the API over HTTPS

## Architecture

```
AI Tool (Claude/Cursor) <--stdio--> mcp-server <--HTTPS--> Rockhopper API <--> PostgreSQL
```

The MCP server is a thin adapter. It translates MCP tool/resource requests into Rockhopper REST API calls, authenticated with the user's PAT. All authorization is enforced server-side — the MCP server has no direct database access.
