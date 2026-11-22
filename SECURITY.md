# Security Policy

## Supported Versions

Security updates are actively maintained for the latest minor release of the `1.x` line:

| Version | Supported |
| :--- | :---: |
| `1.x` (current `main`) | ✅ Yes |
| `< 1.0.0` | ❌ No |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues or pull requests.**

If you discover a security vulnerability (such as a `lockedPaths` traversal bypass, symlink escape, shell command injection, Git Guard data loss, or API key leak):

1. Open a private report via **GitHub Security Advisories** (`Security` tab → `Report a vulnerability`) on this repository:
   - `https://github.com/xzawed/claude-antigravity-plugin/security/advisories/new`
2. Include as much detail as possible:
   - Affected component/file (e.g., `server/src/path-guard.ts`, `server/src/engines/api-worker.ts`)
   - OS and Node.js version
   - Minimal reproduction steps or proof-of-concept payload
   - Potential impact and suggested remediation (if known)

### Response Targets

- **Initial acknowledgment:** within 48 hours
- **Severity triage & confirmation:** within 5 business days
- **Fix & coordinated disclosure:** prioritized via a security PR with regression tests in `server/tests/`

---

## Security Architecture & Boundaries

This plugin delegates file edits and verification commands to external/autonomous agents. Its defense-in-depth controls are documented in [docs/02-architecture/security-and-git-guard.md](./docs/02-architecture/security-and-git-guard.md) and enforced by automated security tests (`TC-S01` ~ `TC-S05`):

1. **Fail-Closed `lockedPaths` Isolation (`server/src/path-guard.ts`):**
   - Canonicalizes target paths with `path.resolve` + `fs.realpathSync` to block `../` traversal and symlink/junction escapes outside the workspace or `lockedPaths`.
   - Unconditionally blocks writes to `.git/**`, `.env`, `.env.*`, `node_modules/**`, and `.ag-bridge/config.json`.
   - Blocks reads of `.env` secrets, `.ssh`, `*.pem`, `*.key`, and SSH private keys.
2. **Restricted Verification Shell (`server/src/engines/api-worker.ts`):**
   - `run_command` validates commands against a strict allowlist (`npm run`/`test`, `pnpm`, `yarn`, `bun`, `npx tsc`/`eslint`/`prettier`/`vitest`/`jest`/`next`/`vite`) and rejects shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `<`, `>`, `^`, `%`, `!`) and destructive binaries (`rm`, `git`, `curl`, `wget`, `powershell`, `bash`, `sudo`).
   - Strips `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` from child process environments.
3. **Secret Redaction & Local Isolation (`server/src/config.ts`, `server/src/bridge-fs.ts`):**
   - `.ag-bridge/` is automatically added to `.gitignore`.
   - `maskSecrets()` redacts configured API keys and Google API key patterns (`AIza...`) to `[REDACTED]` across MCP responses, `report.md`, `agy-cli.log`, and `stderr`.
4. **Lossless Rollback (`server/src/git-guard.ts`):**
   - Snapshots working trees via `git stash create` pinned under `refs/ag-bridge/checkpoints/<taskId>` without altering `HEAD` or the user's `git stash list`, and preserves pre-existing untracked files on rollback.
5. **Dependency Hygiene:**
   - All dependencies are audited via `npm --prefix server audit` (currently **0 known vulnerabilities**).
