---
description: Delegate a frontend UI, multi-file, or browser E2E verification task to Antigravity
argument-hint: "<task instructions> [--paths p1,p2] [--url http://localhost:3000] [--mode auto|subscription|api]"
---

# `/ag-delegate` — Manual Task Delegation to Antigravity

Delegate the requested task in `$ARGUMENTS` to Antigravity using the `antigravity-delegate` MCP tools.

## Steps

1. **Parse `$ARGUMENTS`:**
   - Extract the core task description (`instructions`) and generate a concise `title` (3–120 chars).
   - Extract optional flags if provided:
     - `--paths <comma-separated-paths>` → `lockedPaths`
     - `--url <url>` → `verifyUrl`
     - `--mode <auto|subscription|api>` → `modeOverride`
2. **Check Environment:**
   - Call `check_ag_environment({})`.
   - If `resolvedMode === "unavailable"`, stop and guide the user using the returned `recommendations`.
3. **Determine `lockedPaths` (Least Privilege):**
   - If `--paths` was omitted, inspect the workspace directory layout briefly and pick the minimal frontend/target paths required for the task. State the chosen `lockedPaths` clearly before delegating.
4. **Build `acceptanceCriteria`:**
   - Include all explicit requirements from the user.
   - If the active mode is `subscription` and `verifyUrl` is provided, include browser rendering, 0 console/network errors, and screenshot capture in `.ag-bridge/artifacts/`.
   - If the active mode is `api`, include `tsc --noEmit` / project build verification.
5. **Execute Delegation:**
   - Call `delegate_to_antigravity({ title, instructions, lockedPaths, verifyUrl, acceptanceCriteria, modeOverride })`.
6. **Review & Report:**
   - Present a concise summary containing: `taskId`, `mode`, `status`, `changedFiles`, `artifacts`, key notes from `reportMarkdown`, and `gitCheckpointRef` (mentioning `/rollback` or `rollback_ag_task` if anything needs reverting).
