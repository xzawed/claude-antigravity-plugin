<!-- ag-plugin-template-version: 1.0.0 -->
# Claude Handoff Execution Workflow (`/claude-handoff`)

You are executing a delegated task dispatched from **Claude Code** via the `.ag-bridge/` protocol. Follow these 6 steps strictly and in order.

## Step 1: Claim the Task (`RUNNING`)
1. Read `.ag-bridge/manifest.json`.
2. Update `status` to `"RUNNING"` and `updatedAt` to the current UTC ISO-8601 timestamp. Write the updated JSON back cleanly.

## Step 2: Read Dispatch Instructions & Constraints
1. Read `.ag-bridge/dispatch.md` completely.
2. Note the `taskId`, `lockedPaths`, `verifyUrl` (if provided), technical context, and every item under **Acceptance Criteria**.

## Step 3: Implement Strictly Within `lockedPaths`
1. You may **read** any relevant non-secret file in the workspace to understand types, APIs, styling conventions, and project configuration.
2. You MUST **only create or modify** files inside the paths listed under `lockedPaths`.
3. Never modify `.git/`, `.env*`, or `.ag-bridge/config.json`.
4. If a change outside `lockedPaths` (e.g., a backend API adjustment) is required, do **not** edit that file — document the exact requested change in `.ag-bridge/report.md` under **Notes & Follow-up for Claude**.

## Step 4: Verify Build & Run Browser E2E Checks
1. Run the project's typecheck/build command (e.g., `npx tsc --noEmit`, `npm run build`) and resolve any compilation errors caused by your changes.
2. If `verifyUrl` is specified in `.ag-bridge/dispatch.md`:
   - Launch the built-in Browser Subagent against `verifyUrl`.
   - Verify visual layout, interactive flows described in Acceptance Criteria, and check for console/network errors.
   - Save screenshots and relevant verification logs inside `.ag-bridge/artifacts/<taskId>/`.

## Step 5: Write `.ag-bridge/report.md`
Write a clear report to `.ag-bridge/report.md` using this exact structure:

```markdown
# Antigravity Task Report

- **Task ID:** <taskId>
- **Status:** VERIFIED | FAILED
- **Engine:** subscription
- **Completed At:** <ISO-8601 UTC>

## Summary
<Concise summary of what was implemented>

## Modified / Created Files
- `<relative/path>` (created | modified)

## Verification Results
- **Build / Typecheck:** PASS | FAIL (<command>)
- **Browser E2E / Visual Check:** PASS | FAIL | SKIPPED
- **Console / Network Errors:** <count and details>

## Artifacts
- `.ag-bridge/artifacts/<taskId>/<filename>`

## Notes & Follow-up for Claude
<Backend integration notes, remaining caveats, or "None">
```

## Step 6: Finalize `.ag-bridge/manifest.json`
1. Update `.ag-bridge/manifest.json`:
   - `status`: `"VERIFIED"` (or `"FAILED"` if blocked/unrecoverable, along with `error` describing why)
   - `changedFiles`: array of modified/created workspace-relative file paths
   - `artifacts`: array of `.ag-bridge/`-relative artifact file paths saved during Step 4
   - `updatedAt`: current UTC ISO-8601 timestamp
2. Never include any API keys or secrets in `report.md` or `manifest.json`.
