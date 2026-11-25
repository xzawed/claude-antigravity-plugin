---
description: Delegate any frontend UI, multi-file, browser E2E, or full Antigravity CLI task (models, effort, agents, resume, --dangerously-skip-permissions, token usage)
argument-hint: "<task> [--paths p1,p2] [--url http://localhost:3000] [--mode auto|subscription|api] [--model <id>] [--effort low|medium|high|xhigh|max] [--agy-mode accept-edits|auto|plan] [--dangerously-skip-permissions] [--no-sandbox] [--worktree] [--continue | --conversation <id>] [--agent <name>] [--add-dir <dir>]"
---

# `/ag-delegate` — Delegate Any Task to Antigravity

Delegate the requested task in `$ARGUMENTS` to Antigravity using the `antigravity-delegate` MCP server with full Antigravity CLI (`agy`) feature support.

## Supported Options

Parse any of these optional flags from `$ARGUMENTS`:
- `--paths <p1,p2>` → `lockedPaths` (comma-separated relative paths; optional for read-only/general `agy` tasks)
- `--url <url>` → `verifyUrl`
- `--mode <auto|subscription|api>` → `modeOverride`
- `--model <model-id>` → `model` (e.g., `gemini-4-neon-high`, `claude-opus-5-5-high`, `gemini-3.8-flash-high`, or Gemini API model)
- `--effort <low|medium|high|xhigh|max>` → `effort`
- `--agent <name>` → `agent`
- `--agy-mode <accept-edits|auto|plan>` → `agyMode`
- `--dangerously-skip-permissions` → `dangerouslySkipPermissions: true` (auto-approves all `agy` tool calls; `permission_mode=always-proceed`)
- `--no-sandbox` → `sandbox: false`
- `--sandbox` → `sandbox: true`
- `--add-dir <dir>` (repeatable) → `addDirs`
- `--continue` → `continueConversation: true`
- `--conversation <id>` → `conversationId`
- `--project <id|name>` → `project`
- `--new-project` → `newProject: true`
- `--remote-agent` → `remoteAgent: true`
- `--json-schema <schema-or-path>` → `jsonSchema`
- `--disable-slash-commands` → `disableSlashCommands: true`
- `--settings <json-or-path>` → `settings`
- `--worktree` → `isolateWorktree: true` (runs in an isolated Git worktree `.ag-bridge/worktrees/<taskId>` on branch `ag-task/<taskId>`, leaving the parent working tree clean)
- `--timeout <sec>` → `timeoutSec`

## Steps

1. **Parse `$ARGUMENTS`:** Extract the core task description (`instructions`), generate a concise `title` (3–120 chars), and extract all provided flags above.
2. **Check Environment:** Call `check_ag_environment({})`. If `resolvedMode === "unavailable"`, stop and guide the user with `recommendations`.
3. **Determine `lockedPaths`:**
   - If `--paths` was provided, pass it as `lockedPaths`.
   - For file-editing tasks where `--paths` was omitted, infer minimal least-privilege `lockedPaths` from the workspace layout (or omit `lockedPaths` only for read-only / research / `--agy-mode plan` tasks).
4. **Build `acceptanceCriteria`:**
   - Include all explicit user criteria.
   - In `subscription` mode with `verifyUrl`, require browser rendering, 0 console/network errors, and screenshots in `.ag-bridge/artifacts/`.
   - In `api` mode, require `tsc --noEmit` / project build verification.
5. **Execute Delegation:** Call `delegate_to_antigravity(...)` with all parsed options.
6. **Review & Report:** Present a clean summary including:
   - `taskId`, `mode`, `status`, `changedFiles`, `artifacts`, `gitCheckpointRef` (and `worktreePath` / `worktreeBranch` when `--worktree` was used)
   - **Execution Metrics & Token Usage:** `metrics.model`, `metrics.conversationId` (so the user can resume with `--conversation <id>`), `metrics.permissionMode`, `metrics.durationSeconds`, `metrics.numTurns`, and `metrics.usage` (`inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `totalTokens`)
   - Key findings from `reportMarkdown` and any `warnings`
