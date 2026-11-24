---
description: Diagnose Antigravity provider availability, active agy CLI permissions/flags, bridge state, Git Guard, and latest token usage
---

# `/ag-status` — Antigravity Environment, Permissions & Bridge Diagnostics

Check the current environment and bridge status by calling `check_ag_environment({})`.

## Output Format

Present the tool response in a concise Markdown table:

| Check | Status / Value | Details |
| :--- | :--- | :--- |
| **Execution Mode** | `<configuredMode>` → **`<resolvedMode>`** | Active provider resolution |
| **Subscription App/CLI** | `Detected` / `Not detected` | Binary/app path and trigger method |
| **Antigravity CLI Policy** | Mode `<agyConfig.mode>` · Sandbox `<on/off>` | `--dangerously-skip-permissions`: `<enabled/disabled>`, Model: `<model or default>`, Effort: `<effort or default>`, Stream Heartbeat: `<on/off>` |
| **Gemini API Key** | `Configured (<source>)` / `Not set` | Env var `<envVarName>`, model `<model>`, max turns `<maxTurns>` |
| **Bridge (`.ag-bridge/`)** | `<currentStatus>` | Initialized: `<yes/no>`, Git-ignored: `<protected/missing>`, Last Task: `<lastTaskId or none>`, Last Conversation: `<lastConversationId or none>` |
| **Last Task Usage** | `<totalTokens or N/A>` | Input / Output / Thinking / Cache Read tokens (run `/ag-usage` for full history) |
| **Git Guard** | `Ready` / `Not a Git repo` | Branch `<currentBranch>`, Working tree `<clean/dirty>` |

Never print raw API keys or secrets. If `recommendations` is non-empty, list them below the table as actionable next steps (and remind the user they can run `/ag-login` or `/ag-login status` to sign in or verify live Antigravity OAuth credentials).
