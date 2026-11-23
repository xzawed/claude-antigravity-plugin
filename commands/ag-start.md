---
description: Launch an Antigravity delegation task asynchronously in the background so Claude Code can keep working in parallel
argument-hint: "<task instructions> [--paths p1,p2] [--url http://...] [--model <id>] [--effort <lvl>] [--dangerously-skip-permissions] [--timeout <sec>]"
---

# `/ag-start` — Asynchronous Background Delegation to Antigravity

Dispatch a task to Antigravity without blocking your Claude Code session, using the `start_ag_task` MCP tool.

## Execution Procedure

1. Parse `$ARGUMENTS` using the same flags as `/ag-delegate` (`--paths`, `--url`, `--mode`, `--model`, `--effort`, `--agent`, `--agy-mode`, `--sandbox`/`--no-sandbox`, `--dangerously-skip-permissions`, `--add-dir`, `--continue`, `--conversation`, `--project`, `--remote-agent`, `--json-schema`, `--disable-slash-commands`, `--settings`, `--timeout`).
2. Call `start_ag_task(...)` with least-privilege `lockedPaths` whenever files will be edited.
3. Immediately report:
   - **`jobId` / `taskId`**
   - Active engine (`subscription` or `api`) & Git Guard `gitCheckpointRef`
   - Remind the user they can continue working in Claude Code in parallel, inspect/collect results with `/ag-jobs <jobId>`, or stop early with `/ag-cancel <jobId>`.
