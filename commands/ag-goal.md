---
description: Run Antigravity's native /goal autonomous loop until all acceptance criteria are verified complete
argument-hint: "<goal & verification criteria> [--paths p1,p2] [--url http://...] [--model <id>] [--effort <lvl>] [--dangerously-skip-permissions] [--bg]"
---

# `/ag-goal` — Autonomous Verified-Until-Done Execution via Antigravity `/goal`

Delegate a long-horizon objective to Antigravity's native `/goal` loop, which iterates autonomously until build, tests, and verification criteria are fully satisfied.

## Execution Procedure

1. Parse `$ARGUMENTS` for the objective and optional `--paths`, `--url`, `--model`, `--effort`, `--dangerously-skip-permissions`, `--timeout` (default `900`), and `--bg` (recommended via `start_ag_task`).
2. Compose the native `/goal` prompt:
   ```text
   /goal <objective>
   ```
   (Include `verifyUrl` and `lockedPaths` constraints if provided.)
3. Call `delegate_to_antigravity` (or `start_ag_task` if `--bg` is set) with:
   - `title`: `"Antigravity Goal: <short summary>"`
   - `instructions`: the `/goal ...` prompt (do **NOT** set `disableSlashCommands: true`)
   - `rawPrompt`: `true`
   - `modeOverride`: `"subscription"`
   - `verifyUrl`, `lockedPaths`, `model`, `effort`, `dangerouslySkipPermissions`, `timeoutSec` (default `900`).
4. Summarize verified deliverables, changed files, token usage, and `conversationId`.
