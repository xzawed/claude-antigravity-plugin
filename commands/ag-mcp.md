---
description: List, add, remove, enable, disable, or sync Claude Code .mcp.json servers into Antigravity CLI (agy mcp)
argument-hint: "<list | add <name> <commandOrUrl> [args...] | remove <name> | enable <name> | disable <name> | sync [--apply]>"
---

# `/ag-mcp` — Manage & Sync Antigravity CLI MCP Servers

Manage Antigravity's configured MCP servers (`agy mcp`) directly from Claude Code using `ag_cli_admin`.

## Syntax

- `/ag-mcp` or `/ag-mcp list` — List all MCP servers configured in Antigravity (`agy mcp list`)
- `/ag-mcp add <name> <commandOrUrl> [args...] [--type stdio|http] [--env KEY=VAL] [--header "Key: Value"]`
- `/ag-mcp remove <name>`
- `/ag-mcp enable <name>` / `/ag-mcp disable <name>`
- `/ag-mcp sync` — Dry-run preview syncing servers from the workspace's `.mcp.json` into Antigravity (automatically skips `antigravity-delegate` to prevent recursive loops)
- `/ag-mcp sync --apply` — Execute the sync plan (`dryRun: false`)

## Execution Procedure

1. Map `$ARGUMENTS` to `ag_cli_admin({ action: "mcp_list" | "mcp_add" | "mcp_remove" | "mcp_enable" | "mcp_disable" | "mcp_sync_from_claude", ... })`.
2. Never print raw API keys or secrets; present the sanitized output or sync summary table cleanly.
