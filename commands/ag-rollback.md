---
description: Losslessly roll back an Antigravity delegation task to its pre-delegation Git Guard checkpoint
argument-hint: "[taskId]"
---

# `/ag-rollback` — One-Click Git Guard Rollback & Worktree Cleanup

Restore tracked files, the index, and the branch tip to the pre-delegation checkpoint (`gitCheckpointRef`), or cleanly remove an isolated worktree created with `--worktree` (`isolateWorktree: true`).

- **In-place tasks (lossless recovery):**
  - **Nothing is deleted.** Files created during the task are moved to `.ag-bridge/recovery/<taskId>/rollback-<time>/removed/`. This includes files the agent staged or committed.
  - **Pre-existing untracked files stay.** Ones the agent edited or deleted are put back from the checkpoint's copy (taken when they fit 2,000 files and 50 MB). The agent's version goes to `replaced/`.
  - **The state before the rollback is recorded,** so the rollback itself can be undone.
- **Isolated worktree tasks (`isolateWorktree: true`):**
  - Removes the isolated worktree directory (`.ag-bridge/worktrees/<taskId>`) and deletes its `ag-task/<taskId>` branch without modifying your parent working tree. (Worktree removal deletes the isolated worktree directory rather than moving files into `.ag-bridge/recovery/`.)
  - Active running worktree jobs must be cancelled first via `/ag-cancel <taskId>`.

## Execution Procedure

1. Parse optional `taskId` from `$ARGUMENTS` (if omitted, rolls back the most recent delegation in `.ag-bridge/manifest.json`; if a newer isolated worktree task ran after the main workspace task, `rollback_ag_task` requires an explicit `taskId` so the wrong workspace is never touched).
2. Call `rollback_ag_task({ taskId })`.
3. Report:
   - Restored `taskId` and `restoredCheckpointRef`
   - For isolated worktree tasks: `worktreeRemoved`, `worktreeBranchDeleted`, and any `warnings`
   - For in-place tasks:
     - `revertedTrackedFiles` count/list (tracked files that differed from the checkpoint, the agent's commits included)
     - `removedUntrackedFiles` count/list, and `quarantineDir` (where they were moved)
     - `restoredUntrackedFiles` (the user's files put back from the checkpoint's copy)
     - How to undo the rollback: `git reset --hard <preRollbackHead>`, then `git stash apply <preRollbackRef>` when `preRollbackRef` is present. Show the commands only; run nothing without the user's go-ahead.
     - Every entry in `warnings`, verbatim
4. If the rollback is refused because `HEAD` now names another branch (the agent switched branches), nothing was changed. Relay the message: it names the `git switch <branch>` command that leads back. Do not run it yourself without the user's go-ahead.
