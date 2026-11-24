# Security Policy

## Supported Versions

Security updates are actively maintained for the latest minor release of the `1.x` line:

| Version | Supported |
| :--- | :---: |
| `1.4.x` (current `main`) | ✅ Yes |
| `1.0.x` – `1.3.x` | ⚠️ Upgrade to latest `1.4.x` |
| `< 1.0.0` | ❌ No |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues or pull requests.**

If you discover a security vulnerability (such as a `lockedPaths` or `taskId` traversal bypass, symlink escape, shell command injection, Git Guard data loss, OAuth code/token exposure, or API key leak):

1. Open a private report via **GitHub Security Advisories** (`Security` tab → `Report a vulnerability`) on this repository:
   - `https://github.com/xzawed/claude-antigravity-plugin/security/advisories/new`
2. Include as much detail as possible:
   - Affected component/file (e.g., `server/src/path-guard.ts`, `server/src/bridge-fs.ts`, `server/src/auth.ts`, `server/src/cli-admin.ts`, `server/src/engines/api-worker.ts`)
   - OS and Node.js version
   - Minimal reproduction steps or proof-of-concept payload
   - Potential impact and suggested remediation (if known)

### Response Targets

- **Initial acknowledgment:** within 48 hours
- **Severity triage & confirmation:** within 5 business days
- **Fix & coordinated disclosure:** prioritized via a security PR with regression tests in `server/tests/`

---

## Security Architecture & Boundaries (`v1.4.1`)

This plugin delegates file edits, browser automation, and verification commands to external/autonomous agents. Its defense-in-depth controls are documented in [docs/02-architecture/security-and-git-guard.md](./docs/02-architecture/security-and-git-guard.md) and enforced by automated security tests (`TC-S01` ~ `TC-S22c`):

1. **Fail-Closed `lockedPaths` & `taskId` Isolation (`server/src/path-guard.ts`, `server/src/bridge-fs.ts`):**
   - Validates `lockedPaths` **before** provider detection so protected paths are rejected even when no provider is configured.
   - Canonicalizes target paths with `path.resolve` + `fs.realpathSync.native` (the path the OS opens) to block `../` traversal and symlink/junction escapes outside the workspace or `lockedPaths`. On Windows the OS real path also expands 8.3 short names (`ENV~1` is `.env`, `GIT~1` is `.git`), and a segment holding `:` (alternate data stream) or ending in a dot or space is refused (`TC-S21` ~ `TC-S21c`).
   - Unconditionally blocks writes to `.git/**`, `.env`, `.env.*`, `node_modules/**`, and `.ag-bridge/config.json`, and blocks reads of `.env*`, `.ssh`, `*.pem`, `*.key`, and SSH private keys.
   - A repository can commit its own `.ag-bridge/config.json`. Settings that pick a program or a secret, or weaken a safety default, are therefore taken only from the user's own untracked config. The list is `TRUST_SENSITIVE` in `server/src/config.ts`, with the reasons in [ARC-003 §7](./docs/02-architecture/security-and-git-guard.md). A config that git tracks (in any letter case) or that is reached through a link has them ignored, and `check_ag_environment` names each one. `app_path` must always be an absolute path outside the workspace (`TC-S17` ~ `TC-S19d`).
   - Strictly validates `taskId` (`assertSafeTaskId`) against `^[a-zA-Z0-9._-]{1,128}$` without `..` segments in `getArtifactsDir`, `readArchivedManifest`, and `archiveManifest` so `list_ag_artifacts`, `get_ag_job`, and `rollback_ag_task` cannot escape `.ag-bridge/`.
2. **Restricted Verification Shell & Safe Subprocess Spawning (`server/src/engines/api-worker.ts`, `server/src/cli-admin.ts`, `server/src/engines/subscription.ts`):**
   - `run_command` validates commands against a strict build/typecheck/lint/test allowlist and rejects shell metacharacters and destructive binaries (`rm`, `git`, `curl`, `wget`, `powershell`, `bash`, `sudo`).
   - All subprocess executions default to `shell: false` (with quoted `cmd.exe /d /s /c` wrapping only for Windows `.cmd`/`.bat` shims).
   - Every helper program (`git`, `taskkill`, clipboard and notification tools, `powershell`, `osascript`, and the `cmd.exe` wrapper itself) is launched by **absolute path**, resolved from fully qualified `PATH` directories only (`server/src/exec-path.ts`). A relative entry such as `.` or `node_modules\.bin` resolves inside the opened workspace, where a cloned repository could ship a same-named binary; `agy`/`antigravity` discovery skips such entries too (`TC-S12` ~ `TC-S16`).
   - `ag_cli_admin` validates server names, rejects CR/LF/NUL control characters in `mcp_add` arguments/env/headers, defaults `mcp_sync_from_claude` to `dryRun: true`, and skips self-registration of `antigravity-delegate` to prevent recursive loops.
   - Strips `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` from API worker child environments.
3. **Authentication, Permissions & Secret Redaction (`server/src/auth.ts`, `server/src/config.ts`):**
   - `/ag-login` delegates Google OAuth exclusively to official `agy acp --login` (storing tokens in the OS native keyring) and never logs or echoes manual OAuth authorization codes.
   - `--dangerously-skip-permissions` (`always-proceed`) is **disabled by default** (`agy_dangerously_skip_permissions: false`), requires explicit opt-in, emits an audit warning, and remains paired with lossless Git Guard snapshots.
   - `maskSecrets()` redacts configured secrets plus Google API keys (`AIza...`), Google OAuth tokens (`ya29....`) & authorization codes (`4/0...`), OpenAI/Anthropic keys (`sk-...`), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), and `Bearer` headers across MCP responses, `report.md`, `agy-cli.log`, and `stderr`.
4. **Lossless Rollback & Process Hygiene (`server/src/git-guard.ts`, `server/src/jobs.ts`, `server/src/sessions.ts`):**
   - Snapshots working trees via `git stash create` pinned under `refs/ag-bridge/checkpoints/<taskId>` without altering `HEAD` or the user's `git stash list`, and preserves pre-existing untracked files on rollback.
   - Rollback deletes untracked files only against a recorded baseline. If git could not list them at checkpoint time, no checkpoint is made. A manifest without a baseline makes rollback remove no untracked file and warn (`TC-S22`, `TC-S22b`). On Windows and macOS the listing folds letter case, so a tracked file the agent renamed only in case is not taken for an untracked one (`TC-S22c`).
   - Each git command is cut off after 120 s (`AG_GIT_TIMEOUT_MS`), so a stalled filter cannot freeze the server (`TC-U34`).
   - Git Guard runs every git command with `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.allow=never`. A repository delivered with its own `.git/` (an archive or a shared folder) therefore cannot make status, checkpoint or rollback run its fsmonitor program or hooks. Nor can a partial clone's lazy fetch run its transport command such as `core.sshCommand` (`TC-S20` ~ `TC-S20c`). Clean/smudge filters stay on so checkpoints keep real content.
   - Automatically disposes pending auth sessions, background jobs, and persistent `stream-json` workers on MCP server exit.
5. **Dependency Hygiene:**
   - All dependencies are audited via `npm --prefix server audit`, and GitHub Actions CI runs with least-privilege `permissions: contents: read`.
6. **Zero-Execution SessionStart Hook & No Tracked-File Edits (`server/src/bridge-fs.ts`, `server/src/cli-init.ts`):**
   - The `SessionStart` hook runs in every folder Claude Code opens, so it never spawns a process: a bare `git` can resolve to a binary planted in that folder when `PATH` contains a relative entry such as `.`. `server/dist/cli-init.js` contains no `child_process` reference (`TC-S08`).
   - Inside a git repository it lists `.ag-bridge/` and the handoff template paths in the local-only `.git/info/exclude` instead of editing the tracked `.gitignore`. It accepts only a real git directory that contains `HEAD` and never writes through a symlink or junction (`TC-S09` ~ `TC-S11`). See [ADR-005](./docs/06-adr/ADR-005-local-git-exclude.md).
