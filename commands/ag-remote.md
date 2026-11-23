---
description: Check status, start, or stop the Antigravity remote-control background daemon
argument-hint: "[status | start | stop]"
---

# `/ag-remote` — Antigravity Remote Control Daemon Management

Inspect or manage the `agy remote-control` daemon from Claude Code using `ag_cli_admin`.

## Syntax

- `/ag-remote` or `/ag-remote status` → `ag_cli_admin({ action: "remote_status" })`
- `/ag-remote start` → `ag_cli_admin({ action: "remote_start" })`
- `/ag-remote stop` → `ag_cli_admin({ action: "remote_stop" })`

## Execution Procedure

Call `ag_cli_admin` with the requested action and display the daemon status, instance name, and any next steps cleanly. Also remind the user that remote agent delegations can be invoked via `/ag-delegate ... --remote-agent [--project <name>]`.
