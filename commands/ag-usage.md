---
description: Display cumulative and per-task Antigravity token usage (input, output, thinking, cache read, total) and execution duration
argument-hint: "[limit]"
---

# `/ag-usage` — Antigravity Token Usage & Execution Metrics

Call `get_ag_usage({ limit })` (default `limit: 20`) and present:

1. **Grand Totals Summary Table:**
   - Total Tasks (`totalTasks`), Tasks with Usage (`tasksWithUsage`), Total Duration (`totalDurationSeconds`s)
   - Input Tokens, Output Tokens, Thinking Tokens, Cache Read Tokens, **Total Tokens**
2. **Breakdown by Mode:** `subscription` vs `api` task count and token totals.
3. **Recent Tasks Table:** `Task ID` | `Title` | `Mode` | `Model` | `Status` | `Turns` | `Duration` | `Total Tokens` | `Conversation ID` (so any prior task can be resumed with `/ag-delegate ... --conversation <id>`).
