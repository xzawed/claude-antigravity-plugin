---
description: Trigger Antigravity's native /boost deep multi-perspective reasoning loop with high/max effort
argument-hint: "<complex coding or research task> [--paths p1,p2] [--model <id>] [--effort high|xhigh|max] [--dangerously-skip-permissions] [--bg]"
---

# `/ag-boost` — Deep Multi-Perspective Reasoning via Antigravity `/boost`

Invoke Antigravity's native `/boost` workflow for complex debugging, architecture design, multi-file refactoring, or deep root-cause research.

## Execution Procedure

1. Parse `$ARGUMENTS` for the task objective and optional `--paths`, `--model`, `--effort` (default `"high"`), `--dangerously-skip-permissions`, `--timeout` (default `600`), and `--bg` (run asynchronously via `start_ag_task`).
2. Compose the native `/boost` prompt:
   ```text
   /boost <task objective>
   ```
   (If `--paths` was provided, append: `Restrict code edits strictly to: <paths>.`)
3. Call `delegate_to_antigravity` (or `start_ag_task` if `--bg` is set) with:
   - `title`: `"Antigravity Boost: <short summary>"`
   - `instructions`: the `/boost ...` prompt (do **NOT** set `disableSlashCommands: true`)
   - `rawPrompt`: `true`
   - `modeOverride`: `"subscription"`
   - `effort`: parsed effort or `"high"`
   - `lockedPaths`: parsed paths (if any)
   - `timeoutSec`: parsed timeout or `600`
   - Pass through `model`, `dangerouslySkipPermissions`, `sandbox`, `addDirs`.
4. Present the report, changed files, `conversationId`, and token usage summary.
