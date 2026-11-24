# 구현 및 검증 작업 체크리스트 (Task Checklist)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `IMP-002` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **관련 문서** | [구현 마스터 플랜](./implementation-plan.md), [세션 인계서](./session-handoff.md), [테스트 & QA 계획](../05-verification/test-and-qa-plan.md) |

> 구현 진행 시 각 항목을 `[x]`로 갱신하고, 완료 시점의 빌드/테스트 결과를 하단 실행 로그에 기록한다.

---

## Phase 0: 기획 및 표준 문서화 (Completed)
- [x] 원본 명세(`claude_antigravity_plugin_spec_md.md`) 분석 및 설계 갭 도출
- [x] 루트 `AGENTS.md` 및 `README.md` 배치
- [x] `docs/00-standards/` ~ `docs/06-adr/` 표준 문서 체계 구축

## Phase 1: Project Scaffolding & Manifests (Completed)
- [x] `T-101`: `.claude-plugin/plugin.json` 작성
- [x] `T-101`: `.mcp.json` 작성
- [x] `T-101`: `hooks/hooks.json` 작성 (Windows 공백 경로 큰따옴표 적용)
- [x] `T-102`: `server/package.json` 및 `server/tsconfig.json` 구성 (`npm install` 완료)
- [x] `T-103`: `skills/ag-delegate/SKILL.md` 작성
- [x] `T-104`: `commands/ag-delegate.md`, `commands/ag-config.md`, `commands/ag-status.md` 작성
- [x] `T-105`: `templates/claude-handoff.md` 작성 (버전 헤더 포함)

## Phase 2: Core Bridge, Security & Detector (Completed)
- [x] `T-201`: `server/src/types.ts` 구현
- [x] `T-202`: `server/src/config.ts` 구현 (우선순위 해석 + Zod 검증 + `maskSecrets`)
- [x] `T-203`: `server/src/path-guard.ts` 구현 (`lockedPaths`, Path Traversal, Symlink, 금지 목록)
- [x] `T-204`: `server/src/bridge-fs.ts` 구현 (원자적 I/O, `.gitignore`, 잠금/Stale 복구, 아카이브)
- [x] `T-205`: `server/src/git-guard.ts` 구현 (`git stash create` 핀 고정 + `untrackedBaseline` 롤백)
- [x] `T-206`: `server/src/detector.ts` 구현 (macOS/Windows/Linux CLI·앱·API Key 감지)
- [x] `T-207`: `server/src/cli-init.ts` 구현 (`--silent`, 템플릿 버전 동기화)

## Phase 3: Dual Execution Engines (Completed)
- [x] `T-301`: `server/src/engines/base.ts` 구현
- [x] `T-302`: `server/src/engines/subscription.ts` 구현 (3단계 트리거 + `fs.watch`/폴링 감시)
- [x] `T-303`: `server/src/engines/api-worker.ts` 구현 (`@google/genai` 4-Tool 루프 + 명령 정책 + 재시도)

## Phase 4: MCP Server, Tests & Release Readiness (Completed)
- [x] `T-401`: `server/src/index.ts` 구현 (3개 MCP Tool 연결, `stderr` 전용 로깅)
- [x] `T-402`: 단위·보안 테스트 (`path-guard`, `bridge-fs`, `git-guard`, `detector`, `config`) 통과
- [x] `T-402`: 통합 테스트 (Mock MCP Stdio Client, Mock Subscription, Mock Gemini API) 통과
- [x] `T-403`: `npm run typecheck && npm run build` 무오류 완료
- [x] `T-403`: `node server/dist/cli-init.js --silent` (공백 포함 경로) 및 MCP 서버 Stdio 기동 스모크 테스트 통과
- [x] `T-404`: `README.md` 최종 설치/사용 가이드 반영 및 문서 동기화 확인

---

## 검증 실행 로그

| 일시 | 단계 | 명령어 | 결과 | 비고 |
| :--- | :--- | :--- | :--- | :--- |
| `2026-11-22` | Phase 0 | 문서 구조 및 링크 검증 | `PASS` | 표준 문서 세트 최초 배치 완료 (0 broken links) |
| `2026-11-22` | Phase 1~4 | `npm --prefix server run typecheck` + `build` | `PASS` | TypeScript `strict: true` 0 errors |
| `2026-11-22` | Phase 4 | `npm --prefix server test` | `PASS` | 6개 테스트 스위트, 24개 테스트 케이스 전원 통과 (`TC-U*`, `TC-S*`, `TC-I*`) |
| `2026-11-22` | Phase 4 | G3 Windows 공백 경로 스모크 + G4 JSON/아티팩트 검증 | `PASS` | `cli-init.js --silent`, `index.js`, 매니페스트 5종 정상 확인 |
| `2026-11-22` | Post-v1.0 실측 검증 | 실측 벤치마크 + TDD 확장 (`npm test` + `npm run verify`) | `PASS` | `check_ag_environment` `652.9ms`→`162.6ms` (4× 개선), Windows `.cmd` `EINVAL` 수정, **33/33 테스트 통과** |
| `2026-11-23` | v1.0.0 보안·문서·실측 | `npm audit` + 8단계 E2E 감사 + 10단계 릴리스 전 실측 (`PRE-01`~`PRE-10`) | `PASS` | **0 vulnerabilities**, **35/35 테스트**, `claude plugin validate` 0 errors/warnings, `check_ag_environment` `144.9ms` |
| `2026-11-23` | v1.0.0 릴리스 배포 | `git tag v1.0.0` + `gh release create v1.0.0` | `PASS` | `v1.0.0` 정식 릴리스 발행 및 `main` 7/7 CI 통과 완료 |
| `2026-11-24` | v1.4.1 패키징 (ADR-004) | `node server/scripts/smoke-bundle.mjs` (G5, `git archive` 추출본 · `node_modules` 0) + `npm run build` 후 `git diff --exit-code -- server/dist` (G6) | `PASS` | `main`(v1.4.0) 추출본은 `dist/index.js` 부재로 FAIL → 번들 커밋 후 MCP 12 tools 응답 · `cli-init` exit 0; 번들 `index.js` 3,124,591 B · `cli-init.js` 8,427 B; `npm test` 63/63 (단, 첫 전체 실행 1회 TC-I08 실패 — 이후 18회 연속 통과, 미재현); G5 정적 검사는 `NODE_PATH` 가림을 잡음 — zod를 심은 번들에서 이전 스모크 PASS → 새 스모크 FAIL |
| `2026-11-24` | v1.4.1 git 무시 등록 (ADR-005) | `npm test` (`TC-U04`~`TC-U04g`, `TC-S08`~`TC-S11`) + CI G3(git) | `PASS` | 수정 전 RED 7건(사용자 증상 `?? .agent/workflows/claude-handoff.md` 재현) → GREEN; 변이 4종(`**/` 제거 · 템플릿 패턴 누락 · 저장소에서 `.gitignore` 기록 · 구분자 제거) 모두 검출; 보안 리뷰 지적 2건 실측 — PATH에 `.`이 있으면 심어 둔 `git.exe` 실행, 정션 너머 쓰기(`TC-S10` RED) → 프로세스 실행 제거·링크 거부; Windows 71 통과 · 1 skip(`TC-S11`, 심볼릭 링크 권한) |
| `2026-11-24` | 프로그램 절대 경로 실행 (ARC-003 §6) | `npm test` (`TC-S12`~`TC-S16`) + 변이 15종 | `PASS` | 수정 전 RED 5건(`TC-S13` 상대 항목의 `agy.exe` 탐지 · `TC-S14`/`TC-S14b` 심어 둔 git 실행 · `.cmd` 래퍼가 `cmd.exe` · 해석기 부재) → GREEN; 변이 15종 모두 검출(실행 비트 변이는 POSIX 전용이라 이 PC에선 미실행 — Ubuntu·macOS CI가 단언); Antigravity 레그 지적(POSIX `PATH` 미설정 시 `execvp` 기본 경로) → `TC-S12f` RED→GREEN; Grok 레그 지적(App Execution Alias는 `stat` `EACCES`) 실측 확인 — 띄우는 프로그램 중 alias 없음(git·taskkill·clip·powershell 모두 `where` 첫 결과와 같은 파일)이라 문서의 한계로만 기록; `npm test` 72 → 84 통과(1 skip, `origin/main` 실측 대비) |
