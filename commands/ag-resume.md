---
description: Continue a previous Antigravity conversation by taskId, conversationId, or latest session
argument-hint: "[taskId | conversationId] <follow-up instructions> [--model <id>] [--effort <lvl>] [--dangerously-skip-permissions] [--bg]"
---

# `/ag-resume` — Continue a Previous Antigravity Conversation

Seamlessly send follow-up instructions to an existing Antigravity conversation thread without losing context.

## Execution Procedure

1. Parse `$ARGUMENTS`:
   - If no arguments are given, call `get_ag_usage({ limit: 10 })` and display recent tasks that have a `conversationId` so the user can pick one.
   - If the first token looks like a `taskId` (`ag-2026...`), call `get_ag_job({ jobId: token })` to resolve its `conversationId`.
   - If the first token looks like a UUID (`xxxxxxxx-xxxx-...`), use it directly as `conversationId`.
   - Otherwise, use `continueConversation: true` (resumes the latest Antigravity conversation in this workspace) with all of `$ARGUMENTS` as the follow-up instructions.
2. Call `delegate_to_antigravity` (or `start_ag_task` if `--bg` is set) with:
   - `title`: `"Resume Antigravity conversation"`
   - `instructions`: `<follow-up instructions>`
   - `conversationId` (or `continueConversation: true`)
   - `modeOverride`: `"subscription"`
   - Pass through optional `model`, `effort`, `dangerouslySkipPermissions`, `lockedPaths`, `timeoutSec`.
3. Report the response, updated `changedFiles`, `conversationId`, and incremental token usage.
