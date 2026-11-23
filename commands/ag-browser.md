---
description: Run real-browser visual QA, DOM/interaction checks, console/network error audits, and screenshots via Antigravity's native /browser subagent
argument-hint: "<http://localhost:...> [verification scenario] [--model <id>] [--dangerously-skip-permissions] [--bg]"
---

# `/ag-browser` — Real-Browser E2E & Visual QA via Antigravity

Use Antigravity's built-in `/browser` subagent to visually inspect a running web application, test real clicks/forms/navigation, audit console & network errors, and capture screenshots without modifying source code.

## Execution Procedure

1. Parse `$ARGUMENTS`:
   - Extract the target URL (`verifyUrl`, e.g. `http://localhost:3000/checkout`).
   - Extract the verification scenario (default: "Verify layout rendering, responsiveness, core interactive controls, and confirm 0 console errors and 0 failed network requests").
   - Extract optional `--model`, `--effort`, `--dangerously-skip-permissions`, `--timeout`, and `--bg` (background execution via `start_ag_task`).
2. Compose a native Antigravity `/browser` prompt:
   ```text
   /browser Open <verifyUrl> and perform visual & functional QA: <scenario>. Capture key screenshots under .ag-bridge/artifacts/ and report: (1) rendered layout/UI defects, (2) interactive test results, (3) console errors, (4) failed network requests, and (5) saved screenshot paths. Do not edit source code files.
   ```
3. Call `delegate_to_antigravity` (or `start_ag_task` if `--bg` is set) with:
   - `title`: `"Browser QA: <verifyUrl>"`
   - `instructions`: the `/browser ...` prompt above (do **NOT** set `disableSlashCommands: true`)
   - `verifyUrl`: `<verifyUrl>`
   - `modeOverride`: `"subscription"` (real browser QA requires Antigravity Subscription CLI)
   - `rawPrompt`: `true`
   - Pass through optional `model`, `effort`, `dangerouslySkipPermissions`, `timeoutSec`.
4. Summarize visual findings, console/network errors, screenshot paths, and token usage cleanly.
