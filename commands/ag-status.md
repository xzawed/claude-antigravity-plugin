---
description: Diagnose Antigravity provider availability, execution mode, bridge state, and Git Guard status
---

# `/ag-status` — Antigravity Environment & Bridge Diagnostics

Check the current environment and bridge status by calling `check_ag_environment({})`.

## Output Format

Present the tool response in a concise Markdown table:

| Check | Status / Value | Details |
| :--- | :--- | :--- |
| **Execution Mode** | `<configuredMode>` → **`<resolvedMode>`** | Active provider resolution |
| **Subscription App/CLI** | `Detected` / `Not detected` | Binary/app path and trigger method |
| **Gemini API Key** | `Configured (<source>)` / `Not set` | Env var `<envVarName>`, model `<model>`, max turns `<maxTurns>` |
| **Bridge (`.ag-bridge/`)** | `<currentStatus>` | Initialized: `<yes/no>`, `.gitignore`: `<protected/missing>`, Last Task: `<lastTaskId or none>` |
| **Git Guard** | `Ready` / `Not a Git repo` | Branch `<currentBranch>`, Working tree `<clean/dirty>` |

Never print raw API keys or secrets. If `recommendations` is non-empty, list them below the table as actionable next steps.
