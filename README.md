# Rockhopper MCP Server

MCP (Model Context Protocol) server for Rockhopper. Lets AI tools like Claude, Cursor, and Copilot interact with your Rockhopper workspace — enrolled files, version history, reviews, comments, and cell-level change tracking.

## Prerequisites

- Node.js 18+
- A Rockhopper account with at least one enrolled file
- A Personal Access Token (PAT) from Rockhopper

## Setup

### 1. Create a Personal Access Token

In the Rockhopper web app, go to **Settings > Personal Access Tokens** and create a new token. Choose `read-only` scope for read access or `read-write` if you also want to add comments/reviews.

Copy the token — it's shown only once.

### 2. Install

```bash
npm install -g @rockhopper-co/mcp-server
```

Or run directly with npx:

```bash
npx @rockhopper-co/mcp-server
```

### 3. Configure your AI tool

#### Claude Desktop / Claude Code

Add to your MCP config (`~/.claude/mcp.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "rockhopper": {
      "command": "npx",
      "args": ["-y", "@rockhopper-co/mcp-server"],
      "env": {
        "ROCKHOPPER_TOKEN": "rh_pat_your_token_here",
        "ROCKHOPPER_API_URL": "https://api.rockhopper.co"
      }
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "rockhopper": {
      "command": "npx",
      "args": ["-y", "@rockhopper-co/mcp-server"],
      "env": {
        "ROCKHOPPER_TOKEN": "rh_pat_your_token_here",
        "ROCKHOPPER_API_URL": "https://api.rockhopper.co"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ROCKHOPPER_TOKEN` | Yes | — | Personal Access Token (starts with `rh_pat_`) |
| `ROCKHOPPER_API_URL` | No | `https://api.rockhopper.co` | Rockhopper API base URL |

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
| `search_files` | Search enrolled files by name |
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
| `add_comment` | Add a comment to an enrolled file (optionally at a cell) |
| `reply_to_comment` | Reply to an existing comment thread |
| `resolve_comment` | Mark a comment as resolved (author only) |
| `create_review_request` | Request a review on a file version |
| `approve_review` | Approve a review request (assigned reviewer only) |
| `update_file_description` | Update the display name of an enrolled file |

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
