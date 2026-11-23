---
description: List available Antigravity CLI models, agents, permission modes, effort levels, and active defaults
---

# `/ag-models` — Antigravity Models, Agents & CLI Capabilities

Call `list_ag_capabilities({})` and display:

1. **Detected CLI:** binary name & path (`subscriptionDetected`, `cliBinary`, `cliPath`).
2. **Available Models Table:** `id` | `label` (highlighting `currentDefaults.model` if set).
3. **Available Agents:** list of discovered agents (or "default built-in agent" if empty).
4. **Supported Permission Modes & Effort Levels:** including `--dangerously-skip-permissions`, `accept-edits`, `auto`, `plan`, and effort levels `low | medium | high | xhigh | max`.
5. **Quick Examples:** show how to select a model or permission mode via `/ag-config agy-model <id>`, `/ag-config skip-permissions true`, or `/ag-delegate ... --model <id> --dangerously-skip-permissions`.
