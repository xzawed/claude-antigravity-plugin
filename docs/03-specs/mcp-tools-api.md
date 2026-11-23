# MCP Tools & 인터페이스 상세 명세서 (MCP Tools API)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `SPC-001` |
| **버전** | `1.3.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-23` |
| **관련 문서** | [브릿지 프로토콜](../02-architecture/bridge-protocol.md), [듀얼 엔진 명세](./execution-engines.md), [PRD](../01-planning/PRD.md) |

---

## 1. MCP 서버 기본 규격 (`server/src/index.ts`)

- **서버 이름:** `antigravity-delegate`
- **버전:** `1.3.0`
- **트랜스포트:** `StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`)
- **로깅 규칙:** 모든 내부 진단 로그는 `console.error(...)` (`stderr`)로만 출력. `stdout`은 MCP JSON-RPC 프레임 전용.
- **작업 디렉터리 해석:** 도구 입력에 `workspaceRoot`가 생략되면 `process.cwd()`를 사용한다.

### 1.1 `.mcp.json` 등록 정의
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

---

## 2. 노출 MCP Tools 명세 (9종)

### 2.1 Tool 1: `delegate_to_antigravity`
Git 체크포인트를 생성하고, `.ag-bridge/`에 작업을 디스패치한 뒤 감지된 엔진(`subscription` 또는 `api`)으로 Antigravity에 작업을 위임하고 완료 보고서 및 토큰 사용량/실행 메트릭을 반환한다. `agy` CLI가 제공하는 모든 주요 플래그(모델, 추론 강도, 에이전트, 대화 이어가기, `--dangerously-skip-permissions`, 추가 디렉터리, 프로젝트/원격 에이전트, JSON 스키마 등)를 1:1 지원한다.

#### Input Schema (Zod / JSON Schema)
| 필드 | 타입 | 필수 | 설명 및 제약 |
| :--- | :--- | :---: | :--- |
| `title` | `string` | Y | 3~120자 작업 제목 |
| `instructions` | `string` | Y | 상세 작업 지시사항, 타입/API 스펙, 디자인 요구사항 (최소 5자) |
| `lockedPaths` | `string[]` | N | 수정 허용 파일/디렉터리 상대 경로 목록 (Path Traversal 불가). **API 모드에서는 필수**, Subscription 모드에서는 생략 시 일반 `agy` 작업(질의·분석·자유 편집)으로 실행 |
| `verifyUrl` | `string` | N | 브라우저 시각적 검증 대상 로컬 URL (`http://localhost:*` 또는 `http://127.0.0.1:*` 권장) |
| `acceptanceCriteria` | `string[]` | N | 완료 판정 체크리스트 (생략 시 기본 완료 조건 자동 적용) |
| `modeOverride` | `'auto' \| 'subscription' \| 'api'` | N | 이번 호출에 한해 설정 파일의 `execution_mode`를 일시 오버라이드 |
| `timeoutSec` | `number` | N | 이번 호출의 타임아웃(초, `5`~`3600`). `agy --print-timeout <N>s`와 브릿지 감시 타임아웃에 동시 적용 |
| `model` | `string` | N | 사용할 모델 ID (`agy --model <id>` 또는 API 모드 `model` 오버라이드, 예: `gemini-4-neon-high`, `claude-opus-5-5-high`) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | N | 추론 강도 (`agy --effort <level>`) |
| `agent` | `string` | N | 사용할 커스텀 에이전트 이름 (`agy --agent <name>`) |
| `agyMode` | `'accept-edits' \| 'auto' \| 'plan'` | N | 권한 모드 (`agy --mode <mode>`) |
| `sandbox` | `boolean` | N | 샌드박스 활성화 여부 (`agy --sandbox` / `--no-sandbox`) |
| `dangerouslySkipPermissions` | `boolean` | N | `true`일 때 `agy --dangerously-skip-permissions` 전달 (모든 권한 확인 생략 → `permission_mode: "always-proceed"`). 명시적 `agyMode`를 함께 넘기지 않으면 기본 `--mode`를 생략해 `always-proceed` 동작을 보존 |
| `addDirs` | `string[]` | N | 추가 허용 디렉터리 목록 (각 항목마다 `agy --add-dir <dir>` 반복 전달) |
| `continueConversation` | `boolean` | N | 직전 대화 이어가기 (`agy --continue`) |
| `conversationId` | `string` | N | 특정 대화 ID 재개 (`agy --conversation <id>`) |
| `project` | `string` | N | 대상 프로젝트 지정 (`agy --project <name>`) |
| `newProject` | `boolean` | N | 새 프로젝트 생성 (`agy --new-project`) |
| `remoteAgent` | `boolean` | N | 원격 에이전트 모드 (`agy --remote-agent`) |
| `jsonSchema` | `string` | N | 구조화된 JSON 출력 스키마 (`agy --json-schema <schema>`) |
| `disableSlashCommands` | `boolean` | N | 슬래시 커맨드 비활성화 (`agy --disable-slash-commands`) |
| `settings` | `string` | N | 추가 설정 파일 경로 또는 JSON (`agy --settings <val>`) |
| `rawPrompt` | `boolean` | N | `true`일 때 `instructions`를 `/claude-handoff` 래핑 없이 `agy --print`에 원문 그대로 전달 (`/boost`, `/browser`, `/swarm`, `/goal` 등 네이티브 커맨드는 자동 감지) |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |

#### Output Payload (JSON text content)
```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface ExecutionMetrics {
  model?: string;
  conversationId?: string;
  durationSeconds?: number;
  numTurns?: number;
  permissionMode?: string;     // 예: "always-proceed" | "request-review"
  usage?: TokenUsage;
}

export interface DelegateToolOutput {
  ok: boolean;
  taskId: string;
  mode: 'subscription' | 'api';
  status: 'VERIFIED' | 'FAILED';
  gitCheckpointRef?: string;
  changedFiles: string[];
  artifacts: string[];         // .ag-bridge/artifacts/<taskId>/...
  reportMarkdown: string;      // .ag-bridge/report.md 원문
  structuredOutput?: unknown;  // --json-schema 지정 시 result.structured_output 파싱 객체
  metrics?: ExecutionMetrics;  // 토큰 사용량, 대화 ID, 소요 시간, 권한 모드
  warnings: string[];          // 예: non-git 경고, skip-permissions 경고, IPC 폴백 안내 등
  errorCode?: AgErrorCode;
  errorMessage?: string;
}
```

---

### 2.2 Tool 2: `check_ag_environment`
현재 워크스페이스와 로컬 머신의 Antigravity 실행 가능 환경, 감지된 모드, `agy` CLI 기본 권한/모델 설정, API 키 설정 여부, 활성 작업 및 최근 토큰 사용량 상태를 진단한다.

#### Input Schema
| 필드 | 타입 | 필수 | 설명 |
| :--- | :--- | :---: | :--- |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |

#### Output Payload
```typescript
export interface CheckEnvironmentOutput {
  configuredMode: 'auto' | 'subscription' | 'api';
  resolvedMode: 'subscription' | 'api' | 'unavailable';
  platform: NodeJS.Platform;
  subscription: {
    detected: boolean;
    cliBinary?: string;        // 예: "agy" | "antigravity" | "ag"
    cliPath?: string;          // 절대 실행 경로
    appPath?: string;          // 데스크톱 앱 설치 경로
    triggerMethod: string;
  };
  agyConfig: {
    mode: 'accept-edits' | 'auto' | 'plan';
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    streamHeartbeat: boolean;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    agent?: string;
  };
  api: {
    configured: boolean;       // 키 원문 절대 미노출
    source: 'env' | 'config' | 'none';
    envVarName: string;        // 기본 "GEMINI_API_KEY"
    model: string;             // 기본 "gemini-2.5-pro"
    maxTurns: number;
  };
  git: {
    isGitRepo: boolean;
    currentBranch?: string;
    isDirty?: boolean;
  };
  bridge: {
    initialized: boolean;
    gitignoreProtected: boolean;
    currentStatus: TaskStatus;
    lastTaskId?: string;
    lastUpdatedAt?: string;
    lastConversationId?: string;
    lastUsage?: TokenUsage;
  };
  recommendations: string[];   // 미설정 시 조치 안내 메시지
}
```

---

### 2.3 Tool 3: `rollback_ag_task`
위임된 작업 결과가 불만족스럽거나 실패했을 때 `gitCheckpointRef`를 사용하여 작업 직전 상태로 즉시 복구한다.

#### Input Schema
| 필드 | 타입 | 필수 | 설명 |
| :--- | :--- | :---: | :--- |
| `taskId` | `string` | N | 롤백할 작업 ID. 생략 시 현재 `.ag-bridge/manifest.json`의 최근 작업 대상 (`history/` 아카이브 조회 지원) |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |

#### Output Payload
```typescript
export interface RollbackToolOutput {
  ok: boolean;
  taskId: string;
  restoredCheckpointRef?: string;
  revertedTrackedFiles: string[];
  removedUntrackedFiles: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}
```

---

### 2.4 Tool 4: `list_ag_capabilities`
로컬 `agy` CLI에서 실시간으로 사용 가능한 모델 목록(`agy models`)과 에이전트 목록(`agy agents`)을 병렬 조회하고, 지원되는 권한 모드(`--dangerously-skip-permissions` 포함), 추론 강도(`effort`), 전체 CLI 플래그 및 현재 워크스페이스 기본값을 반환한다.

#### Input Schema
| 필드 | 타입 | 필수 | 설명 |
| :--- | :--- | :---: | :--- |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |

#### Output Payload
```typescript
export interface ListCapabilitiesOutput {
  subscriptionDetected: boolean;
  cliBinary?: string;
  cliPath?: string;
  models: Array<{ id: string; label: string }>;
  agents: string[];
  supportedPermissionModes: string[];
  supportedEffortLevels: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  supportedFlags: string[];
  currentDefaults: {
    agyMode: 'accept-edits' | 'auto' | 'plan';
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    streamHeartbeat: boolean;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    agent?: string;
  };
  warnings: string[];
}
```

---

### 2.5 Tool 5: `get_ag_usage`
현재 `.ag-bridge/manifest.json`과 `.ag-bridge/history/*.json` 아카이브 전체를 집계하여 누적 토큰 사용량(input/output/thinking/cacheRead/total), 실행 모드별(`subscription` vs `api`) 통계, 총 실행 시간 및 최근 작업별 상세 내역(`conversationId`, `permissionMode`, `model`, `usage`)을 반환한다.

#### Input Schema
| 필드 | 타입 | 필수 | 설명 |
| :--- | :--- | :---: | :--- |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |
| `limit` | `number` | N | 최근 작업 목록 최대 개수 (기본값 `20`, `1`~`100`) |

#### Output Payload
```typescript
export interface TaskUsageRecord {
  taskId: string;
  title: string;
  mode: 'subscription' | 'api';
  status: TaskStatus;
  model?: string;
  conversationId?: string;
  permissionMode?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: TokenUsage;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummaryOutput {
  workspaceRoot: string;
  totalTasks: number;
  tasksWithUsage: number;
  totalDurationSeconds: number;
  totals: TokenUsage;
  byMode: {
    subscription: { tasks: number; usage: TokenUsage };
    api: { tasks: number; usage: TokenUsage };
  };
  recentTasks: TaskUsageRecord[];
}
```

---

### 2.6 Tool 6: `ag_auth`
Claude Code에서 직접 Antigravity CLI(`agy acp --login`)의 Google OAuth 로그인을 수행하거나, 실시간 인증 상태를 점검하고, SSH/헤드리스 환경용 링크+인가 코드 붙여넣기 로그인을 완료/취소하며, 안전한 로그아웃 절차를 안내한다.

#### Input Schema
| 필드 | 타입 | 필수 | 설명 |
| :--- | :--- | :---: | :--- |
| `action` | `'status' \| 'login' \| 'complete' \| 'cancel' \| 'logout'` | N | 수행 동작 (기본값 `'login'`) |
| `flow` | `'auto' \| 'browser' \| 'manual'` | N | 로그인 방식 (`auto`: 로컬은 브라우저 OAuth, SSH/헤드리스는 링크+코드 모드 자동 선택) |
| `force` | `boolean` | N | 이미 로그인되어 있어도 강제 재인증 / 계정 전환 수행 |
| `code` | `string` | N | `action='complete'` 시 사용자가 브라우저에서 복사한 인가 코드 또는 콜백 URL (로그에 절대 미기록) |
| `sessionId` | `string` | N | `action='complete'` 또는 `'cancel'` 대상 대기 세션 ID (생략 시 가장 최근 활성 세션) |
| `timeoutSec` | `number` | N | 브라우저 OAuth 대기 제한 시간(초, `15`~`600`, 기본값 `180`) |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |

#### Output Payload
```typescript
export interface AgAuthToolOutput {
  ok: boolean;
  action: 'status' | 'login' | 'complete' | 'cancel' | 'logout';
  status:
    | 'AUTHENTICATED'
    | 'UNAUTHENTICATED'
    | 'AWAITING_CODE'
    | 'CANCELLED'
    | 'CLI_NOT_INSTALLED'
    | 'LOGOUT_INSTRUCTIONS'
    | 'FAILED';
  authenticated: boolean;
  authMethod: 'google-oauth' | 'gemini-api-key' | 'adc' | 'none' | 'unknown';
  cliDetected: boolean;
  cliBinary?: string;
  cliPath?: string;
  modelCount?: number;
  sessionId?: string;
  authUrl?: string;
  message: string;
  nextSteps: string[];
  warnings: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}
```

---

### 2.7 Tool 7: `start_ag_task` (비동기 백그라운드 위임)
`delegate_to_antigravity`와 동일한 전체 입력 스키마를 받되, Git 체크포인트 생성 및 엔진 기동 직후 즉시 `{ ok: true, jobId, taskId, mode, status: 'RUNNING', gitCheckpointRef }`를 반환하여 Claude Code가 다른 작업을 병렬 수행할 수 있게 한다.

### 2.8 Tool 8: `get_ag_job` (백그라운드 작업 조회·수집)
- `jobId` 지정 시: 해당 작업의 실시간/완료 상태(`RUNNING | VERIFIED | FAILED | CANCELLED`), 경과 시간, `model`, `conversationId`, `metrics`, `changedFiles`, `artifacts`, `reportMarkdown`, `structuredOutput`, 마스킹된 `logTail` 반환(디스크 아카이브 폴백 지원).
- `jobId` 생략 시: 활성 및 최근 작업 요약 목록(`jobs[]`, `activeCount`) 반환.

### 2.9 Tool 9: `cancel_ag_job` (백그라운드 작업 중단)
실행 중인 백그라운드 작업(`jobId` 또는 최신 활성 작업)에 `AbortSignal`을 전달해 자식 프로세스 트리를 종료하고 `.ag-bridge/manifest.json`을 `FAILED(TASK_CANCELLED)`로 갱신하며, 선택적 롤백용 `gitCheckpointRef`를 반환한다.

---

## 3. 표준 에러 코드 카탈로그 (`AgErrorCode`)

모든 에러 응답은 MCP `isError: true` 또는 구조화된 `{ ok: false, errorCode, errorMessage }`를 일관되게 반환한다.

| 에러 코드 | 발생 위치 | 원인 | 권장 복구 조치 |
| :--- | :--- | :--- | :--- |
| `NO_ANTIGRAVITY_PROVIDER` | `detector.ts` | 구독 앱/CLI 및 `GEMINI_API_KEY` 모두 미감지 | Antigravity 설치·로그인 또는 `GEMINI_API_KEY` 설정 안내 |
| `SUBSCRIPTION_UNAVAILABLE` | `detector.ts` | `mode: subscription` 강제 지정했으나 로컬 앱/CLI 없음 | Antigravity 설치 또는 `/ag-config mode api` 전환 |
| `API_KEY_MISSING` | `detector.ts` | `mode: api` 강제 지정했으나 API 키 없음 | `GEMINI_API_KEY` 환경변수 설정 |
| `BRIDGE_BUSY` | `bridge-fs.ts` | 다른 위임 작업이 `DISPATCHED`/`RUNNING` 중 | 진행 중 작업 완료 대기 또는 수동 취소 |
| `INVALID_LOCKED_PATHS` | `path-guard.ts` | API 모드에서 `lockedPaths`가 비어 있거나 워크스페이스 외부 지정 | 허용된 상대 경로로 재지정 |
| `PROTECTED_PATH_BLOCKED` | `path-guard.ts` | `.git/`, `.env*`, `.ag-bridge/config.json` 등 보호 경로 지정 | 보호 경로 제외 후 재시도 |
| `PATH_OUTSIDE_LOCKED_SCOPE` | `path-guard.ts` | 에이전트가 `lockedPaths` 외부 경로 쓰기 시도 | 쓰기 차단(API 루프 내 재시도 유도) |
| `COMMAND_NOT_ALLOWED` | `api-worker.ts` | 금지된 셸 명령 또는 셸 메타문자 사용 시도 | 허용된 빌드/타입체크 명령만 실행 |
| `GIT_CHECKPOINT_FAILED` | `git-guard.ts` | Git 체크포인트 생성 중 오류 발생 | `git status` 점검 후 재시도 |
| `ROLLBACK_NO_CHECKPOINT` | `git-guard.ts` | 해당 `taskId`에 유효한 `gitCheckpointRef` 없음 | `git status` / `git diff`로 수동 복구 |
| `TASK_TIMEOUT` | `subscription.ts` | `timeout_sec` 내에 `VERIFIED`/`FAILED` 전이 미발생 | Antigravity 상태 확인 또는 `rollback_ag_task` |
| `MAX_TURNS_EXCEEDED` | `api-worker.ts` | `api.max_turns` 내에 완료 불가 | 범위 축소 재위임 또는 `max_turns` 상향 |
| `GEMINI_API_ERROR` | `api-worker.ts` | Gemini API 호출 실패 (401/403/429/5xx) | 키·모델명·네트워크 점검 후 재시도 |
| `INVALID_CONFIG` | `config.ts` | `.ag-bridge/config.json` JSON 파싱 또는 스키마 오류 | `/ag-config`로 유효한 설정 복구 |
| `AGY_CLI_NOT_FOUND` | `auth.ts` | 로컬에 `agy` CLI 미설치 | Antigravity CLI 설치 또는 `GEMINI_API_KEY` API 모드 사용 |
| `AUTH_LOGIN_FAILED` | `auth.ts` | `agy acp --login` 실행 또는 인가 코드 교환 실패 | `/ag-login --manual` 재시도 또는 터미널에서 `agy acp --login` 확인 |
| `AUTH_SESSION_NOT_FOUND` | `auth.ts` | 대기 중인 수동 OAuth 세션이 없거나 만료(5분) | `/ag-login --manual`로 새 세션 시작 |
| `AUTH_TIMEOUT` | `auth.ts` | 브라우저 OAuth 또는 코드 교환 타임아웃 초과 | `/ag-login --manual` 사용 권장 |

---

## 4. `cli-init.ts` CLI 인터페이스

`hooks/hooks.json`의 `SessionStart` 훅에서 호출되는 독립 초기화 스크립트 규격:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli-init.js" [--silent] [--workspace <path>] [--force-template]
```

| 플래그 | 기본값 | 동작 |
| :--- | :---: | :--- |
| `--silent` | `false` | 정상·경고 출력을 억제하고 항상 종료 코드 `0` 반환(Claude Code 세션 시작 비차단) |
| `--workspace <path>` | `process.cwd()` | 초기화 대상 워크스페이스 경로 지정 |
| `--force-template` | `false` | 대상 프로젝트의 `claude-handoff.md`를 플러그인 최신 템플릿으로 강제 덮어쓰기 |
