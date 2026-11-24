# 제품 요구사항 정의서 (PRD: Product Requirements Document)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `PLN-001` |
| **버전** | `1.1.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-24` |
| **원본 기준** | [claude_antigravity_plugin_spec_md.md](../../claude_antigravity_plugin_spec_md.md) |
| **관련 문서** | [사용자/에이전트 플로우](./user-flows.md), [시스템 아키텍처](../02-architecture/system-architecture.md) |

---

## 1. 배경 및 문제 정의

### 1.1 배경
소프트웨어 개발 워크플로우에서 **Claude Code**는 백엔드 설계, 복잡한 도메인 로직, 아키텍처 조율(Orchestration)에 강점을 보이지만, 실제 브라우저 렌더링 확인·UI 시각적 QA·대규모 프론트엔드 다중 파일 구현에서는 로컬 브라우저 검증 수단이 제한적이다. 반면 **Antigravity**는 프론트엔드 UI 구현, 다중 파일 리팩토링, 내장 Browser Subagent 기반의 실시간 렌더링·콘솔 에러·인터랙션 검증에 강점을 가진다.

### 1.2 해결하려는 문제
1. **수동 컨텍스트 전환 비용:** 개발자가 Claude Code와 Antigravity 사이를 오가며 요구사항, API 스펙, 변경 파일 목록을 복사·붙여넣기하는 마찰이 크다.
2. **과금 및 환경 파편화:** 로컬 Antigravity 구독자는 추가 API 비용 없이 구독 쿼터를 활용하고 싶고, 비구독자 또는 헤드리스/CI 환경 사용자는 `GEMINI_API_KEY`만으로 동일한 위임 경험을 원한다.
3. **안전장치 부재:** 외부 에이전트에 코드를 위임할 때 허용되지 않은 파일 수정(예: 백엔드 코어 파일 덮어쓰기)이나 실패 시 원복 수단이 없으면 프로덕션 코드 손상 위험이 크다.

### 1.3 제품 비전 및 목표
Claude Code 내부에서 **단일 MCP 플러그인(`antigravity-delegate`)**을 통해 프론트엔드/UI/E2E 검증 작업을 Antigravity에 안전하게 위임하고, 결과 리포트와 시각적 아티팩트(스크린샷·로그)를 자동 회수하는 **무마찰 멀티-에이전트 협업 파이프라인**을 구축한다.

---

## 2. 타깃 페르소나 및 사용 환경

| 페르소나 | 환경 특성 | 선호 실행 모드 | 핵심 기대 가치 |
| :--- | :--- | :--- | :--- |
| **P1. Antigravity 구독 풀스택 개발자** | macOS/Windows/Linux 데스크톱, Antigravity 앱/CLI(`agy`) 로그인 완료 | `subscription` (`auto` 자동 선택) | 추가 API 과금 없이 구독 쿼터 사용 + 브라우저 렌더링/스크린샷 E2E 자동 검증 |
| **P2. API 전용 / 비구독 개발자** | Antigravity 앱 미설치, `GEMINI_API_KEY` 보유 | `api` (`auto` 폴백) | 별도 데스크톱 앱 설치 없이 Gemini 에이전트 루프로 UI 코드 생성 및 `tsc`/빌드 자동 검증 |
| **P3. 원격 SSH / WSL / 헤드리스 개발자** | GUI 없는 원격 서버 또는 컨테이너 환경 | `api` (명시 또는 `auto` 폴백) | GUI 의존성 없이 안정적인 위임 및 빌드 검증 |

---

## 3. 제품 범위 (Scope)

### 3.1 In-Scope (v1.0.0)
- Claude Code 플러그인 패키징 (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `skills/`, `commands/`, `templates/`)
- 내장 Stdio MCP 서버 (`delegate_to_antigravity`, `check_ag_environment`, `rollback_ag_task`)
- Dual Execution Mode 자동 감지 및 수동 전환 (`auto` / `subscription` / `api`)
- `.ag-bridge/` 파일 기반 단일 진실 공급원(SSOT) 프로토콜 및 git 무시 자동 등록(git 저장소는 `.git/info/exclude`, 아니면 `.gitignore` — [ADR-005](../06-adr/ADR-005-local-git-exclude.md))
- `SessionStart` 훅을 통한 대상 워크스페이스 자동 초기화 (`cli-init.ts`)
- 작업 전 Git 체크포인트 생성 및 실패/불만족 시 즉시 롤백 (`git-guard.ts`)
- `lockedPaths` 기반 쓰기 범위 제한 및 Path Traversal 방지
- `SKILL.md` 기반 자율 위임 판단 + `/ag-delegate`, `/ag-config`, `/ag-status` 슬래시 커맨드

### 3.2 Out-of-Scope (v1.0.0 제외 — 향후 로드맵)
- 다중 위임 작업의 동시 병렬 실행(v1.0은 워크스페이스당 단일 활성 작업 잠금 정책 적용)
- Antigravity 원격 클라우드 워커(원격 서버로의 HTTP/SSE MCP 분산 위임)
- Figma 등 외부 디자인 툴 직접 연동
- IDE GUI 전용 설정 패널(v1.0은 `/ag-config` 및 `.ag-bridge/config.json` 기반)

---

## 4. 기능 요구사항 (Functional Requirements)

| ID | 분류 | 요구사항 | 우선순위 | 수용 기준 (Acceptance Criteria) |
| :--- | :--- | :--- | :---: | :--- |
| `FR-001` | 플러그인 초기화 | Claude Code 세션 시작 시 `SessionStart` 훅이 대상 워크스페이스에 `.ag-bridge/`와 git 무시 항목을 자동 초기화한다. | P0 | 최초 실행 시 `.ag-bridge/config.json` 생성, `.ag-bridge/`를 중복 없이 git 무시 등록(git 저장소는 `.git/info/exclude` — 실행 후 `git status`가 깨끗, 아니면 `.gitignore`), 오류 시 세션 블로킹 없음(`--silent`) |
| `FR-002` | 환경 감지 | `execution_mode: "auto"`일 때 로컬 Antigravity 앱/CLI(`agy`/`antigravity`)를 우선 감지하고, 없으면 `GEMINI_API_KEY`를 감지한다. | P0 | macOS/Windows/Linux에서 우선순위 `subscription -> api -> NO_ANTIGRAVITY_PROVIDER` 정확 판별 |
| `FR-003` | 상태 진단 | `check_ag_environment` MCP Tool 및 `/ag-status` 커맨드로 현재 실행 모드, 감지 경로, API 키 설정 여부(마스킹), 활성 작업 상태를 조회한다. | P0 | 민감 키 값 노출 없이 구조화된 JSON 및 마크다운 표 출력 |
| `FR-004` | 설정 관리 | `/ag-config` 커맨드 또는 `.ag-bridge/config.json`으로 실행 모드, 모델, 타임아웃, 최대 턴 수를 변경할 수 있다. | P1 | 유효하지 않은 모드/값 입력 시 스키마 검증 에러 반환, 유효 값은 즉시 반영 |
| `FR-005` | Git Guard | `delegate_to_antigravity` 실행 직전 현재 작업 상태를 안전한 체크포인트(`gitCheckpointRef`)로 기록한다. | P0 | 수정된 파일·추적 중인 변경이 있어도 데이터 유실 없이 체크포인트 해시 저장 |
| `FR-006` | 브릿지 디스패치 | 위임 요청 시 `.ag-bridge/manifest.json`(`DISPATCHED`)과 `.ag-bridge/dispatch.md`를 생성한다. | P0 | 목표, `lockedPaths`, 컨텍스트, `verifyUrl`, `acceptanceCriteria`가 누락 없이 기록됨 |
| `FR-007` | Subscription 엔진 | 대상 프로젝트에 `claude-handoff.md` 워크플로우를 동기화하고 CLI 또는 OS IPC로 트리거한 뒤 완료(`VERIFIED`/`FAILED`)까지 감시한다. | P0 | `fs.watch` + 2초 폴링 하이브리드 감시, `timeout_sec`(기본 300초) 초과 시 `FAILED` 전이 및 리포트 반환 |
| `FR-008` | API 폴백 엔진 | `@google/genai` SDK와 4개 Tool(`read_file`, `write_file`, `list_dir`, `run_command`)을 바인딩해 최대 `max_turns`(기본 15턴) 자율 루프를 수행한다. | P0 | 코드 생성 후 `tsc --noEmit` 또는 빌드 검증 실행, `report.md` 작성 및 `VERIFIED` 전이 |
| `FR-009` | 결과 회수 | 위임 완료 후 `.ag-bridge/report.md`, 변경된 파일 목록, `artifacts/` 경로를 MCP Tool 응답으로 Claude Code에 반환한다. | P0 | Claude Code가 추가 파일 탐색 없이 바로 검수 가능한 구조화 요약 반환 |
| `FR-010` | 작업 롤백 | `rollback_ag_task` 호출 시 `gitCheckpointRef`를 사용하여 위임 전 상태로 워크스페이스를 복구한다. | P0 | 위임 중 생성/수정된 파일이 안전하게 원복되고 복구된 파일 목록 반환 |
| `FR-011` | 자율 위임 판단 | `skills/ag-delegate/SKILL.md`가 UI 구현·브라우저 검증·병렬 프론트엔드 생성 조건을 판단하고 모드별 완료 조건을 분기 지시한다. | P1 | Subscription 모드 시 `verifyUrl` + 스크린샷 요구, API 모드 시 빌드/타입체크 통과 요구 |
| `FR-012` | 수동 위임 커맨드 | `/ag-delegate` 커맨드로 사용자가 명시적으로 태스크·대상 경로·검증 URL을 지정해 위임할 수 있다. | P1 | 커맨드 인자 파싱 후 `delegate_to_antigravity` 정상 호출 |

---

## 5. 비기능 요구사항 (Non-Functional Requirements)

| ID | 항목 | 요구사항 기준 | 검증 방법 |
| :--- | :--- | :--- | :--- |
| `NFR-001` | 보안 (경로 격리) | `lockedPaths` 외부 경로 쓰기, `../` Path Traversal, Symlink 탈출, `.git/`·`.env*` 쓰기 100% 차단 | 보안 단위 테스트 (`TC-S01`~`TC-S04`) |
| `NFR-002` | 보안 (비밀정보) | `GEMINI_API_KEY` 등 비밀정보가 `dispatch.md`, `report.md`, `manifest.json`, stderr 로그에 절대 평문 출력되지 않음 | 로그/출력 마스킹 테스트 (`TC-S05`) |
| `NFR-003` | 크로스플랫폼 | macOS, Windows 11, Linux(Ubuntu)에서 Node.js 20+ 환경으로 동일 빌드 및 실행 | 경로/프로세스 OS 분기 테스트 |
| `NFR-004` | 안정성 (원자성) | 상태 파일 갱신 중 프로세스 중단 시에도 `manifest.json` JSON 파손 방지(임시 파일 write → rename) | 원자적 쓰기 단위 테스트 |
| `NFR-005` | 응답성 & 자원 제한 | `check_ag_environment` 응답 `< 500ms`, `cli-init --silent` `< 300ms`, 셸 명령 출력 최대 `16 KB` 절단, 기본 타임아웃 `300s` | 성능/타임아웃 통합 테스트 |
| `NFR-006` | MCP 프로토콜 준수 | Stdio 채널(`stdout`)에 비-JSON-RPC 문자열 혼입 0건(모든 진단 로그는 `stderr`) | Mock MCP 클라이언트 통합 테스트 |
| `NFR-007` | 유지보수성 | TypeScript `strict: true` 통과, 엔진 추상화(`ExecutionEngine` 인터페이스)로 향후 엔진 확장 가능 | `tsc --noEmit` & 코드 리뷰 |

---

## 6. 성공 지표 (Success Metrics)

| 지표 | 목표치 (v1.0.0) | 측정 방법 |
| :--- | :--- | :--- |
| 위임 파이프라인 완주율 (Mock/실환경) | `>= 95%` | `dispatch.md -> report.md -> VERIFIED` 시나리오 반복 테스트 |
| `lockedPaths` 보안 테스트 통과율 | `100%` | 모든 경로 탈출/금지 경로 테스트 통과 |
| `auto` 모드 환경 감지 정확도 | `100%` | macOS/Windows/Linux 환경별 모킹 테스트 |
| 실패 시 롤백 무결성 | `100%` | 롤백 후 `git diff`가 위임 직전 상태와 일치 |
| TypeScript Strict 빌드 및 단위/통합 테스트 | `0 errors`, 핵심 모듈 커버리지 `>= 80%` | CI/로컬 `npm run build && npm test` |
