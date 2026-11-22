# MCP Tools & 인터페이스 상세 명세서 (MCP Tools API)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `SPC-001` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **관련 문서** | [브릿지 프로토콜](../02-architecture/bridge-protocol.md), [듀얼 엔진 명세](./execution-engines.md), [PRD](../01-planning/PRD.md) |

---

## 1. MCP 서버 기본 규격 (`server/src/index.ts`)

- **서버 이름:** `antigravity-delegate`
- **버전:** `1.0.0`
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

## 2. 노출 MCP Tools 명세 (3종)

### 2.1 Tool 1: `delegate_to_antigravity`
Git 체크포인트를 생성하고, `.ag-bridge/`에 작업을 디스패치한 뒤 감지된 엔진(`subscription` 또는 `api`)으로 Antigravity에 작업을 위임하고 완료 보고서를 반환한다.

#### Input Schema (Zod / JSON Schema)
| 필드 | 타입 | 필수 | 설명 및 제약 |
| :--- | :--- | :---: | :--- |
| `title` | `string` | Y | 3~120자 작업 제목 |
| `instructions` | `string` | Y | 상세 구현 지시사항, 타입/API 스펙, 디자인 요구사항 (최소 10자) |
| `lockedPaths` | `string[]` | Y | 수정 허용 파일/디렉터리 상대 경로 목록 (최소 1개, Path Traversal 불가) |
| `verifyUrl` | `string` | N | 브라우저 시각적 검증 대상 로컬 URL (`http://localhost:*` 또는 `http://127.0.0.1:*` 권장) |
| `acceptanceCriteria` | `string[]` | Y | 완료 판정 체크리스트 (최소 1개) |
| `modeOverride` | `'auto' \| 'subscription' \| 'api'` | N | 이번 호출에 한해 설정 파일의 `execution_mode`를 일시 오버라이드 |
| `workspaceRoot` | `string` | N | 대상 프로젝트 루트 경로 (기본값: `process.cwd()`) |

#### Output Payload (JSON text content)
```typescript
export interface DelegateToolOutput {
  ok: boolean;
  taskId: string;
  mode: 'subscription' | 'api';
  status: 'VERIFIED' | 'FAILED';
  gitCheckpointRef?: string;
  changedFiles: string[];
  artifacts: string[];         // .ag-bridge/artifacts/<taskId>/...
  reportMarkdown: string;      // .ag-bridge/report.md 원문
  warnings: string[];          // 예: non-git 경고, IPC 폴백 안내 등
  errorCode?: AgErrorCode;
  errorMessage?: string;
}
```

---

### 2.2 Tool 2: `check_ag_environment`
현재 워크스페이스와 로컬 머신의 Antigravity 실행 가능 환경, 감지된 모드, API 키 설정 여부, 활성 작업 상태를 진단한다.

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
| `taskId` | `string` | N | 롤백할 작업 ID. 생략 시 현재 `.ag-bridge/manifest.json`의 최근 작업 대상 |
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

## 3. 표준 에러 코드 카탈로그 (`AgErrorCode`)

모든 에러 응답은 MCP `isError: true` 또는 구조화된 `{ ok: false, errorCode, errorMessage }`를 일관되게 반환한다.

| 에러 코드 | 발생 위치 | 원인 | 권장 복구 조치 |
| :--- | :--- | :--- | :--- |
| `NO_ANTIGRAVITY_PROVIDER` | `detector.ts` | 구독 앱/CLI 및 `GEMINI_API_KEY` 모두 미감지 | Antigravity 설치·로그인 또는 `GEMINI_API_KEY` 설정 안내 |
| `SUBSCRIPTION_UNAVAILABLE` | `detector.ts` | `mode: subscription` 강제 지정했으나 로컬 앱/CLI 없음 | Antigravity 설치 또는 `/ag-config mode api` 전환 |
| `API_KEY_MISSING` | `detector.ts` | `mode: api` 강제 지정했으나 API 키 없음 | `GEMINI_API_KEY` 환경변수 설정 |
| `BRIDGE_BUSY` | `bridge-fs.ts` | 다른 위임 작업이 `DISPATCHED`/`RUNNING` 중 | 진행 중 작업 완료 대기 또는 수동 취소 |
| `INVALID_LOCKED_PATHS` | `path-guard.ts` | `lockedPaths`가 비어 있거나 워크스페이스 외부/금지 경로 지정 | 허용된 상대 경로로 재지정 |
| `PATH_OUTSIDE_LOCKED_SCOPE` | `path-guard.ts` | 에이전트가 `lockedPaths` 외부 경로 쓰기 시도 | 쓰기 차단(API 루프 내 재시도 유도) |
| `COMMAND_NOT_ALLOWED` | `api-worker.ts` | 금지된 셸 명령 또는 셸 메타문자 사용 시도 | 허용된 빌드/타입체크 명령만 실행 |
| `GIT_CHECKPOINT_FAILED` | `git-guard.ts` | Git 체크포인트 생성 중 오류 발생 | `git status` 점검 후 재시도 |
| `ROLLBACK_NO_CHECKPOINT` | `git-guard.ts` | 해당 `taskId`에 유효한 `gitCheckpointRef` 없음 | `git status` / `git diff`로 수동 복구 |
| `TASK_TIMEOUT` | `subscription.ts` | `timeout_sec` 내에 `VERIFIED`/`FAILED` 전이 미발생 | Antigravity 상태 확인 또는 `rollback_ag_task` |
| `MAX_TURNS_EXCEEDED` | `api-worker.ts` | `api.max_turns` 내에 완료 불가 | 범위 축소 재위임 또는 `max_turns` 상향 |
| `GEMINI_API_ERROR` | `api-worker.ts` | Gemini API 호출 실패 (401/403/429/5xx) | 키·모델명·네트워크 점검 후 재시도 |
| `INVALID_CONFIG` | `config.ts` | `.ag-bridge/config.json` JSON 파싱 또는 스키마 오류 | `/ag-config`로 유효한 설정 복구 |

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
