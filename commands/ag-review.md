---
description: Run a read-only cross-model code, security, and edge-case review via Antigravity (--mode plan + structured JSON output)
argument-hint: "[staged | branch | <file-or-dir>] [--model <id>] [--effort high|xhigh|max] [--bg]"
---

# `/ag-review` — Cross-Model Read-Only Code & Security Audit

Ask Antigravity (e.g. Gemini 4 Neon or another model family) to perform an independent, read-only code review of your changes and return structured findings.

## Execution Procedure

1. Parse `$ARGUMENTS`:
   - Scope: `staged` (`git diff --cached`), `branch` (`git diff main...HEAD`), a specific file/directory path, or default (`git diff` + `git status`).
   - Optional `--model` (e.g. `gemini-4-neon-xhigh`), `--effort` (default `"high"`), `--bg` (background via `start_ag_task`).
2. Prepare a strict JSON schema for structured findings:
   ```json
   {"type":"object","properties":{"summary":{"type":"string"},"verdict":{"type":"string","enum":["approve","request_changes","comment"]},"findings":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string","enum":["critical","high","medium","low","nit"]},"file":{"type":"string"},"line":{"type":"number"},"issue":{"type":"string"},"suggestion":{"type":"string"}},"required":["severity","file","issue","suggestion"]}}},"required":["summary","verdict","findings"]}
   ```
3. Call `delegate_to_antigravity` (or `start_ag_task` if `--bg` is set) with:
   - `title`: `"Cross-model code review: <scope>"`
   - `instructions`: Detailed review request instructing Antigravity to inspect the target diff/files for bugs, security flaws, race conditions, performance issues, and missing tests — **without modifying any files**.
   - `agyMode`: `"plan"` (read-only; do **NOT** set `disableSlashCommands: true`)
   - `jsonSchema`: the JSON schema above
   - `effort`: parsed effort or `"high"`
   - Pass through optional `model`, `timeoutSec`.
4. Render `structuredOutput` (or `reportMarkdown` fallback) as a clean severity-sorted table (`Severity`, `File:Line`, `Issue`, `Suggested Fix`), along with verdict and token usage, and ask the user which findings Claude should fix immediately.
