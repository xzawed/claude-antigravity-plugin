# 프롬프트, 스킬, 슬래시 커맨드 및 핸드오프 워크플로우 명세서

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `SPC-003` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **관련 문서** | [사용자/에이전트 플로우](../01-planning/user-flows.md), [MCP API 명세](./mcp-tools-api.md), [PRD](../01-planning/PRD.md) |

---

## 1. 프롬프트 자산 목록

플러그인이 포함하는 마크다운 기반 프롬프트/워크플로우 파일은 총 5개이다.

| 파일 경로 | 실행 주체 | 역할 |
| :--- | :--- | :--- |
| `skills/ag-delegate/SKILL.md` | Claude Code | 자율 위임 여부 판단, 입력 구조화, 결과 검수 및 롤백 의사결정 |
| `commands/ag-delegate.md` | Claude Code | `/ag-delegate` 명시적 수동 위임 커맨드 |
| `commands/ag-config.md` | Claude Code | `/ag-config` 실행 모드·모델·타임아웃 설정 커맨드 |
| `commands/ag-status.md` | Claude Code | `/ag-status` 연결 상태 및 환경 진단 표 출력 커맨드 |
| `templates/claude-handoff.md` | Antigravity (로컬 구독) | 대상 워크스페이스 `.agent/workflows/claude-handoff.md`로 배포되는 실행 지침서 |

---

## 2. `skills/ag-delegate/SKILL.md` 설계 명세

### 2.1 Frontmatter 규격
```yaml
---
name: ag-delegate
description: >-
  Delegate frontend UI implementation, multi-file component scaffolding, styling,
  and real-browser E2E visual verification tasks from Claude Code to Antigravity
  via the embedded antigravity-delegate MCP server.
---
```

### 2.2 필수 지시 섹션
1. **위임 적합 조건 (When to Delegate):**
   - React / Next.js / Vue / Svelte / Tailwind 등 프론트엔드 UI 컴포넌트 및 스타일링 작업
   - 로컬 개발 서버(`verifyUrl`)에서 실제 브라우저 렌더링·레이아웃·콘솔 에러·사용자 인터랙션(클릭/입력)을 검증해야 하는 작업
   - 백엔드 API 스펙 또는 TypeScript 타입이 확정된 상태에서 다수의 프론트엔드 페이지·상태 모듈을 생성/리팩토링하는 작업
2. **위임 제외 조건 (When NOT to Delegate):**
   - 단순 1~2줄 오타 수정 또는 백엔드 DB 마이그레이션·보안 핵심 로직
   - API 스펙 자체가 미확정이어서 아키텍처 논의가 먼저 필요한 작업
3. **사전 점검 절차:**
   - 위임 전 `check_ag_environment`를 호출해 `resolvedMode`를 확인한다.
   - `unavailable`이면 사용자에게 Antigravity 설치/로그인 또는 `GEMINI_API_KEY` 설정을 안내하고 위임을 중단한다.
4. **모드별 완료 조건 분기 규칙:**
   - `resolvedMode === 'subscription'`인 경우:
     - 로컬 개발 서버 URL이 존재하면 반드시 `verifyUrl`을 전달한다.
     - `acceptanceCriteria`에 "내장 브라우저로 렌더링 및 콘솔/네트워크 에러 0건 확인, 스크린샷을 `.ag-bridge/artifacts/`에 저장"을 포함한다.
   - `resolvedMode === 'api'`인 경우:
     - `acceptanceCriteria`에 "`npx tsc --noEmit` 및 `npm run build`(또는 프로젝트 빌드 스크립트) 통과"를 필수로 포함한다.
5. **최소 권한 `lockedPaths` 원칙:**
   - 작업에 필요한 프론트엔드 디렉터리/파일만 좁게 지정한다(예: `["src/components/checkout/", "src/pages/CheckoutPage.tsx"]`).
   - `.git/`, `.env*`, 백엔드 핵심 디렉터리는 절대 포함하지 않는다.
6. **결과 검수 및 롤백 기준:**
   - 반환된 `reportMarkdown`, `changedFiles`, `artifacts`를 검토하고 필요 시 `git diff`로 핵심 변경을 확인한다.
   - 치명적 회귀·요구사항 미충족·빌드 실패가 해소되지 않으면 사용자 동의를 얻거나 명시적 지시에 따라 `rollback_ag_task`를 호출한다.

---

## 3. 슬래시 커맨드 3종 설계 명세

### 3.1 `commands/ag-delegate.md` (`/ag-delegate`)
- **사용법:** `/ag-delegate <작업 설명> [--paths <p1,p2>] [--url <http://localhost:3000/...>] [--mode <auto|subscription|api>]`
- **실행 흐름:**
  1. `$ARGUMENTS`에서 작업 목표, 선택적 `--paths`, `--url`, `--mode`를 파싱한다.
  2. `--paths`가 생략된 경우 프로젝트 구조를 빠르게 확인해 최소 권한 `lockedPaths`를 추론하고 명시한다.
  3. `check_ag_environment` 확인 후 모드에 맞는 `acceptanceCriteria`를 구성해 `delegate_to_antigravity`를 호출한다.
  4. 반환된 리포트, 변경 파일, 아티팩트 경로를 요약 보고한다.

### 3.2 `commands/ag-config.md` (`/ag-config`)
- **사용법:**
  - `/ag-config` (현재 `.ag-bridge/config.json` 조회)
  - `/ag-config mode <auto|subscription|api>`
  - `/ag-config model <gemini-model-name>`
  - `/ag-config timeout <seconds>`
  - `/ag-config max-turns <count>`
- **실행 흐름:**
  1. `.ag-bridge/config.json`을 읽어 유효성 검증 후 요청된 키만 업데이트한다(파일이 없으면 기본 템플릿 생성).
  2. 변경 전/후 설정 값을 표로 출력하고 `check_ag_environment`를 호출해 변경된 해석 모드를 즉시 검증한다.
  3. API 키 평문 저장 요청 시 보안 경고와 함께 환경변수(`GEMINI_API_KEY`) 사용을 권장한다.

### 3.3 `commands/ag-status.md` (`/ag-status`)
- **사용법:** `/ag-status`
- **실행 흐름:**
  1. `check_ag_environment({})` 호출.
  2. 아래 표준 마크다운 표 형식으로 출력:
     - Execution Mode (설정값 / 실제 해석값)
     - Subscription App/CLI 감지 상태 및 경로
     - API Key 상태 (`Configured (env)` / `Not set`) 및 모델명
     - Bridge 상태 (`IDLE` / `RUNNING` / 마지막 작업 ID 및 시각)
     - Git Guard 상태 (저장소 여부, 브랜치, Dirty 여부)
  3. `recommendations`가 존재하면 하단에 실행 가능한 조치 명령어를 안내한다.

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
