---
name: ag-delegate
description: >-
  Delegate frontend UI implementation, multi-file component scaffolding, styling,
  and real-browser E2E visual verification tasks from Claude Code to Antigravity
  via the embedded antigravity-delegate MCP server.
---

# Antigravity Delegation Skill (`ag-delegate`)

Use the `antigravity-delegate` MCP server to safely offload UI-heavy implementation, multi-file frontend scaffolding, and browser-based E2E visual verification to Antigravity while keeping Claude Code focused on orchestration, backend logic, and final quality review.

## 1. When to Delegate

Consider calling `delegate_to_antigravity` when the user's request matches one or more of the following:
1. **Frontend UI & Styling:** Building or refactoring React, Next.js, Vue, Svelte, CSS/Tailwind components, responsive layouts, dashboards, or interactive forms.
2. **Real Browser Visual / E2E Verification:** Tasks requiring a local dev server (`verifyUrl`) to inspect rendered DOM, layout, console/network errors, and interactive user flows (clicks, form submission, state transitions).
3. **Parallel Multi-File Frontend Generation:** Implementing multiple pages, hooks, or UI state modules once backend API contracts and TypeScript types are already finalized.

## 2. When NOT to Delegate

Keep the work directly inside Claude Code when:
- The change is a trivial 1–2 line fix or typo correction.
- The task involves core backend security, database migrations, authentication secrets, or infrastructure configs.
- API contracts or architectural requirements are still ambiguous and need discussion with the user first.

## 3. Mandatory Pre-Flight Check

Before calling `delegate_to_antigravity`:
1. Call `check_ag_environment({})` to inspect `resolvedMode` (`subscription` | `api` | `unavailable`), active bridge status, and Git Guard readiness.
2. If `resolvedMode === "unavailable"`, **do not** attempt delegation. Report the `recommendations` from `check_ag_environment` so the user can either install/sign in to Antigravity (Subscription Mode) or set `GEMINI_API_KEY` (API Fallback Mode).
3. If `bridge.currentStatus` is `DISPATCHED` or `RUNNING`, inform the user of the active task instead of overwriting it.

## 4. Constructing a Safe Delegation Payload

- **Least-Privilege `lockedPaths`:** Pass only the minimal relative files or directories that Antigravity needs to create or modify (for example `["src/components/checkout/", "src/pages/CheckoutPage.tsx"]`). Never include `.git/`, `.env*`, `.ag-bridge/config.json`, or unrelated backend folders.
- **Complete Context in `instructions`:** Include exact API endpoints, TypeScript interfaces, design tokens/conventions, and relevant file paths to read (read access covers the workspace; write access is restricted to `lockedPaths`).
- **Mode-Specific `acceptanceCriteria`:**
  - **When `resolvedMode === "subscription"`:**
    - Always supply `verifyUrl` if a local dev server URL is known (e.g., `http://localhost:3000/dashboard`).
    - Require: `"Verify rendering, core interactions, and 0 console/network errors via Antigravity Browser Subagent and save screenshots to .ag-bridge/artifacts/."`
    - Require project typecheck/build success.
  - **When `resolvedMode === "api"`:**
    - Do not require browser screenshots (API mode runs headlessly).
    - Require: `"Pass typecheck (npx tsc --noEmit) and project build (npm run build) with 0 errors."`

## 5. Review & Rollback Protocol

After `delegate_to_antigravity` returns:
1. Review `reportMarkdown`, `changedFiles`, `artifacts`, and any `warnings`.
2. Inspect key diffs (e.g., `git diff`) to ensure alignment with backend contracts and code quality.
3. Summarize the outcome, modified files, verification results, and artifact paths clearly to the user.
4. If the result failed, introduced regressions, or fails acceptance criteria, either fix minor issues directly or offer/call `rollback_ag_task({ taskId })` to restore the exact pre-delegation checkpoint.
