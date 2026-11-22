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

[Overview](#overview) · [Architecture](#architecture) · [Benchmarks](#empirical-benchmarks) · [Quick Start](#quick-start) · [Tools & Commands](#mcp-tools--slash-commands) · [Security](#security--safety-guarantees) · [**한국어 가이드**](#한국어-가이드-korean-guide)

</div>

---

## At a Glance

| ⚡ Diagnostics Speed | 🛡️ Automated Verification | 🌍 Cross-Platform CI | 🔒 Dependency Security |
| :---: | :---: | :---: | :---: |
| **`149.9 ms`** avg | **`35 / 35`** tests | **`7 / 7`** matrix jobs | **`0`** vulnerabilities |
| `check_ag_environment` (`4.3×` speedup) | Unit · Security · Live Stdio MCP | Ubuntu · macOS · Windows (Node 20/22) | `vitest 5.1` · `zod 4.6` · `MCP 1.27` |

---

## Overview

`claude-antigravity-plugin` (MCP Server: `antigravity-delegate`) bridges **Claude Code** (main orchestrator & backend/architecture lead) and **Antigravity** (frontend UI builder, multi-file generator & browser visual QA specialist) through an embedded **Stdio MCP server** and a transparent `.ag-bridge/` file protocol.

- **Zero Manual Copy-Paste:** Claude dispatches structured specs, types, `lockedPaths`, and acceptance criteria directly to Antigravity and receives a verified report plus screenshots.
- **Zero Extra Billing for Subscribers:** Automatically detects your local Antigravity CLI (`agy`, `antigravity`, `ag`) or desktop app first, falling back to `GEMINI_API_KEY` only when no local subscription provider exists.
- **Zero Risk to Uncommitted Work:** Automatically snapshots dirty trees (staged, unstaged, and pre-existing untracked files) via Git Guard before every delegation.

---

## Architecture

<p align="center">
  <img src="./assets/architecture-diagram.svg" alt="claude-antigravity-plugin Dual-Engine Architecture" width="100%" />
</p>

### Dual Execution Modes

Default `execution_mode: "auto"` resolves the best available engine automatically:

| Mode | Detection Priority | Execution Engine | Verification Scope | Billing |
| :--- | :---: | :--- | :--- | :--- |
| **`subscription`** | **1st** *(Primary)* | Official `agy --print --mode accept-edits --sandbox --print-timeout` CLI → OS IPC → Clipboard fallback | Real browser rendering, console/network checks & screenshots in `.ag-bridge/artifacts/` | Existing Antigravity subscription quota (`$0` extra API cost) |
| **`api`** | **2nd** *(Fallback)* | Embedded `@google/genai` autonomous 4-tool loop (`read_file`, `write_file`, `list_dir`, `run_command`) | `npx tsc --noEmit` & project build verification | `GEMINI_API_KEY` pay-per-token |

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

## Quick Start

### 1. Install, Build & Run Live Healthcheck

> **Prerequisites:** Node.js `>= 20.x`, Git

```bash
cd server
npm install
npm run build        # Compile TypeScript -> server/dist/
npm run typecheck    # Strict type check (tsc --noEmit)
npm test             # Run all 35 automated tests (unit, security, integration, Stdio MCP)
npm run verify       # Live manifest + space-path cli-init + Stdio MCP handshake check
```

### 2. Mount in Claude Code

Point Claude Code's plugin loader at this repository root. All plugin surfaces activate automatically:
- **MCP Server** (`.mcp.json`) → `node ${CLAUDE_PLUGIN_ROOT}/server/dist/index.js`
- **SessionStart Hook** (`hooks/hooks.json`) → initializes `.ag-bridge/`, `.gitignore`, and `.agent/workflows/claude-handoff.md` silently
- **Autonomous Skill** (`skills/ag-delegate/SKILL.md`) → detects UI/E2E tasks and enforces mode-appropriate acceptance criteria
- **Slash Commands** (`commands/`) → `/ag-delegate`, `/ag-config`, `/ag-status`

### 3. Enable API Fallback Mode *(Optional)*

```bash
# macOS / Linux
export GEMINI_API_KEY="your-gemini-api-key"

# Windows PowerShell
$env:GEMINI_API_KEY = "your-gemini-api-key"
```

---

## MCP Tools & Slash Commands

| MCP Tool | Purpose |
| :--- | :--- |
| **`delegate_to_antigravity`** | Creates a Git checkpoint, writes `.ag-bridge/dispatch.md`, runs Subscription or API engine, and returns `reportMarkdown`, `changedFiles`, and `artifacts`. |
| **`check_ag_environment`** | Diagnoses resolved mode, detected Antigravity CLI/app paths (resilient to stripped MCP host `PATH`), redacted API key status, Git state, and bridge status. |
| **`rollback_ag_task`** | Restores tracked, staged, unstaged, and deleted files to `gitCheckpointRef` while keeping pre-existing user untracked files intact. |

| Slash Command | Usage |
| :--- | :--- |
| `/ag-delegate` | Manually delegate a task: `/ag-delegate <instructions> [--paths p1,p2] [--url http://localhost:3000] [--mode auto\|subscription\|api]` |
| `/ag-config` | View or update `.ag-bridge/config.json`: `/ag-config mode\|model\|timeout\|max-turns\|git-guard <value>` |
| `/ag-status` | Print a live diagnostic table via `check_ag_environment` |

<details>
<summary><strong>📁 Repository Layout & Configuration Reference (Click to expand)</strong></summary>

### Directory Structure

```text
claude-antigravity-plugin/
├── assets/                        # README hero banner & vector architecture/benchmark diagrams
├── .claude-plugin/plugin.json     # Claude Code plugin manifest
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
│   │       ├── subscription.ts    # Local Antigravity CLI/IPC trigger + hybrid watcher
│   │       └── api-worker.ts      # @google/genai 4-tool autonomous loop engine
│   ├── scripts/verify-plugin.mjs  # Live healthcheck & Stdio MCP smoke verifier
│   └── tests/                     # 6 suites / 33 automated tests (unit, security, E2E)
├── AGENTS.md                      # Antigravity workspace rules & PR workflow invariants
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

---

## 한국어 가이드 (Korean Guide)

> **한 줄 요약:** **Claude Code(메인 오케스트레이터)**가 프론트엔드 UI 구현, 다중 파일 리팩토링, 실제 브라우저 E2E 시각적 검증을 **Antigravity(로컬 구독 CLI/앱 또는 Gemini API 워커)**에 안전하게 위임하고 리포트·스크린샷을 자동 회수하는 MCP 협업 플러그인입니다.

### 핵심 특징 및 실측 수치

| 항목 | 내용 | 실측 / 검증 결과 |
| :--- | :--- | :--- |
| **듀얼 실행 엔진** | `auto` 모드에서 로컬 Antigravity(`agy`/`antigravity`) 구독 우선 감지 → 미감지 시 `GEMINI_API_KEY` 자동 폴백 | 로컬 `agy.exe` 자동 감지 (`resolved=subscription`) |
| **초고속 환경 진단** | 서브프로세스 없는 순수 JS `PATH` 탐색 + 단일 `git status --porcelain=v1 -b` 통합 | `check_ag_environment` **`149.9ms`** (`4.3×` 개선), `cli-init` **`90.3ms`** |
| **보안·경로 격리** | `realpathSync` 기반 `lockedPaths` 쓰기 제한, `.git/`·`.env*` 차단, 명령 허용목록, API 키 마스킹 | 보안 테스트 `TC-S01`~`TC-S05` 100% 통과, `npm audit` **0건** |
| **무손실 Git Guard** | `git stash create` 핀 고정 + `untrackedBaseline` 스냅샷으로 위임 전 작업 100% 보존 | Staged/Unstaged/삭제 파일 완벽 원복 (`TC-U07`~`U11`, `TC-I06`) |
| **크로스플랫폼 CI** | Ubuntu · macOS · Windows × Node 20 / 22 매트릭스 + 문서 링크 무결성 자동 검사 | **7 / 7 CI 잡** 및 **35 / 35 테스트** 전원 통과 |

### 빠른 시작 (한국어)

```bash
cd server
npm install
npm run typecheck    # TypeScript strict 타입 검사
npm run build        # server/dist/ 컴파일
npm test             # 전체 35개 자동화 테스트 실행
npm run verify       # 매니페스트 · 공백경로 cli-init · 라이브 Stdio MCP 헬스체크
```

- **PR 단위 개발 규칙:** `main` 브랜치 직접 푸시를 금지하며, 모든 기능·수정·문서 작업은 전용 브랜치(`feat/*`, `fix/*`, `docs/*`, `chore/*`)에서 검증 후 Pull Request로 제출합니다([AGENTS.md](./AGENTS.md)).
