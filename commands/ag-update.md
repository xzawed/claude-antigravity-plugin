---
description: View recent Antigravity CLI release notes (agy changelog) or update the local agy CLI binary (agy update)
argument-hint: "[changelog [--lines <n>] | apply]"
---

# `/ag-update` — Antigravity CLI Changelog & Update

Inspect recent Antigravity CLI release notes or update your local `agy` binary via `ag_cli_admin`.

## Syntax

- `/ag-update` or `/ag-update changelog [--lines <n>]` → `ag_cli_admin({ action: "changelog", maxLines })` (safe read-only default)
- `/ag-update apply` → `ag_cli_admin({ action: "update" })` (runs `agy update` to upgrade local CLI)

## Execution Procedure

1. Default to `changelog` if no argument is supplied so the user can inspect release notes before upgrading.
2. Only run `action: "update"` when the user explicitly passes `apply` (or confirms they want to upgrade).
3. Display the changelog summary or update result cleanly.
