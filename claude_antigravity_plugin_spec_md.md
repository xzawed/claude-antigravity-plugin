# Technical Specification: `claude-antigravity-plugin`

## 1. Document Overview
- **Project Name:** `claude-antigravity-plugin` (MCP-based Agent Delegation Plugin for Claude Code)
- **Version:** 1.0.0
- **Author:** xzawed
- **Reference Architecture:** `https://github.com/xzawed/claude-grok-build-plugin`
- **Target Runtime:** Node.js >= 20.x, TypeScript >= 5.x, Claude Code Plugin System (`.claude-plugin`, `.mcp.json`, `hooks`, `skills`, `commands`)

### 1.1 Purpose & Core Concept
본 프로젝트는 **Claude Code(메인 오케스트레이터)**가 작업 수행 중 프론트엔드 UI 구현, 다중 파일 리팩토링, 브라우저 E2E 시각적 검증 등 **Antigravity 에이전트**의 강점이 필요한 태스크를 감지했을 때, 플러그인 내장 MCP 서버를 통해 백그라운드에서 작업을 위임(Delegate)하고 그 결과물과 검증 리포트를 회수하는 협업 플러그인이다.

### 1.2 Dual Execution Mode (핵심 요구사항)
플러그인은 사용자의 로컬 환경에 따라 두 가지 실행 엔진을 자동 감지(`auto`) 또는 수동 설정으로 전환하여 동작해야 한다.
1. **Subscription Mode (`subscription`):** 로컬 머신에 Antigravity 앱/CLI가 설치되어 있고 구독 세션이 활성화된 경우, 별도의 API 과금 없이 사용자의 **Antigravity 구독 쿼터(Pro/Ultra 등)**로 로컬 에이전트를 구동하며 내장 Browser Subagent를 통한 시각적 검증을 수행한다.
2. **API Fallback Mode (`api`):** Antigravity 미구독자 또는 헤드리스 환경의 경우, `GEMINI_API_KEY`를 사용하여 `claude-grok-build-plugin`과 동일한 방식의 **내장 Gemini 에이전트 루프(Tool-calling Worker)**를 실행해 코드를 구현하고 빌드/타입 검증을 수행한다.

---

## 2. System Architecture & Data Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Claude Code Session (User Interface)                   │
│  • User prompts Claude -> SKILL.md evaluates delegation criteria            │
│  • Slash Commands: /ag-delegate, /ag-config, /ag-status                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ MCP Tool: delegate_to_antigravity()
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               Plugin Embedded MCP Server (server/dist/index.js)             │
│  1. Git Guard: Create safety checkpoint (git commit / stash)                │
│  2. Bridge Init: Write .ag-bridge/manifest.json & .ag-bridge/dispatch.md    │
│  3. Mode Detector: Resolve 'subscription' vs 'api'                          │
└──────────────────┬───────────────────────────────────────┬──────────────────┘
                   │ [Mode A: Subscription]                │ [Mode B: API]
                   ▼                                       ▼
┌──────────────────────────────────────┐ ┌──────────────────────────────────────┐
│      Subscription Engine (Local)     │ │      Headless API Engine (Gemini)    │
│ • Trigger Antigravity CLI / OS IPC   │ │ • @google/genai SDK + Function Call  │
│ • Execute /claude-handoff workflow   │ │ • Scoped FS read/write & shell tools │
│ • Run Browser Subagent & Screenshot  │ │ • Verify via tsc / build / lint      │
│ • Write .ag-bridge/report.md         │ │ • Write .ag-bridge/report.md         │
└──────────────────┬───────────────────┘ └──────────────────┬───────────────────┘
                   │                                       │
                   └───────────────────┬───────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MCP Tool Response -> Claude Code Review                  │
│  • Returns report.md content, modified file list, and artifact paths        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Repository Directory Structure

Antigravity는 아래 표준 디렉터리 구조에 따라 스캐폴딩을 생성해야 한다.

```text
claude-antigravity-plugin/
├── .claude-plugin/
│   └── plugin.json                 # Claude Code 플러그인 매니페스트
├── .mcp.json                       # 내장 MCP 서버 실행 정의
├── hooks/
│   └── hooks.json                  # SessionStart 자동 환경 초기화 훅
├── skills/
│   └── ag-delegate/
│       └── SKILL.md                # 클로드의 자율적 위임 판단 및 검수 프롬프트
├── commands/
│   ├── ag-delegate.md              # /ag-delegate 수동 위임 슬래시 커맨드
│   ├── ag-config.md                # /ag-config 실행 모드 및 모델 설정 커맨드
│   └── ag-status.md                # /ag-status 현재 연결 상태 진단 커맨드
├── templates/
│   └── claude-handoff.md           # 대상 프로젝트의 .agent/workflows/에 복사될 템플릿
├── server/                         # MCP 서버 및 브릿지 엔진 (TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                # MCP Server 엔트리포인트 및 Tool 핸들러
│       ├── cli-init.ts             # SessionStart 훅에서 호출되는 프로젝트 초기화 스크립트
│       ├── types.ts                # 공통 인터페이스 및 상태 머신 타입 정의
│       ├── detector.ts             # OS별 Antigravity 설치/구독 감지 및 API Key 판별기
│       ├── git-guard.ts            # 작업 전후 Git 체크포인트 및 롤백 유틸리티
│       ├── bridge-fs.ts            # .ag-bridge/ 파일(manifest, dispatch, report) 관리
│       └── engines/
│           ├── subscription.ts     # 구독자용 로컬 Antigravity 트리거 및 상태 폴링 엔진
│           └── api-worker.ts       # 비구독자용 Gemini API 에이전트 루프 엔진
└── README.md                       # 설치 및 사용 가이드
```

---

## 4. Detailed Module Specifications

### 4.1 Claude Plugin Manifests (Root Level)

#### A. `.claude-plugin/plugin.json`
```json
{
  "name": "antigravity-delegate",
  "version": "1.0.0",
  "description": "Delegate UI implementation, multi-file frontend tasks, and browser E2E verification from Claude Code to Antigravity (Subscription App or Gemini API).",
  "author": "xzawed",
  "keywords": ["antigravity", "gemini", "delegate", "multi-agent", "mcp"]
}
```

#### B. `.mcp.json`
```json
{
  "mcpServers": {
    "antigravity-delegate": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"],
      "env": {
        "AG_DEFAULT_MODE": "auto"
      }
    }
  }
}
```

#### C. `hooks/hooks.json`
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/server/dist/cli-init.js --silent"
          }
        ]
      }
    ]
  }
}
```

---

### 4.2 Bridge Protocol & State Machine (`server/src/types.ts` & `bridge-fs.ts`)

대상 워크스페이스 루트에 `.ag-bridge/` 디렉터리를 생성(자동으로 `.gitignore`에 추가)하여 두 에이전트 간 단일 진실 공급원(SSOT)으로 사용한다.

#### State Machine (`manifest.json`)
```typescript
export type ExecutionMode = 'auto' | 'subscription' | 'api';
export type TaskStatus = 'IDLE' | 'DISPATCHED' | 'RUNNING' | 'VERIFIED' | 'FAILED';

export interface BridgeManifest {
  taskId: string;
  title: string;
  mode: 'subscription' | 'api';
  status: TaskStatus;
  lockedPaths: string[];       // Antigravity가 수정 가능한 허용 파일/디렉터리 경로 목록
  verifyUrl?: string;          // 브라우저 검증 대상 로컬 서버 URL (예: http://localhost:3000)
  createdAt: string;
  updatedAt: string;
  gitCheckpointRef?: string;   // 롤백용 커밋 해시 또는 stash ref
  artifacts: string[];         // 캡처된 스크린샷 및 로그 상대 경로
  error?: string;
}
```

#### Configuration File (`.ag-bridge/config.json`)
```json
{
  "execution_mode": "auto",
  "subscription": {
    "app_path": "auto",
    "trigger_method": "cli_or_ipc",
    "timeout_sec": 300
  },
  "api": {
    "api_key_env": "GEMINI_API_KEY",
    "model": "gemini-2.5-pro",
    "max_turns": 15
  }
}
```

---

### 4.3 Environment Detector (`server/src/detector.ts`)

`execution_mode === 'auto'`일 때 다음 우선순위로 실행 엔진을 결정한다.

1. **Subscription Check (`detectSubscriptionApp`):**
   - **macOS:** `/Applications/Antigravity.app` 또는 `~/Applications/Antigravity.app` 존재 여부, 혹은 CLI 바이너리(`which antigravity` / `which ag`) 확인.
   - **Windows:** `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe` 또는 `where antigravity` 확인.
   - **Linux:** `/usr/bin/antigravity`, `~/.local/bin/antigravity` 또는 `which antigravity` 확인.
   - 앱/CLI가 존재하면 `'subscription'` 반환.
2. **API Fallback Check (`detectApiKey`):**
   - `process.env.GEMINI_API_KEY` 또는 `.ag-bridge/config.json`의 `api.apiKey` 존재 여부 확인.
   - 존재하면 `'api'` 반환.
3. **Unavailable:**
   - 둘 다 없을 경우 명확한 가이드 에러(`NO_ANTIGRAVITY_PROVIDER`)를 반환하여 클로드가 사용자에게 구독 앱 실행 또는 `GEMINI_API_KEY` 설정을 안내하도록 한다.

---

### 4.4 Dual Execution Engines (`server/src/engines/`)

#### Engine A: `subscription.ts` (구독자 모드)
1. 대상 프로젝트의 `.agent/workflows/claude-handoff.md` 파일이 최신 템플릿인지 확인 후 동기화한다.
2. `.ag-bridge/dispatch.md`에 목표, `lockedPaths`, 컨텍스트(타입/API 스펙), `verifyUrl`, 완료 조건을 기록한다.
3. 로컬 Antigravity CLI/IPC를 통해 현재 워크스페이스 세션에 `/claude-handoff` 명령을 트리거한다.
   - *CLI 지원 시:* `antigravity run --workflow claude-handoff` (또는 CLI 인자 규격에 맞춘 비동기 실행)
   - *GUI IPC 폴백:* OS별 자동화(macOS AppleScript / Windows PowerShell)로 Antigravity 창 포커스 및 프롬프트 주입, 또는 클립보드 복사 후 데스크톱 알림 발송.
4. `fs.watch` 및 폴링(2초 간격, 기본 타임아웃 300초)으로 `.ag-bridge/manifest.json`의 `status`가 `'VERIFIED'` 또는 `'FAILED'`로 변경될 때까지 대기한다.
5. 완료되면 `.ag-bridge/report.md`와 `artifacts/` 목록을 읽어 MCP 응답으로 반환한다.

#### Engine B: `api-worker.ts` (비구독자 API 모드)
`claude-grok-build-plugin`과 동일한 패턴으로 동작하는 경량 자율 에이전트 루프를 구현한다.
1. `@google/genai` SDK를 사용하여 설정된 모델(기본값: `gemini-2.5-pro`)을 초기화한다.
2. 에이전트에게 다음 4가지 Function Calling Tool을 바인딩한다:
   - `read_file(path)`: 워크스페이스 내 파일 읽기
   - `write_file(path, content)`: `lockedPaths` 범위 내 파일 생성/수정 (범위 외 쓰기 차단)
   - `list_dir(path)`: 디렉터리 구조 조회
   - `run_command(command)`: 빌드/타입체크(`npm run build`, `npx tsc --noEmit`) 실행용 제한된 셸 도구
3. 최대 `max_turns`(기본 15턴) 동안 자율 루프를 실행하며 코드를 작성하고 빌드 통과 여부를 스스로 검증한다.
4. 루프 종료 시 `.ag-bridge/report.md`를 생성하고 `manifest.json`을 `'VERIFIED'`로 업데이트한 뒤 반환한다.

---

### 4.5 MCP Server Tools (`server/src/index.ts`)

`@modelcontextprotocol/sdk`를 사용하여 Stdio 트랜스포트 기반 MCP 서버를 구현하며, 아래 3개의 Tool을 노출한다.

| Tool Name | Input Schema | Description |
| :--- | :--- | :--- |
| `delegate_to_antigravity` | `{ title: string, instructions: string, lockedPaths: string[], verifyUrl?: string, acceptanceCriteria: string[] }` | Git 체크포인트를 생성하고, 감지된 모드(구독/API)로 Antigravity에 작업을 위임한 뒤 완료 보고서를 반환한다. |
| `check_ag_environment` | `{}` | 현재 감지된 실행 모드(`subscription` / `api`), Antigravity 설치 경로, API 키 설정 여부, 활성 작업 상태를 반환한다. |
| `rollback_ag_task` | `{ taskId?: string }` | 위임된 작업 결과가 만족스럽지 않을 때 `gitCheckpointRef`를 이용해 작업 전 상태로 즉시 복구한다. |

---

### 4.6 Prompts & Workflows

#### A. `skills/ag-delegate/SKILL.md`
- **역할:** Claude Code가 매 턴마다 위임 여부를 판단하는 시스템 스킬.
- **위임 트리거:**
  1. React/Next.js/Vue 등 프론트엔드 UI 컴포넌트 및 스타일링 구현
  2. 로컬 서버를 띄워 실제 브라우저 렌더링, 콘솔 에러, 인터랙션(클릭/폼 입력)을 검증해야 하는 작업
  3. 백엔드 API 스펙이 확정된 후 다수의 프론트엔드 페이지/상태 코드를 병렬 생성하는 작업
- **모드별 완료 조건 분기 지시:**
  - `subscription` 모드 활성 시: 반드시 `verifyUrl`을 전달하여 Antigravity의 내장 브라우저로 렌더링 및 콘솔 에러를 검증하고 스크린샷을 `.ag-bridge/artifacts/`에 남기도록 지시.
  - `api` 모드 활성 시: `npm run build` 또는 `tsc --noEmit` 통과를 필수 완료 조건으로 지시.

#### B. `commands/ag-delegate.md`, `commands/ag-config.md`, `commands/ag-status.md`
- `/ag-delegate`: 사용자가 명시적으로 프론트엔드/UI 작업을 Antigravity에 위임할 때 사용하는 슬래시 커맨드.
- `/ag-config`: `mode auto | subscription | api` 및 `model <model-name>` 설정을 `.ag-bridge/config.json`에 반영하는 커맨드.
- `/ag-status`: `check_ag_environment` 도구를 호출하여 현재 연결 상태, 구독 감지 여부, API 키 상태를 표로 출력하는 커맨드.

#### C. `templates/claude-handoff.md` (Antigravity 측 워크플로우)
프로젝트의 `.agent/workflows/claude-handoff.md`에 배포되는 지침서:
1. `.ag-bridge/manifest.json`의 `status`를 `"RUNNING"`으로 변경한다.
2. `.ag-bridge/dispatch.md`의 요구사항과 `lockedPaths` 제약을 읽는다.
3. 필요시 `implementation_plan.md`를 생성하고 코드를 구현한다.
4. `verifyUrl`이 명시된 경우 내장 브라우저 서브에이전트를 실행해 UI 렌더링, 사용자 시나리오, 콘솔/네트워크 에러를 검증하고 스크린샷을 `.ag-bridge/artifacts/`에 저장한다.
5. 변경 파일 목록, 검증 결과, 스크린샷 경로, 후속 백엔드 연동 사항을 `.ag-bridge/report.md`에 작성하고 `manifest.json`의 `status`를 `"VERIFIED"`로 변경한다.

---

## 5. Implementation Milestones (Antigravity Execution Plan)

Antigravity는 이 문서를 인계받은 후 다음 단계 순서대로 구현 및 검증을 진행해야 한다.

- **Phase 1: Project Scaffolding & Manifests**
  - `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `server/package.json`, `server/tsconfig.json` 생성.
  - `skills/ag-delegate/SKILL.md`, `commands/*.md`, `templates/claude-handoff.md` 작성.
- **Phase 2: Core Bridge & Environment Detector**
  - `types.ts`, `detector.ts`, `git-guard.ts`, `bridge-fs.ts`, `cli-init.ts` 구현.
  - `lockedPaths` 보안 검증(Path Traversal 방지) 및 `.gitignore` 자동 등록 로직 포함.
- **Phase 3: Dual Execution Engines**
  - `engines/subscription.ts` (로컬 Antigravity CLI/OS 트리거 + `fs.watch` 상태 감시) 구현.
  - `engines/api-worker.ts` (`@google/genai` 기반 Tool-calling 에이전트 루프) 구현.
- **Phase 4: MCP Server & Verification**
  - `server/src/index.ts`에 3개 MCP Tool 연결 및 `npm run build` 실행.
  - 단위 테스트 및 Mock MCP 호출 테스트로 `subscription` 모드와 `api` 모드 양쪽의 `dispatch.md` -> `report.md` 파이프라인 정상 동작 검증.

---

## 6. Antigravity CLI Quick-Start Prompt

본 `SPEC.md` 파일을 프로젝트 루트에 배치한 후, 아래 명령어로 Antigravity에 전체 구현을 지시할 수 있습니다.

```bash
antigravity "SPEC.md를 읽고 Phase 1부터 Phase 4까지 전체 플러그인 코드를 구현한 뒤, TypeScript 빌드 및 MCP 서버 구동 테스트까지 완료해 줘."
```