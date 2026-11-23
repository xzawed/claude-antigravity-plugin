---
description: Losslessly roll back an Antigravity delegation task to its pre-delegation Git Guard checkpoint
argument-hint: "[taskId]"
---

# `/ag-rollback` — One-Click Lossless Git Guard Rollback

Restore the workspace to the exact pre-delegation state (`gitCheckpointRef`) while preserving all pre-existing untracked files.

## Execution Procedure

1. Parse optional `taskId` from `$ARGUMENTS` (if omitted, rolls back the most recent delegation in `.ag-bridge/manifest.json`).
2. Call `rollback_ag_task({ taskId })`.
3. Report:
   - Restored `taskId` and `restoredCheckpointRef`
   - `revertedTrackedFiles` count/list
   - `removedUntrackedFiles` count/list (confirming pre-existing untracked files were preserved)
