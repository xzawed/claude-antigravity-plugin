---
description: Launch Antigravity's native /swarm multi-worker parallel team with automatic Git Guard checkpoint protection
argument-hint: "<large parallel project task> [--paths p1,p2] [--model <id>] [--effort <lvl>] [--dangerously-skip-permissions] [--bg]"
---

# `/ag-swarm` — Parallel Multi-Worker Swarm via Antigravity `/swarm`

Delegate large multi-module implementation or refactoring tasks to Antigravity's native `/swarm` (coordinated workers + verifier on a shared board), protected by a lossless Git Guard checkpoint.

## Execution Procedure

1. Parse `$ARGUMENTS` for the task objective and optional `--paths`, `--model`, `--effort`, `--dangerously-skip-permissions`, `--timeout` (default `900`), and `--bg` (recommended for long swarms via `start_ag_task`).
2. Compose the native `/swarm` prompt:
   ```text
   /swarm <task objective>
   ```
   (If `--paths` was provided, append: `Restrict file modifications to: <paths>.`)
3. Call `delegate_to_antigravity` (or `start_ag_task` if `--bg` is set) with:
   - `title`: `"Antigravity Swarm: <short summary>"`
   - `instructions`: the `/swarm ...` prompt (do **NOT** set `disableSlashCommands: true`)
   - `rawPrompt`: `true`
   - `modeOverride`: `"subscription"`
   - `lockedPaths`: parsed paths (if any)
   - `timeoutSec`: parsed timeout or `900`
   - Pass through `model`, `effort`, `dangerouslySkipPermissions`, `sandbox`, `addDirs`.
4. Report the swarm outcome, changed files, token usage, `gitCheckpointRef`, and remind the user `/ag-rollback <taskId>` can restore everything cleanly if needed.
