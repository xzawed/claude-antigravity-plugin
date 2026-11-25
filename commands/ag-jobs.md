---
description: Monitor active background Antigravity jobs, inspect live progress/logs/tokens, and collect finished reports
argument-hint: "[jobId] [--no-logs] [--limit <n>]"
---

# `/ag-jobs` — Monitor & Collect Background Antigravity Jobs

Inspect active and recent Antigravity background tasks via `get_ag_job`.

## Execution Procedure

1. If `$ARGUMENTS` contains a `jobId` (e.g., `ag-20261123-...`):
   - Call `get_ag_job({ jobId, includeLogTail: !noLogs })`.
   - Display status (`RUNNING`, `VERIFIED`, `FAILED`, `CANCELLED`), elapsed seconds, `model`, `conversationId`, `worktreePath` & `worktreeBranch` (when isolated), live/final token usage, `changedFiles`, `artifacts`, `structuredOutput` (if present), `reportMarkdown`, and masked `logTail` (if still running or failed).
2. If `$ARGUMENTS` is empty (or only `--limit <n>`):
   - Call `get_ag_job({ limit })`.
   - Present a concise Markdown table of active and recent jobs: `Job ID`, `Title`, `Mode`, `Status`, `Elapsed`, `Model`, `Total Tokens`, `Conversation ID`.
   - Suggest `/ag-jobs <jobId>` to inspect full output, `/ag-resume <conversationId> <prompt>` to follow up, or `/ag-rollback <jobId>` to revert changes.
