---
description: View or update Antigravity delegation settings including permissions (--dangerously-skip-permissions), agy model/effort/agent, and sandbox (.ag-bridge/config.json)
argument-hint: "[mode|model|agy-model|agy-mode|effort|agent|sandbox|skip-permissions|timeout|max-turns|git-guard <value>]"
---

# `/ag-config` — Configure Antigravity Mode, CLI Flags, Permissions & Guardrails

Inspect or update `.ag-bridge/config.json` in the current workspace.

## Supported Subcommands

- `/ag-config` — Display current `.ag-bridge/config.json` and active resolved environment.
- `/ag-config mode <auto|subscription|api>` — Set `execution_mode`.
- `/ag-config agy-mode <accept-edits|auto|plan>` — Set `subscription.agy_mode`.
- `/ag-config agy-model <model-id>` — Set default `subscription.agy_model` (run `/ag-models` to list available IDs).
- `/ag-config effort <low|medium|high|xhigh|max>` — Set default `subscription.agy_effort`.
- `/ag-config agent <name>` — Set default `subscription.agy_agent`.
- `/ag-config sandbox <true|false>` — Enable/disable `subscription.agy_sandbox` (`--sandbox`).
- `/ag-config skip-permissions <true|false>` — Enable/disable `subscription.agy_dangerously_skip_permissions` (`--dangerously-skip-permissions`, sets `agy` to `always-proceed`).
- `/ag-config stream-heartbeat <true|false>` — Enable/disable `subscription.agy_stream_heartbeat` (`--output-format stream-json`).
- `/ag-config timeout <seconds>` — Set `subscription.timeout_sec` (`1`–`3600`).
- `/ag-config model <gemini-model>` — Set `api.model` for API fallback mode (e.g., `gemini-2.5-pro`).
- `/ag-config max-turns <count>` — Set `api.max_turns` (`1`–`50`).
- `/ag-config git-guard <best_effort|required>` — Set `git_guard` policy.

## Execution Rules

1. Parse `$ARGUMENTS`. If empty, read `.ag-bridge/config.json` and call `check_ag_environment({})`, then print a clear settings summary.
2. Validate values strictly before writing:
   - `skip-permissions true`: remind the user that `--dangerously-skip-permissions` auto-approves all `agy` tool requests and that Git Guard `rollback_ag_task` remains active for safety.
   - Never write raw API keys into `.ag-bridge/config.json`; advise setting `GEMINI_API_KEY` as an environment variable instead.
3. Ensure `.ag-bridge/` exists and `.gitignore` contains `.ag-bridge/` before writing `.ag-bridge/config.json`.
4. Preserve all untouched keys in `.ag-bridge/config.json`.
5. After saving, call `check_ag_environment({})` and display a before/after table confirming the updated configuration.
