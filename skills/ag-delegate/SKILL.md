---
name: ag-delegate
description: >-
  Delegate frontend UI implementation, multi-file refactoring, real-browser E2E
  visual verification, or any Antigravity CLI (`agy`) workflow (custom models,
  effort levels, agents, conversation resume, `--dangerously-skip-permissions`,
  and token usage tracking) from Claude Code to Antigravity via the embedded
  antigravity-delegate MCP server.
---

# Antigravity Delegation Skill (`ag-delegate`)

Use the `antigravity-delegate` MCP server to offload UI-heavy implementation, multi-file refactoring, browser E2E visual verification, and full Antigravity CLI (`agy`) capabilities while keeping Claude Code focused on orchestration, architecture, and final review.

## 1. Available MCP Tools (12)

1. `ag_auth` — Sign in to Antigravity (`agy acp --login`) via Google OAuth (local browser or headless/manual link+code flow), check live authentication status, complete/cancel a pending code-paste login, or view safe logout steps.
2. `delegate_to_antigravity` — Synchronous delegation: dispatch any task to Antigravity (including native `/boost`, `/browser`, `/swarm`, `/goal`, custom models/effort/agents, `--json-schema`, conversation resume, `--dangerously-skip-permissions`, and optional `isolateWorktree: true` Git worktree isolation) and wait for `reportMarkdown`, `structuredOutput`, `changedFiles`, `artifacts`, and `metrics`.
3. `start_ag_task` — Asynchronous background delegation: immediately returns a `jobId` after creating the Git checkpoint (or isolated worktree when `isolateWorktree: true`, allowing multiple parallel jobs without `BRIDGE_BUSY` conflicts) so Claude Code can continue backend/architecture work in parallel while Antigravity executes.
4. `get_ag_job` — Inspect live progress, masked log tail, token usage, `reportMarkdown`, and `structuredOutput` for a background `jobId`, or list all active and recent jobs.
5. `cancel_ag_job` — Gracefully terminate a running background Antigravity job while preserving its pre-delegation Git checkpoint for optional rollback.
6. `ag_session` — Persistent multi-turn `stream-json` sessions (`start`, `send`, `list`, `close`) using `agy --input-format stream-json --output-format stream-json` for zero cold-start overhead and maximum prompt-cache reuse across turns.
7. `list_ag_artifacts` — Inspect screenshots, logs, reports, and JSON artifacts under `.ag-bridge/artifacts/<taskId>/` with masked `report.md` and `agy-cli.log` previews.
8. `ag_cli_admin` — Manage Antigravity CLI platform integrations and plugin self-updates safely (`mcp_list`, `mcp_add`, `mcp_remove`, `mcp_enable`, `mcp_disable`, `mcp_sync_from_claude`, `remote_status`, `remote_start`, `remote_stop`, `changelog`, `update`, `plugin_status`, `plugin_update`).
9. `check_ag_environment` — Inspect detected mode, local `agy`/app path, active `agyConfig` (permissions/sandbox/model/effort), API key status (redacted), Git Guard state, and latest task usage.
10. `list_ag_capabilities` — Dynamically discover all available `agy` models and agents (including the workspace's own), permission modes, effort levels, and supported CLI flags.
11. `get_ag_usage` — Inspect cumulative and per-task token usage (`inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `totalTokens`) and duration across current and archived delegations.
12. `rollback_ag_task` — Restore an in-place workspace task losslessly to its pre-delegation Git checkpoint (`gitCheckpointRef`, moving removed files into `.ag-bridge/recovery/<taskId>/`), or remove an isolated worktree (`.ag-bridge/worktrees/<taskId>`) and its `ag-task/<taskId>` branch for `isolateWorktree: true` tasks.

## 2. When to Delegate

Delegate via `delegate_to_antigravity` when the user's request involves:
1. **Frontend UI & Styling:** Building or refactoring React, Next.js, Vue, Svelte, CSS/Tailwind components, responsive layouts, dashboards, or interactive forms.
2. **Real Browser Visual / E2E Verification:** Tasks requiring a local dev server (`verifyUrl`) to inspect rendered DOM, layout, console/network errors, and interactive user flows.
3. **Parallel Multi-File Generation or Model-Specific Work:** Leveraging specific Antigravity models (`list_ag_capabilities` → e.g. `gemini-4-neon-high`, `claude-opus-5-5-high`, `gemini-3.8-flash-high`), reasoning effort (`--effort`), custom agents (`--agent`), or resuming a prior Antigravity session (`conversationId` / `continueConversation`).
4. **Explicit User Delegation:** Any task the user explicitly asks to run through Antigravity (`/ag-delegate` or natural-language request).

## 3. Mandatory Pre-Flight Check & Permission Policy

1. Call `check_ag_environment({})` before delegating. If `resolvedMode === "unavailable"`, report `recommendations` and suggest `/ag-login` (for Subscription OAuth) or setting `GEMINI_API_KEY`, then stop. If Subscription mode is detected but unauthenticated, guide the user to run `/ag-login` (or call `ag_auth({ action: "status" })`).
2. **Permissions (`--dangerously-skip-permissions`):**
   - Default config uses safe `agy_mode: "accept-edits"` + `agy_sandbox: true` (`agy_dangerously_skip_permissions: false`).
   - When the user explicitly requests unrestricted/unattended execution (`--dangerously-skip-permissions` or configured `agy_dangerously_skip_permissions: true`), pass `dangerouslySkipPermissions: true` (and `sandbox: false` only if requested). Git Guard still snapshots the workspace automatically before execution so `rollback_ag_task` remains available.
3. **Least-Privilege `lockedPaths`:**
   - Pass minimal relative file/directory scopes whenever Antigravity edits code. Never include `.git/`, `.env*`, `.ag-bridge/config.json`, or `node_modules/`.
   - For read-only research, Q&A, or `agyMode: "plan"` tasks, `lockedPaths` may be omitted.
4. **Mode-Specific `acceptanceCriteria`:**
   - `subscription` with `verifyUrl`: require Browser Subagent rendering, 0 console/network errors, and screenshots in `.ag-bridge/artifacts/`.
   - `api`: require `npx tsc --noEmit` and project build success.

## 4. Review, Token Usage Reporting & Rollback

After `delegate_to_antigravity` returns:
1. Review `reportMarkdown`, `changedFiles`, `artifacts`, `metrics`, and `warnings`.
2. Always report **Token Usage** (`metrics.usage`: input / output / thinking / cache read / total tokens), `metrics.model`, `metrics.durationSeconds`, and `metrics.conversationId` (when present) so the user has full visibility and can resume the Antigravity conversation if needed.
3. If the result failed or introduced regressions, offer or call `rollback_ag_task({ taskId })` to restore the exact pre-delegation checkpoint.
