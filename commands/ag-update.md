---
description: Check for updates or upgrade claude-antigravity-plugin itself (/ag-update plugin) and the local Antigravity CLI (/ag-update agy, /ag-update all)
argument-hint: "[check | plugin [--dry-run] | agy | all | changelog [--lines <n>] | apply]"
---

# `/ag-update` — Plugin & Antigravity CLI Self-Update

Check for newer releases or update **both** `claude-antigravity-plugin` and the local Antigravity CLI (`agy`) directly from Claude Code via `ag_cli_admin`.

## Syntax

- `/ag-update` or `/ag-update check` — Safe read-only check: compares installed `claude-antigravity-plugin` version against the latest GitHub Release (`action: "plugin_status"`) and shows recent `agy` CLI release notes (`action: "changelog"`, when `agy` is installed).
- `/ag-update plugin [--dry-run]` — Updates `claude-antigravity-plugin` itself (`action: "plugin_update"`):
  - **Marketplace install:** runs `claude plugin marketplace update claude-antigravity-plugin` and `claude plugin update antigravity-delegate@claude-antigravity-plugin`.
  - **Local git clone:** runs `git pull --ff-only` (prebuilt bundles in `server/dist/` are committed — no `npm install` or `npm run build` needed).
- `/ag-update agy` *(or legacy `/ag-update apply`)* — Upgrades the local `agy` CLI binary (`action: "update"`).
- `/ag-update all` — Updates **both** `claude-antigravity-plugin` (`action: "plugin_update"`) and `agy` CLI (`action: "update"`).
- `/ag-update changelog [--lines <n>]` — Views recent `agy` CLI release notes (`action: "changelog"`).

## Execution Procedure

1. Parse `$ARGUMENTS`:
   - Empty or `check`: call `ag_cli_admin({ action: "plugin_status" })`, and if `agy` is available also call `ag_cli_admin({ action: "changelog", maxLines })`.
   - `plugin`: call `ag_cli_admin({ action: "plugin_update", dryRun })`.
   - `agy` or `apply`: call `ag_cli_admin({ action: "update" })`.
   - `all`: call `ag_cli_admin({ action: "plugin_update" })` and then `ag_cli_admin({ action: "update" })`.
   - `changelog`: call `ag_cli_admin({ action: "changelog", maxLines })`.
2. Only run mutating updates (`plugin`, `agy`/`apply`, `all`) when the user explicitly asks for them.
3. Display the result cleanly:
   - For plugin updates where `pluginUpdate.reloadRequired` is `true`, highlight `/reload-plugins` (or restarting Claude Code) so the new version activates immediately.
   - Remind marketplace users they can turn on zero-touch auto-updates once via `/plugin` → **Marketplaces** → `claude-antigravity-plugin` → **Enable auto-update**.
