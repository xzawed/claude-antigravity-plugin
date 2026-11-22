# Contributing to `claude-antigravity-plugin`

Thank you for your interest in contributing to `claude-antigravity-plugin`! Every change — code, documentation, tests, or CI improvements — follows a clean **Pull Request (PR) workflow** with cross-platform verification.

---

## 1. Prerequisites

- **Node.js** `>= 20.0.0` & **npm**
- **Git**
- Optional: **Claude Code CLI** (`claude`) and **Antigravity CLI** (`agy`) for live E2E testing

---

## 2. Local Development Setup

```bash
git clone https://github.com/xzawed/claude-antigravity-plugin.git
cd claude-antigravity-plugin
npm --prefix server install
npm --prefix server run typecheck
npm --prefix server run build
npm --prefix server test
npm --prefix server run verify
```

To test your local checkout directly inside Claude Code:

```bash
# macOS / Linux
claude --plugin-dir "$PWD"

# Windows PowerShell
claude --plugin-dir "$PWD"
```

After making edits, rebuild (`npm --prefix server run build`) and run `/reload-plugins` inside Claude Code.

---

## 3. Branching & Pull Request Workflow

Direct commits and pushes to `main` are not permitted.

1. Create a dedicated branch from `main` using conventional prefixes:
   - `feat/<short-topic>` — new features or capabilities
   - `fix/<short-topic>` — bug fixes or security patches
   - `docs/<short-topic>` — documentation, README, or ADR updates
   - `chore/<short-topic>` — dependency updates, CI, or tooling
2. Keep each PR focused on a single logical unit of change.
3. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (e.g., `feat:`, `fix:`, `docs:`, `ci:`, `chore:`).
4. Before opening a PR, run all local verification gates:
   ```bash
   npm --prefix server run typecheck
   npm --prefix server run build
   npm --prefix server test
   npm --prefix server run verify
   npm --prefix server audit
   ```
5. Fill out `.github/pull_request_template.md` with your change summary, related docs/task IDs, and verification results.
6. Ensure all **7 GitHub Actions CI checks** (Ubuntu, macOS, Windows × Node 20/22 + Docs & `AGENTS.md` Integrity) pass before merge.

---

## 4. Engineering Invariants (Required for All PRs)

Please read [AGENTS.md](./AGENTS.md) and [docs/00-standards/documentation-standard.md](./docs/00-standards/documentation-standard.md) before making architectural changes:

1. **Path Security (`lockedPaths`):** Never bypass `path-guard.ts`. All write paths must pass `path.resolve` + `fs.realpathSync` canonicalization, and `.git/`, `.env*`, `node_modules/`, and `.ag-bridge/config.json` must remain strictly protected.
2. **Stdio MCP Protocol Safety:** `server/src/index.ts` reserves `stdout` exclusively for MCP JSON-RPC frames. All diagnostic logs must go to `stderr` (`console.error`).
3. **Atomic Bridge I/O:** State files under `.ag-bridge/` (`manifest.json`, `config.json`) must be updated atomically via `.tmp` write + `rename`.
4. **Cross-Platform Safety:** Use `path.join` / `path.resolve` (`path.win32` / `path.posix` when targeting a specific OS), quote `${CLAUDE_PLUGIN_ROOT}` in shell hooks, and prefer `spawn(..., { shell: false })` (with `buildCliSpawnSpec` for Windows `.cmd`/`.bat`).
5. **Secret Redaction:** Never log, persist, or return raw API keys (`GEMINI_API_KEY`, `AIza...`). Always pass untrusted outputs through `maskSecrets()`.
6. **Docs & Code Synchronization:** When changing MCP schemas, config keys, error codes, or CLI flags, update `docs/03-specs/`, `README.md`, and `README.ko.md` in the same PR.

---

## 5. License

By contributing to this repository, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
