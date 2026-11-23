---
description: Sign in to Antigravity (Google OAuth browser or link+code flow), check live auth status, or view safe logout steps
argument-hint: "[status | --manual | --force | complete <code-or-url> | cancel | logout]"
---

# `/ag-login` — Antigravity Authentication & Account Login

Manage Antigravity (`agy`) authentication directly from Claude Code using the `ag_auth` MCP tool.

## Syntax

- `/ag-login` — Check login status and, if not signed in, launch Google OAuth login (opens local browser automatically; automatically switches to link + code-paste mode over SSH/headless)
- `/ag-login status` — Verify live Antigravity authentication status, auth method, and available model count
- `/ag-login --manual` (or `--no-browser`) — Generate a clickable Google OAuth link directly in chat for code-paste authentication
- `/ag-login --force` — Re-authenticate or switch Google accounts even if already signed in (can be combined with `--manual`)
- `/ag-login complete <code-or-url> [sessionId]` — Finish a pending `--manual` OAuth login by submitting the authorization code or full callback URL
- `/ag-login cancel [sessionId]` — Cancel an active pending manual login session
- `/ag-login logout` — Show safe logout instructions to purge saved OS keyring credentials

## Execution Procedure

Parse `$ARGUMENTS` and call `ag_auth`:

1. **`status`**:
   - Call `ag_auth({ action: "status" })`.
2. **`complete <code-or-url> [sessionId]`**:
   - Call `ag_auth({ action: "complete", code: "<code-or-url>", sessionId: "<optional>" })`.
   - **Security Rule:** NEVER echo or repeat the raw authorization code back in your response.
3. **`cancel [sessionId]`**:
   - Call `ag_auth({ action: "cancel", sessionId: "<optional>" })`.
4. **`logout`**:
   - Call `ag_auth({ action: "logout" })`.
5. **Default / flags (`--manual`, `--no-browser`, `--browser`, `--force`, `--timeout <sec>`)**:
   - Map `--manual` / `--no-browser` → `flow: "manual"`, `--browser` → `flow: "browser"`, otherwise `flow: "auto"`.
   - Map `--force` → `force: true`.
   - Call `ag_auth({ action: "login", flow, force, timeoutSec })`.

## Output Format

- When `status === "AWAITING_CODE"`:
  1. Display the clickable `authUrl` clearly so the user can open it in any browser.
  2. Instruct the user to sign in with their Google account, copy the authorization code (or full redirect URL), and reply with:
     ```text
     /ag-login complete <code-or-url>
     ```
  3. Mention the `sessionId` (expires in 5 minutes) and `/ag-login cancel`.
- When `status === "AUTHENTICATED"`:
  - Report active `authMethod` (`google-oauth`, `gemini-api-key`, or `adc`), `modelCount` (if available), and next commands (`/ag-models`, `/ag-delegate`).
- When `status === "CLI_NOT_INSTALLED"` or `ok === false`:
  - Display `message` and `nextSteps` cleanly so the user can install `agy` or configure `GEMINI_API_KEY`.
