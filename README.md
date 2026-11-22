# `claude-antigravity-plugin`

> **Claude Code(메인 오케스트레이터)**와 **Antigravity(UI 구현·다중 파일 리팩토링·브라우저 E2E 검증 에이전트)**를 내장 MCP 서버와 `.ag-bridge/` 프로토콜로 연결하는 듀얼 모드 협업 플러그인입니다.

## 프로젝트 상태

- **현재 버전:** `v1.0.0` (Phase 1 ~ Phase 4 구현 완료)
- **런타임 타깃:** Node.js `>= 20.x`, TypeScript `>= 5.x`, Claude Code Plugin System (`.claude-plugin`, `.mcp.json`, `hooks`, `skills`, `commands`)

## 핵심 특징

1. **Dual Execution Mode (`auto` / `subscription` / `api`)**
   - **Subscription Mode:** 로컬에 설치된 Antigravity 앱/CLI(`agy`, `antigravity`, `ag`)의 구독 쿼터를 사용하여 추가 API 과금 없이 실행하고 내장 Browser Subagent로 시각적 검증 및 스크린샷 수집을 수행합니다.
   - **API Fallback Mode:** Antigravity 미설치 또는 헤드리스 환경에서 `GEMINI_API_KEY`와 `@google/genai` 기반 경량 Tool-calling 에이전트 루프로 구현 및 빌드/타입 검증을 수행합니다.
2. **파일 기반 단일 진실 공급원 (`.ag-bridge/` SSOT)**
   - `manifest.json`, `dispatch.md`, `report.md`, `artifacts/`, `history/`를 원자적 I/O(`.tmp` → `rename`)로 관리하며 `.gitignore`에 자동 등록합니다.
3. **Git Guard & `lockedPaths` 보안 격리**
   - 위임 직전 `git stash create` + `refs/ag-bridge/checkpoints/<taskId>` 스냅샷과 `untrackedBaseline`으로 사용자의 기존 미커밋 작업까지 보존하는 안전 롤백(`rollback_ag_task`)을 제공합니다.
   - `path.resolve` + `realpathSync` 정규화로 Path Traversal(`../`), Symlink 탈출, `.git/`·`.env*`·`.ag-bridge/config.json` 쓰기를 차단합니다.

---

## 설치 및 빌드

```bash
cd server
npm install
npm run build        # TypeScript 컴파일 -> server/dist/
npm run typecheck    # Strict 타입 검사 (tsc --noEmit)
npm test             # 단위·보안·통합·Stdio MCP 테스트 실행
npm run verify       # 실환경 매니페스트·cli-init·라이브 Stdio MCP 헬스체크
```

> **CI / PR 워크플로우:** 모든 변경은 전용 브랜치 → GitHub Pull Request 단위로 진행하며, `.github/workflows/ci.yml`이 Ubuntu/Windows/macOS × Node 20/22 매트릭스에서 빌드·테스트·문서 링크 무결성을 자동 검증합니다.

### Claude Code 플러그인 등록

플러그인 루트 디렉터리를 Claude Code에 플러그인으로 연결하면 다음 구성이 자동 활성화됩니다:
- **MCP 서버:** `.mcp.json` → `node ${CLAUDE_PLUGIN_ROOT}/server/dist/index.js`
- **세션 초기화 훅:** `hooks/hooks.json` → `SessionStart` 시 `cli-init.js --silent` 실행
- **자율 위임 스킬:** `skills/ag-delegate/SKILL.md`
- **슬래시 커맨드:** `/ag-delegate`, `/ag-config`, `/ag-status`

### API 폴백 모드 설정 (비구독자 / 헤드리스 환경)

```bash
# macOS / Linux
export GEMINI_API_KEY="your-gemini-api-key"

# Windows PowerShell
$env:GEMINI_API_KEY = "your-gemini-api-key"
```

---

## 노출 MCP Tools

| Tool | 설명 |
| :--- | :--- |
| `delegate_to_antigravity` | Git 체크포인트 생성 → `.ag-bridge/` 디스패치 → 감지된 엔진(구독/API) 실행 → 리포트·변경 파일·아티팩트 회수 |
| `check_ag_environment` | 실행 모드, 로컬 Antigravity CLI/앱 경로, API 키 설정 여부(마스킹), Git/Bridge 상태 진단 |
| `rollback_ag_task` | `gitCheckpointRef` 및 `untrackedBaseline`을 이용해 위임 직전 상태로 안전 복구 |

---

## 저장소 구조

```text
claude-antigravity-plugin/
├── .claude-plugin/plugin.json     # Claude Code 플러그인 매니페스트
├── .mcp.json                      # 내장 Stdio MCP 서버 정의
├── hooks/hooks.json               # SessionStart 자동 초기화 훅
├── skills/ag-delegate/SKILL.md    # 자율 위임 판단 및 검수 스킬
├── commands/                      # /ag-delegate, /ag-config, /ag-status
├── templates/claude-handoff.md    # Antigravity 측 핸드오프 워크플로우 템플릿
├── server/                        # TypeScript MCP 서버, 브릿지, 듀얼 엔진 & 테스트
│   ├── src/
│   │   ├── index.ts               # MCP Server 엔트리포인트 (3 Tools)
│   │   ├── cli-init.ts            # SessionStart 초기화 스크립트
│   │   ├── types.ts               # 공통 타입·상태 머신·에러 코드
│   │   ├── config.ts              # 설정 로더·우선순위·비밀 마스킹
│   │   ├── path-guard.ts          # lockedPaths 및 Path Traversal 차단
│   │   ├── bridge-fs.ts           # .ag-bridge/ 원자적 I/O·잠금·아카이브
│   │   ├── git-guard.ts           # Git 체크포인트 및 무손실 롤백
│   │   ├── detector.ts            # OS별 Antigravity(agy/antigravity) 및 API Key 감지
│   │   └── engines/
│   │       ├── base.ts            # ExecutionEngine 인터페이스
│   │       ├── subscription.ts    # 구독자용 CLI/IPC 트리거 + 하이브리드 감시 엔진
│   │       └── api-worker.ts      # 비구독자용 @google/genai Tool-calling 루프 엔진
│   └── tests/                     # 단위·보안·통합·Stdio MCP 테스트 스위트
├── AGENTS.md                      # Antigravity 에이전트 규칙 및 문서 진입점
└── docs/                          # Antigravity 표준 개발 문서 (00~06)
```

---

## 개발 문서 (Antigravity 표준)

전체 문서 목차는 [docs/README.md](./docs/README.md)를 참고하세요.

- 기획/요구사항: [PRD.md](./docs/01-planning/PRD.md) · [user-flows.md](./docs/01-planning/user-flows.md)
- 아키텍처/보안: [system-architecture.md](./docs/02-architecture/system-architecture.md) · [bridge-protocol.md](./docs/02-architecture/bridge-protocol.md) · [security-and-git-guard.md](./docs/02-architecture/security-and-git-guard.md)
- 상세 명세: [mcp-tools-api.md](./docs/03-specs/mcp-tools-api.md) · [execution-engines.md](./docs/03-specs/execution-engines.md) · [prompts-and-commands.md](./docs/03-specs/prompts-and-commands.md)
- 구현/검증: [implementation-plan.md](./docs/04-implementation/implementation-plan.md) · [task-checklist.md](./docs/04-implementation/task-checklist.md) · [test-and-qa-plan.md](./docs/05-verification/test-and-qa-plan.md)
