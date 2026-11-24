---
description: Losslessly roll back an Antigravity delegation task to its pre-delegation Git Guard checkpoint
argument-hint: "[taskId]"
---

# `/ag-rollback` — One-Click Lossless Git Guard Rollback

Restore tracked files, the index and the branch tip to the pre-delegation checkpoint (`gitCheckpointRef`). Untracked files created during the task are removed. Pre-existing untracked files stay in place, even if the agent staged or committed them. Their content was never snapshotted, though, so an agent's edit inside one is not undone.

## Execution Procedure

1. Parse optional `taskId` from `$ARGUMENTS` (if omitted, rolls back the most recent delegation in `.ag-bridge/manifest.json`).
2. Call `rollback_ag_task({ taskId })`.
3. Report:
   - Restored `taskId` and `restoredCheckpointRef`
   - `revertedTrackedFiles` count/list (tracked files that differed from the checkpoint, the agent's commits included)
   - `removedUntrackedFiles` count/list (confirming pre-existing untracked files were preserved)
   - Every entry in `warnings`, verbatim
4. If the rollback is refused because `HEAD` now names another branch (the agent switched branches), nothing was changed. Relay the message: it names the `git switch <branch>` command that leads back. Do not run it yourself without the user's go-ahead.
