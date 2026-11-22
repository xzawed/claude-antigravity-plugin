---
description: View or update Antigravity delegation settings (.ag-bridge/config.json)
argument-hint: "[mode auto|subscription|api | model <name> | timeout <sec> | max-turns <n>]"
---

# `/ag-config` — Configure Antigravity Execution Mode & Engine Settings

Inspect or update `.ag-bridge/config.json` in the current workspace.

## Supported Subcommands

- `/ag-config` — Read and display the current `.ag-bridge/config.json` (or defaults if not initialized).
- `/ag-config mode <auto|subscription|api>` — Set `execution_mode`.
- `/ag-config model <model-name>` — Set `api.model` (e.g., `gemini-2.5-pro`, `gemini-2.5-flash`).
- `/ag-config timeout <seconds>` — Set `subscription.timeout_sec` (valid range: `30`–`1800`).
- `/ag-config max-turns <count>` — Set `api.max_turns` (valid range: `1`–`50`).
- `/ag-config git-guard <best_effort|required>` — Set `git_guard` policy.

## Execution Rules

1. Parse `$ARGUMENTS`. If empty, read `.ag-bridge/config.json` and call `check_ag_environment({})`, then display the current configuration cleanly.
2. Validate values strictly before writing:
   - `mode` must be `auto`, `subscription`, or `api`.
   - `timeout` must be an integer between `30` and `1800`.
   - `max-turns` must be an integer between `1` and `50`.
   - Never write a raw `GEMINI_API_KEY` into `.ag-bridge/config.json`; if the user tries to pass an API key, advise them to export `GEMINI_API_KEY` as an environment variable instead.
3. Ensure `.ag-bridge/` exists and `.gitignore` contains `.ag-bridge/` before writing `.ag-bridge/config.json`.
4. Preserve all untouched keys in `.ag-bridge/config.json`.
5. After saving, call `check_ag_environment({})` and display a before/after summary table along with the updated `resolvedMode`.
