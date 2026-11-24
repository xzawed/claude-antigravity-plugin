# AGENTS.md — `claude-antigravity-plugin` Workspace Rules

> 본 문서는 Antigravity 에이전트가 본 워크스페이스에서 자동으로 로드하는 최상위 프로젝트 규칙(Always-On Rule) 및 문서 네비게이션 인덱스입니다.

## 1. 프로젝트 개요

- **프로젝트명:** `claude-antigravity-plugin` (MCP Plugin Name: `antigravity-delegate`)
- **목적:** Claude Code(메인 오케스트레이터)가 프론트엔드 UI 구현, 다중 파일 작업, 브라우저 E2E 시각적 검증을 Antigravity(로컬 구독 앱/CLI 또는 Gemini API 워커)에 안전하게 위임하고 결과를 회수하는 MCP 기반 협업 플러그인.
- **대상 런타임:** Node.js `>= 20.x`, TypeScript `>= 5.x`, ESM/NodeNext, `@modelcontextprotocol/sdk`, `@google/genai`
- **핵심 실행 모드:** `auto` (Subscription 우선 감지 → API 자동 폴백), `subscription`, `api`

## 2. 문서 네비게이션 (Progressive Disclosure)

구현 또는 수정 전 반드시 관련 문서만 선택적으로 읽고 작업한다.

| 영역 | 문서 경로 | 언제 읽는가 |
| :--- | :--- | :--- |
| 문서 작성 표준 | `docs/00-standards/documentation-standard.md` | 문서를 생성·수정하거나 리뷰할 때 |
| 제품 기획 (PRD) | `docs/01-planning/PRD.md` | 요구사항 범위, 페르소나, 완료 기준을 확인할 때 |
| 시나리오/플로우 | `docs/01-planning/user-flows.md` | 사용자/에이전트 상호작용 및 예외 흐름을 설계할 때 |
| 시스템 아키텍처 | `docs/02-architecture/system-architecture.md` | 전체 디렉터리, 모듈 의존성, 크로스플랫폼 구조 확인 시 |
| 브릿지 프로토콜 | `docs/02-architecture/bridge-protocol.md` | `.ag-bridge/` 상태 머신, 파일 포맷, 동시성/복구 구현 시 |
| 보안 & Git Guard | `docs/02-architecture/security-and-git-guard.md` | `lockedPaths` 검증, 셸 제한, 체크포인트/롤백 구현 시 |
| MCP API 명세 | `docs/03-specs/mcp-tools-api.md` | MCP Tool 스키마, 에러 코드, 입출력 계약 구현 시 |
| 듀얼 엔진 명세 | `docs/03-specs/execution-engines.md` | `subscription.ts`, `api-worker.ts`, `detector.ts` 구현 시 |
| 프롬프트 & 커맨드 | `docs/03-specs/prompts-and-commands.md` | `SKILL.md`, `commands/*.md`, `claude-handoff.md` 작성 시 |
| 구현 마스터 플랜 | `docs/04-implementation/implementation-plan.md` | Phase 1~4 마일스톤 및 WBS 확인 시 |
| 작업 체크리스트 | `docs/04-implementation/task-checklist.md` | 단계별 구현 진행률을 추적·갱신할 때 |
| 테스트 & QA 계획 | `docs/05-verification/test-and-qa-plan.md` | 단위/통합/보안 테스트 작성 및 검증 시 |
| 아키텍처 결정(ADR) | `docs/06-adr/README.md` | 핵심 기술 선택 배경과 트레이드오프 확인 시 |
| 원본 초기 명세 | `claude_antigravity_plugin_spec_md.md` | 초기 원안과 비교 검증이 필요할 때 |

## 3. 절대 불변 규칙 (Engineering Invariants)

1. **보안 경계 준수 (`lockedPaths`)**
   - `api-worker.ts` 및 브릿지 파일 쓰기는 반드시 `path.resolve` + `realpath` 정규화 후 `lockedPaths` 범위 내인지 검증한다.
   - `.git/`, `.env*`, `.ag-bridge/config.json`에 대한 에이전트 쓰기는 어떠한 경우에도 차단한다.
2. **원자적 상태 갱신 (Atomic Bridge I/O)**
   - `.ag-bridge/manifest.json` 등 상태 파일은 임시 파일(`.tmp`)에 기록 후 `rename`으로 원자적 교체한다.
   - `.ag-bridge/`는 항상 대상 워크스페이스의 `.gitignore`에 등록되어야 하며 API 키는 로그/리포트에 절대 노출하지 않는다.
3. **크로스플랫폼 우선 (Windows / macOS / Linux)**
   - 경로 조립은 `path.join` / `path.resolve`를 사용하고 셸 명령 인젝션을 유발하는 문자열 결합 대신 `spawn(..., { shell: false })`를 기본으로 한다.
   - `hooks/hooks.json` 및 `.mcp.json`의 `${CLAUDE_PLUGIN_ROOT}` 경로는 공백 포함 경로(Windows)를 고려해 안전하게 처리한다.
4. **Stdio MCP 안전성**
   - MCP 서버(`server/src/index.ts`)는 Stdio 프로토콜 통신에 `stdout`을 사용하므로 모든 내부 로그는 반드시 `stderr`로 출력한다.
5. **문서-코드 동기화**
   - MCP 스키마, 상태 머신, 환경변수, 에러 코드 변경 시 `docs/03-specs/` 및 `docs/04-implementation/task-checklist.md`를 동일 작업 단위에서 함께 갱신한다.
6. **PR 단위 작업 원칙 (Git & PR Workflow — 필수)**
   - `main` 브랜치에 직접 커밋·푸시하지 않는다. 모든 기능·문서·버그 수정·리팩토링 작업은 반드시 전용 작업 브랜치(`feat/*`, `fix/*`, `docs/*`, `chore/*`)에서 수행하고 GitHub Pull Request(PR) 단위로 제출한다.
   - PR 생성 전 반드시 `npm --prefix server run typecheck`, `npm --prefix server run build`, `npm --prefix server test` 통과 여부를 검증하고 PR 본문에 변경 요약·검증 결과를 명시한다.
7. **빌드 산출물 커밋 (Prebuilt Bundle)**
   - 마켓플레이스 설치(`/plugin install`)는 저장소를 커밋된 그대로 복사할 뿐 `npm install`·`npm run build`를 돌리지 않는다. 그래서 `.mcp.json`·`hooks/hooks.json`이 실행하는 `server/dist/index.js`·`server/dist/cli-init.js`는 의존성까지 묶은 자체완결 번들로 **커밋한다**.
   - `server/src/`를 바꾸면 재빌드한 두 파일을 같은 커밋에 넣는다. CI가 `node_modules` 없이 번들을 띄워 보고(G5), 새 빌드와 커밋본이 다르면 실패한다(G6). 근거: [ADR-004](docs/06-adr/ADR-004-prebuilt-server-bundle.md).

## 4. 표준 빌드 및 검증 명령 (구현 완료 후)

```bash
cd server
npm ci
npm run build        # esbuild 번들 → dist/index.js, dist/cli-init.js (커밋 대상)
npm run typecheck    # npx tsc --noEmit
npm test             # 단위 및 Mock MCP 통합 테스트
npm run smoke:bundle # node_modules 없이 기동되는지 (CI는 npm ci 전에 실행)
```
