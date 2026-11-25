---
description: Gracefully cancel a running background Antigravity job and optionally offer Git Guard rollback
argument-hint: "[jobId]"
---

# `/ag-cancel` — Cancel Running Background Antigravity Job

Terminate an active background Antigravity task cleanly using `cancel_ag_job`.

## Execution Procedure

1. Parse optional `jobId` from `$ARGUMENTS` (if omitted, `cancel_ag_job({})` cancels the most recently started active job in this workspace).
2. Call `cancel_ag_job({ jobId })`.
3. Report the cancellation outcome and `gitCheckpointRef` (plus `worktreePath` / `worktreeBranch` for isolated worktree jobs). Offer `/ag-rollback <jobId>` to remove the isolated worktree & branch or restore the exact pre-delegation Git state.
