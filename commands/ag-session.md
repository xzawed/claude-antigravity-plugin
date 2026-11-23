---
description: Manage persistent multi-turn Antigravity stream-json sessions for zero cold-start latency and high cache-hit token savings
argument-hint: "<start [prompt] [--model <id>] [--effort <lvl>] [--dangerously-skip-permissions] | send [sessionId] <prompt> | list | close [sessionId]>"
---

# `/ag-session` — Persistent Multi-Turn Antigravity Sessions

Run a warm, long-lived Antigravity CLI process (`agy --input-format stream-json --output-format stream-json`) via `ag_session` so follow-up turns execute with zero startup overhead and maximum prompt-cache reuse.

## Syntax

- `/ag-session start [initial prompt] [--model <id>] [--effort <lvl>] [--agent <name>] [--agy-mode accept-edits|auto|plan] [--dangerously-skip-permissions] [--sandbox|--no-sandbox] [--add-dir <dir>]`
- `/ag-session send [sessionId] <prompt>` *(omitting `sessionId` targets the most recently active session in this workspace)*
- `/ag-session list` *(show all active sessions, turn counts, cumulative tokens, cache hits, and conversation IDs)*
- `/ag-session close [sessionId]` *(gracefully close the session and display final cumulative token metrics)*

## Execution Procedure

1. Parse the subcommand (`start`, `send`, `list`, `close`) and optional flags from `$ARGUMENTS`.
2. Call `ag_session({ action, ... })`.
3. Present:
   - `sessionId`, `conversationId`, `model`, `permissionMode`, `gitCheckpointRef`
   - Turn `response` (and `structuredOutput` if `--json-schema` was configured)
   - Cumulative `numTurns`, `durationSeconds`, and `usage` (highlighting `cacheReadTokens` savings across turns!)
   - Remind the user to run `/ag-session close <sessionId>` when finished to free the background worker.
