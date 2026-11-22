<div align="center">

<img src="./assets/hero-banner.jpg" alt="claude-antigravity-plugin hero banner" width="100%" />

# `claude-antigravity-plugin`

**Delegate Frontend UI, Multi-File Refactoring & Browser E2E Visual QA from Claude Code to Antigravity**

[![CI](https://github.com/xzawed/claude-antigravity-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/xzawed/claude-antigravity-plugin/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Stdio%20Server-6B4FBB)](https://modelcontextprotocol.io/)
[![Dual Engine](https://img.shields.io/badge/engines-Subscription%20%7C%20Gemini%20API-4285F4)](#dual-execution-modes)
[![Tests](https://img.shields.io/badge/tests-35%20passed-brightgreen)](./docs/05-verification/verification-report.md)
[![Security](https://img.shields.io/badge/npm%20audit-0%20vulnerabilities-brightgreen)](#security--safety-guarantees)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](./.claude-plugin/plugin.json)

🌐 **Language:** **English** · [한국어 (README.ko.md)](./README.ko.md)

[Overview](#overview) · [Installation](#installation-in-claude-code) · [Usage Guide](#how-to-use-in-claude-code) · [Architecture](#architecture) · [Benchmarks](#empirical-benchmarks) · [Security](#security--safety-guarantees) · [Troubleshooting](#troubleshooting)

</div>

---

## At a Glance

| ⚡ Diagnostics Speed | 🛡️ Automated Verification | 🌍 Cross-Platform CI | 🔒 Dependency Security |
| :---: | :---: | :---: | :---: |
| **`149.9 ms`** avg | **`35 / 35`** tests | **`7 / 7`** matrix jobs | **`0`** vulnerabilities |
| `check_ag_environment` (`4.3×` speedup) | Unit · Security · Live Stdio MCP | Ubuntu · macOS · Windows (Node 20/22) | `vitest 5.1` · `zod 4.6` · `MCP 1.27` |

---

## Overview

`claude-antigravity-plugin` (Claude Code plugin & MCP server: **`antigravity-delegate`**) connects **Claude Code** (main orchestrator, backend & architecture lead) with **Antigravity** (frontend UI builder, multi-file refactoring & real-browser visual QA specialist) through an embedded **Stdio MCP server** and a transparent `.ag-bridge/` file protocol.

- **Zero Manual Copy-Paste:** Claude dispatches structured specs, TypeScript types, `lockedPaths`, `verifyUrl`, and acceptance criteria directly to Antigravity and receives a verified report plus screenshots.
- **Zero Extra Billing for Subscribers:** Automatically detects your local Antigravity CLI (`agy`, `antigravity`, `ag`) or desktop app first, falling back to `GEMINI_API_KEY` only when no local subscription provider is installed.
- **Zero Risk to Uncommitted Work:** Automatically snapshots dirty trees (staged, unstaged, and pre-existing untracked files) via Git Guard before every delegation so you can roll back cleanly at any time.

---

## Installation in Claude Code

### Prerequisites

- **Node.js** `>= 20.0.0` & **npm**
- **Git** (required for automatic Git Guard checkpoints & rollbacks)
- **Claude Code CLI** (`claude`)
- **At least one Antigravity provider:**
  - **Subscription Mode (Recommended):** Local Antigravity CLI (`agy`) or Antigravity Desktop App signed in with your account
  - **API Fallback Mode:** A `GEMINI_API_KEY` from Google AI Studio

### Step 1 — Clone & Build the Embedded MCP Server

```bash
git clone https://github.com/xzawed/claude-antigravity-plugin.git
cd claude-antigravity-plugin/server
npm install
npm run build        # Compiles TypeScript into server/dist/
npm run verify       # Runs live manifest, space-path cli-init & Stdio MCP healthcheck
```

> **Important:** Claude Code launches `server/dist/index.js` and `server/dist/cli-init.js`. Always run `npm run build` inside `server/` after cloning or pulling updates.

### Step 2 — Load the Plugin into Claude Code

Choose **one** of the three official Claude Code installation methods below:

#### Option A — Persistent Plugin Install via Claude Code Marketplace *(Recommended)*

This repository includes `.claude-plugin/marketplace.json`, so you can install it persistently across sessions (User, Project, or Local scope) directly inside Claude Code:

```text
# 1. Register your local cloned directory (or GitHub repo) as a marketplace inside Claude Code
/plugin marketplace add /absolute/path/to/claude-antigravity-plugin
# Or from GitHub (requires GitHub access if private):
# /plugin marketplace add xzawed/claude-antigravity-plugin

# 2. Install the plugin (Claude Code will prompt you for User / Project / Local scope)
/plugin install antigravity-delegate@claude-antigravity-plugin
```

#### Option B — Instant Per-Session Loading with `--plugin-dir` *(Great for Testing & Development)*

Load the plugin immediately from your local checkout without registering a marketplace:

```bash
# Optional: validate plugin manifests first
claude plugin validate /absolute/path/to/claude-antigravity-plugin

# Launch Claude Code with the plugin loaded for this session (additive — keeps existing plugins)
claude --plugin-dir /absolute/path/to/claude-antigravity-plugin
```

On **Windows PowerShell**:

```powershell
claude --plugin-dir "F:\DEVELOPMENT\SOURCE\CLAUDE\claude-antigravity-plugin"
```

> **Tip:** If you edit plugin files while Claude Code is running, run `/reload-plugins` inside the session to reload without restarting.

#### Option C — Standalone MCP Server Only *(Without Slash Commands / Hooks)*

If you only want the 3 MCP tools (`delegate_to_antigravity`, `check_ag_environment`, `rollback_ag_task`) without the `SessionStart` hook, skill, or slash commands:

```bash
# macOS / Linux
claude mcp add antigravity-delegate -- node "/absolute/path/to/claude-antigravity-plugin/server/dist/index.js"

# Windows PowerShell
claude mcp add antigravity-delegate -- node "F:\DEVELOPMENT\SOURCE\CLAUDE\claude-antigravity-plugin\server\dist\index.js"
```

### Step 3 — Configure Your Execution Provider

- **If you have Antigravity installed (Subscription Mode):** No extra setup is required. The plugin automatically detects `agy`, `antigravity`, `ag`, or the desktop app even when the MCP host strips `PATH`.
- **If you want API Fallback Mode (No local app / Headless SSH / CI):** Set `GEMINI_API_KEY` in your shell environment before starting Claude Code:

```bash
# macOS / Linux (~/.bashrc or ~/.zshrc)
export GEMINI_API_KEY="your-gemini-api-key"
```

```powershell
# Windows PowerShell (current session)
$env:GEMINI_API_KEY = "your-gemini-api-key"

# Windows PowerShell (persist for future sessions)
setx GEMINI_API_KEY "your-gemini-api-key"
```

### What Activates Automatically on Session Start

When loaded as a Claude Code plugin (Options A or B), the `SessionStart` hook (`hooks/hooks.json`) runs `cli-init.js --silent` (`< 90ms`) in your target project workspace and automatically:
1. Creates `.ag-bridge/` (`config.json`, `artifacts/`, `history/`)
2. Appends `.ag-bridge/` to your project's `.gitignore` (idempotently — never duplicates)
3. Syncs `templates/claude-handoff.md` into `.agent/workflows/claude-handoff.md` (and mirrors to `.agents/workflows/claude-handoff.md` if `.agents/` exists), without overwriting user-customized files

---

## How to Use in Claude Code

### 1. Check Connection & Active Engine (`/ag-status`)

Inside any project opened in Claude Code, run:

```text
/ag-status
```

Claude calls `check_ag_environment({})` and prints a live diagnostic summary:

| Check | Status / Value | Details |
| :--- | :--- | :--- |
| **Execution Mode** | `auto` → **`subscription`** | Active provider resolution |
| **Subscription App/CLI** | `Detected` | `agy` (`C:\Users\...\agy\bin\agy.exe`), `cli_or_ipc` |
| **Gemini API Key** | `Not set` / `Configured (env)` | Env `GEMINI_API_KEY`, model `gemini-2.5-pro`, max turns `15` |
| **Bridge (`.ag-bridge/`)** | `IDLE` | Initialized: `yes`, `.gitignore`: `protected`, Last Task: `none` |
| **Git Guard** | `Ready` | Branch `main`, Working tree `clean` |

### 2. Configure Mode, Model, or Guardrails (`/ag-config`)

Settings are stored per workspace in `.ag-bridge/config.json`:

```text
/ag-config                                # Inspect current settings
/ag-config mode auto                      # Subscription first, API fallback (default)
/ag-config mode subscription              # Force local Antigravity subscription mode
/ag-config mode api                       # Force headless Gemini API mode
/ag-config model gemini-2.5-flash         # Change Gemini model for API mode
/ag-config timeout 600                    # Set Subscription timeout in seconds (30–1800)
/ag-config max-turns 20                   # Set API worker turn budget (1–50)
/ag-config git-guard required             # Require a Git repo before delegating (best_effort | required)
```

### 3. Autonomous Delegation (Just Prompt Claude Naturally)

Because `skills/ag-delegate/SKILL.md` is loaded automatically, Claude Code recognizes frontend UI, multi-file scaffolding, and real-browser E2E tasks on its own. For example:

> *"We finalized `/api/checkout` in `src/server/checkout.ts`. Please build the responsive Checkout page and CartDrawer under `src/components/checkout/` and `src/pages/CheckoutPage.tsx`, then verify the rendered UI and form submission on `http://localhost:3000/checkout` with zero console errors."*

**What happens behind the scenes:**
1. Claude calls `check_ag_environment` to verify the active engine (`subscription` or `api`).
2. Claude calls `delegate_to_antigravity` with least-privilege `lockedPaths` (`["src/components/checkout/", "src/pages/CheckoutPage.tsx"]`), full API types, `verifyUrl`, and mode-appropriate `acceptanceCriteria`.
3. The MCP server creates a lossless Git Guard checkpoint, writes `.ag-bridge/dispatch.md` & `manifest.json`, and runs Antigravity (`agy --print --mode accept-edits --sandbox --output-format stream-json`) or the Gemini API worker.
4. While `agy` works, real-time NDJSON heartbeats refresh `manifest.json` and save redacted logs to `.ag-bridge/artifacts/<taskId>/agy-cli.log`.
5. On completion (`VERIFIED`), Claude receives `.ag-bridge/report.md`, `changedFiles`, and screenshot paths, reviews `git diff`, and summarizes the verified results for you.

### 4. Explicit Manual Delegation (`/ag-delegate`)

Use `/ag-delegate` whenever you want to delegate a specific task explicitly:

```text
# Subscription mode with real-browser visual QA on a local dev server
/ag-delegate Build the analytics KPI cards and filterable data table --paths src/components/analytics/,src/pages/Analytics.tsx --url http://localhost:3000/analytics

# Force headless Gemini API mode for a pure code/typecheck refactor
/ag-delegate Migrate FormField and SelectInput components to Tailwind v4 tokens --paths src/components/forms/ --mode api
```

### 5. Review & One-Click Rollback (`rollback_ag_task`)

After delegation finishes, inspect Claude's summary, `.ag-bridge/report.md`, and any screenshots in `.ag-bridge/artifacts/<taskId>/`. If the output isn't what you wanted, simply tell Claude:

> *"Roll back the last Antigravity task."*

Claude calls `rollback_ag_task({ taskId })`, which:
- Restores all tracked, staged, unstaged, and deleted files back to the exact pre-delegation `gitCheckpointRef`
- Deletes only untracked files created *during* delegation — preserving every pre-existing untracked file you had beforehand
- Resets `.ag-bridge/manifest.json` back to `IDLE`

---

## Architecture

<p align="center">
  <img src="./assets/architecture-diagram.svg" alt="claude-antigravity-plugin Dual-Engine Architecture" width="100%" />
</p>

### Dual Execution Modes

Default `execution_mode: "auto"` resolves the optimal engine automatically:

| Mode | Detection Priority | Execution Engine | Verification Scope | Billing |
| :--- | :---: | :--- | :--- | :--- |
| **`subscription`** | **1st** *(Primary)* | Official `agy --print --mode accept-edits --sandbox --output-format stream-json --print-timeout` CLI → OS IPC → Clipboard fallback | Real browser rendering, console/network checks & screenshots in `.ag-bridge/artifacts/` | Existing Antigravity subscription quota (`$0` extra API cost) |
| **`api`** | **2nd** *(Fallback)* | Embedded `@google/genai` autonomous 4-tool loop (`read_file`, `write_file`, `list_dir`, `run_command`) | `npx tsc --noEmit` & project build verification | `GEMINI_API_KEY` pay-per-token |

---

## MCP Tools & Slash Commands Reference

| MCP Tool | Input Parameters | Description |
| :--- | :--- | :--- |
| **`delegate_to_antigravity`** | `title`, `instructions`, `lockedPaths`, `acceptanceCriteria`, `verifyUrl?`, `modeOverride?`, `workspaceRoot?` | Creates a Git checkpoint, writes `.ag-bridge/dispatch.md`, executes Subscription or API engine, and returns `reportMarkdown`, `changedFiles`, and `artifacts`. |
| **`check_ag_environment`** | `workspaceRoot?` | Diagnoses resolved mode, detected Antigravity CLI/app paths (resilient to stripped MCP host `PATH`), redacted API key status, Git state, and bridge status. |
| **`rollback_ag_task`** | `taskId?`, `workspaceRoot?` | Restores tracked, staged, unstaged, and deleted files to `gitCheckpointRef` (supports both current and archived `taskId`s) while preserving pre-existing untracked files. |

| Slash Command | Syntax |
| :--- | :--- |
| **`/ag-delegate`** | `/ag-delegate <instructions> [--paths p1,p2] [--url http://localhost:3000] [--mode auto\|subscription\|api]` |
| **`/ag-config`** | `/ag-config [mode\|model\|timeout\|max-turns\|git-guard <value>]` |
| **`/ag-status`** | `/ag-status` |

---

## Empirical Benchmarks

Every performance target (`NFR-005`) and cross-platform edge case is empirically verified on real hardware and CI ([Full Report: `VER-002`](./docs/05-verification/verification-report.md)):

<p align="center">
  <img src="./assets/performance-benchmarks.svg" alt="Empirical Performance Benchmarks and Quality Metrics" width="100%" />
</p>

| Metric | Target (`NFR-005`) | Before Optimization | After Optimization | Status |
| :--- | :---: | :---: | :---: | :---: |
| `check_ag_environment` (Live Stdio MCP) | `< 500 ms` | `652.9 ms` avg | **`149.9 ms` avg** (`4.3×` faster) | ✅ **PASS** |
| `cli-init.js --silent` (`SessionStart` hook) | `< 300 ms` | `99.1 ms` avg | **`90.3 ms` avg** (`3.3×` headroom) | ✅ **PASS** |
| Automated TDD Suite (`vitest run`) | `>= 80%` core paths | 27 tests | **`35 / 35` tests (6 suites)** | ✅ **PASS** |
| Windows `.cmd` CLI Spawn (Node 20.12+/24) | No `EINVAL` crash | `spawn EINVAL` | `buildCliSpawnSpec` safe wrapper | ✅ **PASS** |

---

## Security & Safety Guarantees

<p align="center">
  <img src="./assets/state-machine.svg" alt=".ag-bridge State Machine and Lossless Git Guard Rollback" width="100%" />
</p>

| Safety Layer | Enforcement Mechanism | What It Prevents |
| :--- | :--- | :--- |
| **Path Guard (`path-guard.ts`)** | `path.resolve` + `fs.realpathSync` canonicalization + fail-closed `lockedPaths` | `../` path traversal, symlink escapes, edits to `.git/`, `.env*`, `node_modules/`, `.ag-bridge/config.json` |
| **Git Guard (`git-guard.ts`)** | `git stash create` pinned under `refs/ag-bridge/checkpoints/<taskId>` + `untrackedBaseline` | Losing user's pre-existing staged/unstaged edits or untracked files during `rollback_ag_task` |
| **Atomic Bridge (`bridge-fs.ts`)** | `.tmp` write + atomic `rename`, single-task lock (`BRIDGE_BUSY`), stale-lock auto-archive | Corrupted `manifest.json` reads, overlapping delegations, accidental commits (`.gitignore` auto-protected) |
| **Command & Secret Guard** | Strict build/typecheck/lint/test allowlist + stripped child env + `[REDACTED]` masking | Shell injection (`&&`, `\|`, `;`), destructive commands (`rm`, `git push`), API key leaks |

---

## Troubleshooting

| Symptom / Error Code | Cause | Resolution |
| :--- | :--- | :--- |
| **`NO_ANTIGRAVITY_PROVIDER`** | Neither local Antigravity (`agy`/app) nor `GEMINI_API_KEY` was detected | Install & sign in to Antigravity (`agy`), **or** export `GEMINI_API_KEY` and re-run `/ag-status`. |
| **`SUBSCRIPTION_UNAVAILABLE`** | `mode: subscription` is forced, but CLI/app is in a non-standard location | Set `"app_path": "/your/path/to/agy"` in `.ag-bridge/config.json` (binary type `agy` is auto-inferred), or switch with `/ag-config mode api`. |
| **`BRIDGE_BUSY`** | A previous delegation is still `DISPATCHED` or `RUNNING` within `timeout_sec` | Wait for it to finish, check `.ag-bridge/artifacts/<taskId>/agy-cli.log`, or let stale lock recovery trigger after `timeout_sec`. |
| **MCP server fails to start in Claude Code** | `server/dist/index.js` was not compiled yet | Run `cd server && npm install && npm run build && npm run verify`, then run `/reload-plugins` in Claude Code. |
| **Windows path with spaces** | Unquoted plugin path in CLI flags | Always wrap paths with spaces in double quotes (`claude --plugin-dir "C:\My Plugins\claude-antigravity-plugin"`). `hooks/hooks.json` already quotes `${CLAUDE_PLUGIN_ROOT}` safely. |

---

<details>
<summary><strong>📁 Repository Layout & Configuration Reference (Click to expand)</strong></summary>

### Directory Structure

```text
claude-antigravity-plugin/
├── assets/                        # README hero banner & vector architecture/benchmark diagrams
├── .claude-plugin/
│   ├── plugin.json                # Claude Code plugin manifest
│   └── marketplace.json           # Claude Code marketplace catalog for `/plugin install`
├── .mcp.json                      # Embedded Stdio MCP server definition
├── .github/workflows/ci.yml       # Cross-platform CI (Ubuntu/Windows/macOS x Node 20/22)
├── hooks/hooks.json               # SessionStart auto-initialization hook
├── skills/ag-delegate/SKILL.md    # Autonomous delegation & review skill
├── commands/                      # /ag-delegate, /ag-config, /ag-status
├── templates/claude-handoff.md    # Antigravity handoff workflow template
├── server/                        # TypeScript MCP server, dual engines, verifier & tests
│   ├── src/
│   │   ├── index.ts               # MCP Stdio server entrypoint (3 tools)
│   │   ├── cli-init.ts            # SessionStart initializer CLI
│   │   ├── types.ts               # State machine, config & error code types
│   │   ├── config.ts              # Config precedence, Zod validation & secret masking
│   │   ├── path-guard.ts          # lockedPaths canonicalization & traversal guard
│   │   ├── bridge-fs.ts           # Atomic .ag-bridge/ I/O, locking & history archive
│   │   ├── git-guard.ts           # Lossless Git checkpoint & rollback
│   │   ├── detector.ts            # Pure-JS cross-platform agy/antigravity & API detector
│   │   └── engines/
│   │       ├── base.ts            # ExecutionEngine strategy interface
│   │       ├── subscription.ts    # Local Antigravity CLI/IPC + stream-json heartbeat watcher
│   │       └── api-worker.ts      # @google/genai 4-tool autonomous loop engine
│   ├── scripts/verify-plugin.mjs  # Live healthcheck & Stdio MCP smoke verifier
│   └── tests/                     # 6 suites / 35 automated tests (unit, security, E2E)
├── AGENTS.md                      # Antigravity workspace rules & PR workflow invariants
├── README.md                      # English documentation (this file)
├── README.ko.md                   # Complete Korean documentation
└── docs/                          # Antigravity standard documentation hub (00~06)
```

### Default `.ag-bridge/config.json`

```json
{
  "execution_mode": "auto",
  "git_guard": "best_effort",
  "subscription": {
    "app_path": "auto",
    "trigger_method": "cli_or_ipc",
    "timeout_sec": 300,
    "poll_interval_ms": 2000,
    "agy_mode": "accept-edits",
    "agy_sandbox": true,
    "agy_stream_heartbeat": true
  },
  "api": {
    "api_key_env": "GEMINI_API_KEY",
    "model": "gemini-2.5-pro",
    "max_turns": 15,
    "command_timeout_sec": 60
  }
}
```

</details>

---

## Documentation Hub

All engineering docs follow the [Antigravity Documentation Standard](./docs/00-standards/documentation-standard.md) — see [docs/README.md](./docs/README.md):

| Stage | Documents |
| :--- | :--- |
| **01. Planning** | [PRD](./docs/01-planning/PRD.md) · [User & Agent Flows](./docs/01-planning/user-flows.md) |
| **02. Architecture** | [System Architecture](./docs/02-architecture/system-architecture.md) · [Bridge Protocol](./docs/02-architecture/bridge-protocol.md) · [Security & Git Guard](./docs/02-architecture/security-and-git-guard.md) |
| **03. Specifications** | [MCP Tools API](./docs/03-specs/mcp-tools-api.md) · [Execution Engines](./docs/03-specs/execution-engines.md) · [Prompts & Commands](./docs/03-specs/prompts-and-commands.md) |
| **04–06. Delivery & QA** | [Implementation Plan](./docs/04-implementation/implementation-plan.md) · [Task Checklist](./docs/04-implementation/task-checklist.md) · [Test & QA Plan](./docs/05-verification/test-and-qa-plan.md) · [Empirical Verification (`VER-002`)](./docs/05-verification/verification-report.md) · [ADRs](./docs/06-adr/README.md) |
