# 프롬프트, 스킬, 슬래시 커맨드 및 핸드오프 워크플로우 명세서

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `SPC-003` |
| **버전** | `1.5.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-23` |
| **관련 문서** | [사용자/에이전트 플로우](../01-planning/user-flows.md), [MCP API 명세](./mcp-tools-api.md), [PRD](../01-planning/PRD.md) |

---

## 1. 프롬프트 자산 목록

플러그인이 포함하는 마크다운 기반 프롬프트/워크플로우 파일은 총 23개이다 (`SKILL.md` 1종 + 슬래시 커맨드 21종 + 핸드오프 템플릿 1종).

| 파일 경로 | 실행 주체 | 역할 |
| :--- | :--- | :--- |
| `skills/ag-delegate/SKILL.md` | Claude Code | 자율 위임 여부 판단, 12종 MCP Tool 조율, 전체 `agy` CLI 옵션 매핑, 토큰 사용량 보고, 결과 검수 및 롤백 의사결정 |
| `commands/ag-login.md` | Claude Code | `/ag-login` Google OAuth 로그인(브라우저/수동 링크+코드), 인증 상태 확인, 안전 로그아웃 안내 |
| `commands/ag-delegate.md` | Claude Code | `/ag-delegate` 동기 명시적 위임 커맨드 (전체 `agy` 플래그 및 `--dangerously-skip-permissions` 지원) |
| `commands/ag-start.md` | Claude Code | `/ag-start` 비동기 백그라운드 위임 (`start_ag_task`) |
| `commands/ag-jobs.md` | Claude Code | `/ag-jobs` 백그라운드 작업 진행률·로그·리포트 수집 (`get_ag_job`) |
| `commands/ag-cancel.md` | Claude Code | `/ag-cancel` 실행 중인 백그라운드 작업 중단 (`cancel_ag_job`) |
| `commands/ag-browser.md` | Claude Code | `/ag-browser` Antigravity 내장 `/browser` 실제 브라우저 E2E/시각적 QA 전용 커맨드 |
| `commands/ag-boost.md` | Claude Code | `/ag-boost` Antigravity 내장 `/boost` 다중 관점 심층 추론 프리셋 |
| `commands/ag-swarm.md` | Claude Code | `/ag-swarm` Antigravity 내장 `/swarm` 다중 워커 병렬 팀 프리셋 |
| `commands/ag-goal.md` | Claude Code | `/ag-goal` Antigravity 내장 `/goal` 목표 검증 달성 자율 루프 프리셋 |
| `commands/ag-review.md` | Claude Code | `/ag-review` 이종 모델 읽기 전용(`--mode plan` + `--json-schema`) 교차 코드/보안 리뷰 |
| `commands/ag-resume.md` | Claude Code | `/ag-resume` `taskId`/`conversationId` 기반 이전 Antigravity 대화 이어가기 |
| `commands/ag-rollback.md` | Claude Code | `/ag-rollback` 원클릭 무손실 Git Guard 체크포인트 롤백 |
| `commands/ag-session.md` | Claude Code | `/ag-session` 지속 멀티턴 `stream-json` 세션 시작·전송·목록·종료 (`ag_session`) |
| `commands/ag-artifacts.md` | Claude Code | `/ag-artifacts` 스크린샷·리포트·마스킹 로그 아티팩트 조회 (`list_ag_artifacts`) |
| `commands/ag-mcp.md` | Claude Code | `/ag-mcp` Antigravity MCP 서버 관리 및 `.mcp.json` 동기화 (`ag_cli_admin`) |
| `commands/ag-remote.md` | Claude Code | `/ag-remote` Antigravity `remote-control` 데몬 상태/시작/중지 (`ag_cli_admin`) |
| `commands/ag-update.md` | Claude Code | `/ag-update` Antigravity CLI 변경 이력 조회(`changelog`) 및 업데이트(`update`) |
| `commands/ag-config.md` | Claude Code | `/ag-config` 실행 모드·모델·추론 강도·권한(`skip-permissions`)·샌드박스·타임아웃 설정 커맨드 |
| `commands/ag-status.md` | Claude Code | `/ag-status` 연결 상태, `agy` 권한/모델 설정, 최근 토큰 사용량 및 환경 진단 표 출력 커맨드 |
| `commands/ag-models.md` | Claude Code | `/ag-models` 실시간 `agy` 모델·에이전트 목록 및 지원 권한/플래그 조회 커맨드 |
| `commands/ag-usage.md` | Claude Code | `/ag-usage` 워크스페이스 누적 및 최근 작업별 토큰 사용량(`input`/`output`/`thinking`/`cacheRead`/`total`) 리포트 커맨드 |
| `templates/claude-handoff.md` | Antigravity (로컬 구독) | 대상 워크스페이스 `.agent/workflows/claude-handoff.md`로 배포되는 실행 지침서 |

---

## 2. `skills/ag-delegate/SKILL.md` 설계 명세

### 2.1 Frontmatter 규격
```yaml
---
name: ag-delegate
description: >-
  Delegate frontend UI implementation, multi-file component scaffolding, styling,
  real-browser E2E visual verification, and any Antigravity CLI (`agy`) workflow
  (custom models, effort, agents, conversation resume, `--dangerously-skip-permissions`,
  and token usage tracking) from Claude Code to Antigravity via the embedded
  antigravity-delegate MCP server.
---
```

### 2.2 필수 지시 섹션
1. **위임 적합 조건 (When to Delegate):**
   - React / Next.js / Vue / Svelte / Tailwind 등 프론트엔드 UI 컴포넌트 및 스타일링 작업
   - 로컬 개발 서버(`verifyUrl`)에서 실제 브라우저 렌더링·레이아웃·콘솔 에러·사용자 인터랙션을 검증해야 하는 작업
   - 사용자가 명시적으로 Antigravity(`agy`) 모델·에이전트·대화 이어가기·브라우저 검증 또는 비대화형 실행을 요청한 모든 작업
2. **위임 제외 조건 (When NOT to Delegate):**
   - 단순 1~2줄 오타 수정 또는 백엔드 DB 마이그레이션·보안 핵심 로직(사용자가 명시적으로 Antigravity 실행을 요청한 경우 제외)
3. **사전 점검 및 기능 조회:**
   - 위임 전 `check_ag_environment`로 `resolvedMode` 및 `agyConfig`를 확인한다.
   - 모델/에이전트 선택이 필요할 때 `list_ag_capabilities`로 실시간 목록을 확인한다.
4. **권한 정책 (`--dangerously-skip-permissions`):**
   - 사용자가 명시적으로 `--dangerously-skip-permissions` / `always-proceed`를 요청하거나 `.ag-bridge/config.json`에 설정된 경우에만 `dangerouslySkipPermissions: true`를 전달한다.
   - 임의로 `dangerouslySkipPermissions: true`를 활성화하지 않으며, 활성 시 Git Guard 체크포인트가 생성되었음을 안내한다.
5. **최소 권한 `lockedPaths` 원칙:**
   - 코드 수정 작업 시 필요한 디렉터리/파일만 좁게 지정한다(`.git/`, `.env*`, `.ag-bridge/config.json` 절대 금지).
   - Subscription 모드에서 순수 질의·분석·자유 `agy` 실행일 때만 `lockedPaths` 생략을 허용한다. API 모드에서는 `lockedPaths` 필수.
6. **결과 검수, 토큰 사용량 보고 및 롤백 기준:**
   - 반환된 `reportMarkdown`, `changedFiles`, `artifacts`, `metrics`(`model`, `conversationId`, `permissionMode`, `durationSeconds`, `usage.inputTokens`/`outputTokens`/`thinkingTokens`/`cacheReadTokens`/`totalTokens`)를 사용자에게 간결하게 보고한다.
   - 회귀 또는 실패 시 사용자 확인 하에 `rollback_ag_task`를 호출한다.

---

## 3. 핵심 슬래시 커맨드 설계 명세 (6개 — 전체 목록의 원천은 `commands/*.md`)

### 3.0 `commands/ag-login.md` (`/ag-login`)
- **사용법:**
  - `/ag-login` (로그인 상태 확인 후 미인증 시 로컬 브라우저 OAuth 자동 실행; SSH/헤드리스 환경은 링크+코드 모드 자동 전환)
  - `/ag-login status` (실시간 인증 상태, 인증 방식, 사용 가능 모델 수 점검)
  - `/ag-login --manual` / `--no-browser` (채팅에 클릭 가능한 Google OAuth 링크 출력)
  - `/ag-login complete <code-or-url> [sessionId]` (복사한 인가 코드/콜백 URL 제출, 원본 코드 재출력 금지)
  - `/ag-login --force` (이미 인증된 상태에서도 계정 전환/재인증 강제)
  - `/ag-login cancel` (대기 중인 수동 로그인 세션 취소)
  - `/ag-login logout` (OS 키링 안전 로그아웃 절차 안내)

### 3.1 `commands/ag-delegate.md` (`/ag-delegate`)
- **사용법:**
  ```text
  /ag-delegate <작업 설명> [--paths <p1,p2>] [--url <http://localhost:3000/...>] [--mode <auto|subscription|api>] [--model <id>] [--effort <low|medium|high|xhigh|max>] [--agent <name>] [--agy-mode <accept-edits|auto|plan>] [--sandbox|--no-sandbox] [--dangerously-skip-permissions] [--add-dir <dir>] [--continue] [--conversation <id>] [--project <name>] [--new-project] [--remote-agent] [--json-schema <schema>] [--disable-slash-commands] [--settings <path|json>] [--timeout <sec>]
  ```
- **실행 흐름:**
  1. `$ARGUMENTS`에서 작업 설명과 모든 선택 플래그를 파싱한다.
  2. `check_ag_environment` 확인 후 API 모드 또는 코드 수정 작업 시 최소 권한 `lockedPaths`를 구성해 `delegate_to_antigravity`를 호출한다.
  3. 반환된 리포트, 변경 파일, 아티팩트, **토큰 사용량 및 `conversationId`**를 요약 보고한다.

### 3.2 `commands/ag-config.md` (`/ag-config`)
- **사용법:**
  - `/ag-config` (현재 `.ag-bridge/config.json` 조회)
  - `/ag-config mode <auto|subscription|api>`
  - `/ag-config agy-mode <accept-edits|auto|plan>`
  - `/ag-config agy-model <model-id|clear>`
  - `/ag-config effort <low|medium|high|xhigh|max|clear>`
  - `/ag-config agent <agent-name|clear>`
  - `/ag-config sandbox <on|off>`
  - `/ag-config skip-permissions <on|off>` (`subscription.agy_dangerously_skip_permissions` 설정 + 보안 주의 안내)
  - `/ag-config stream-heartbeat <on|off>`
  - `/ag-config model <gemini-model-name>` (API 모드 모델)
  - `/ag-config timeout <seconds>`
  - `/ag-config max-turns <count>`
  - `/ag-config git-guard <best_effort|required>`
- **실행 흐름:**
  1. `.ag-bridge/config.json`을 읽어 유효성 검증 후 요청된 키만 원자적으로 업데이트한다.
  2. 변경 전/후 표를 출력하고 `check_ag_environment`로 즉시 검증한다.

### 3.3 `commands/ag-status.md` (`/ag-status`)
- **사용법:** `/ag-status`
- **실행 흐름:** `check_ag_environment({})`를 호출해 Execution Mode, Subscription App/CLI, **`agy` CLI Defaults**(`mode`, `sandbox`, `dangerouslySkipPermissions`, `model`, `effort`, `agent`), Gemini API Key, Bridge 상태(최근 `conversationId` 및 토큰 사용량 포함), Git Guard 상태를 표로 출력한다.

### 3.4 `commands/ag-models.md` (`/ag-models`)
- **사용법:** `/ag-models`
- **실행 흐름:** `list_ag_capabilities({})`를 호출해 실시간 감지된 `agy` 모델 목록, 에이전트 목록(워크스페이스 정의 포함), 지원 권한 모드(`--dangerously-skip-permissions` 포함), 추론 강도(`effort`), 지원 CLI 플래그, 현재 기본값을 정리해 출력한다.

### 3.5 `commands/ag-usage.md` (`/ag-usage`)
- **사용법:** `/ag-usage [limit]`
- **실행 흐름:** `get_ag_usage({ limit })`를 호출해 누적 토큰 사용량(`input`, `output`, `thinking`, `cacheRead`, `total`), 모드별(`subscription` vs `api`) 집계, 최근 작업별 토큰/시간/`conversationId` 표를 출력한다.

---

## 4. `templates/claude-handoff.md` (Antigravity 측 워크플로우 명세)

대상 프로젝트의 `.agent/workflows/claude-handoff.md`에 배포되며, 상단에 버전 식별 주석을 포함한다.

```markdown
<!-- ag-plugin-template-version: 1.0.0 -->
# Claude Handoff Execution Workflow
```

### 필수 6단계 실행 프로토콜
1. **상태 잠금 전이:** `.ag-bridge/manifest.json`을 읽고 `status`를 `"RUNNING"`, `updatedAt`을 현재 UTC ISO 시각으로 원자적 갱신한다.
2. **작업 지시 분석:** `.ag-bridge/dispatch.md`에서 목표, `lockedPaths`, 컨텍스트, `verifyUrl`, `acceptanceCriteria`를 읽는다.
3. **범위 준수 구현:** `lockedPaths`에 명시된 파일·디렉터리만 생성/수정한다. 범위 외 수정이 불가피하면 코드를 수정하지 말고 `report.md`의 "Notes & Follow-up for Claude"에 백엔드/상위 수정 요청으로 남긴다.
4. **빌드 & 브라우저 E2E 검증:**
   - 프로젝트 타입체크/빌드 명령을 실행해 컴파일 에러 0건을 확인한다.
   - `verifyUrl`이 지정되어 있으면 내장 Browser Subagent를 실행하여 페이지 렌더링, 핵심 인터랙션, 콘솔/네트워크 에러를 검증하고 스크린샷을 `.ag-bridge/artifacts/<taskId>/`에 저장한다.
5. **보고서 작성:** `.ag-bridge/report.md`를 표준 형식(Summary, Modified Files, Verification Results, Artifacts, Notes)으로 작성한다.
6. **완료 상태 전이:** `.ag-bridge/manifest.json`에 `artifacts`, `changedFiles`, `updatedAt`을 기록하고 `status`를 `"VERIFIED"`(치명적 실패 시 `"FAILED"` 및 `error` 사유 기록)로 최종 갱신한다.
