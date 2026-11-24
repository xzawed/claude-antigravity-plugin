# 구현 및 검증 작업 체크리스트 (Task Checklist)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `IMP-002` |
| **버전** | `1.6.0` |
| **상태** | `Active` |
| **최종 수정일** | `2026-11-25` |
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
| `2026-11-24` | README 수치 정리 (G7) | `node server/scripts/check-doc-counts.mjs` + `npm test` (`doc-counts.test.ts`) + 변이 7종 | `PASS` | 근거 없는 "57 / 57 tests"(VER-002 기록은 35, v1.4.0 릴리스 노트엔 없음)·"7 / 7 CI"·"0 npm vulnerabilities"(오늘 `npm audit` 0건이나 코드 변경 없이 바뀜)를 README·SVG·배지에서 제거, 지연 수치는 기록 출처(VER-002 S3/S4, v1.4.0 릴리스 노트) 명시; G7이 커맨드 주장 20곳·Tool 주장 19곳을 원천(21·12)과 대조, 첫 실행에서 낡은 3곳 발견·수정(`docs/README` "MCP Tool 3종", VER-001 `TC-I01`, SPC-003 제목); Grok 레그 지적 2건 실측 확인 후 채택("21개의 …" 미독 · "run these 3 commands" 오독); SVG의 `--` 포함 주석(엄격 XML 파서 거부) 수정; `npm test` 84 → 88 통과(1 skip) |
| `2026-11-24` | 워크스페이스 설정 신뢰 (ARC-003 §7) | `npm test` (`TC-S17`~`TC-S19d`) + 변이 17종 | `PASS` | 수정 전 RED: 저장소가 커밋한 `.ag-bridge/config.json`의 `app_path`(상대·워크스페이스 안·링크 경유)와 권한 완화 값이 그대로 쓰이고 경고 없음 → GREEN; 제가 먼저 의심해 실측한 우회 2건(대소문자 다른 `.AG-BRIDGE/CONFIG.JSON`, 추적 폴더로 가는 `.ag-bridge` 링크 — 둘 다 `ls-files`가 "추적 안 됨") 막음; Antigravity 레그(대조군 통과)가 찾은 서브모듈 우회(gitlink만 추적)·`\\?\` 표기 우회와 Grok 레그가 찾은 8.3 짧은 이름 우회(이 볼륨에 8.3 활성, `PROBE-~1`)를 실측 후 막음 — `:(icase).ag-bridge` 경로 지정 + `realpath.native`; Grok 레그는 대조군 실패(심은 거짓 사실 수용)라 할인; 미채택: `git_guard`(더 약한 값 없음), `agy_agent`·`agy_project`(워크스페이스 정의를 읽는다는 재현 없음); `npm test` 88 → 101 통과(1 skip) |
| `2026-11-24` | Git Guard 저장소 정의 명령 차단 (ARC-003 §8) | `npm test` (`TC-S20`~`TC-S20c`, `TC-S16`) + 변이 4종 | `PASS` | 실측: `.git/`째 온 저장소에서 `status`·`stash create`가 `core.fsmonitor`를, `update-ref`가 `reference-transaction` 훅을 실행 → `-c core.fsmonitor=false -c core.hooksPath=/dev/null`(Windows에서도 동작 확인)로 RED→GREEN; Grok 레그(대조군 실패 — 할인) 주장 중 부분 클론 지연 fetch가 `reset --hard`에서 `core.sshCommand`를 실행함은 실측 확인 → `-c protocol.allow=never`로 `TC-S20c` RED→GREEN, `alias.status`가 내장 명령을 대체한다는 주장은 실측으로 반박; `TC-S16`이 `git-guard.ts` 밖의 git 실행도 잡음; 남긴 것 실측: 롤백 `stash apply`는 HEAD가 그대로면 merge driver를 실행하지 않고, HEAD가 움직여 같은 파일이 바뀌면 실행(필터·merge driver는 LFS 때문에 유지, 문서화); Antigravity 레그(대조군 통과) 새 지적 없음; 첫 `TC-S20c` 실행은 가짜 ssh가 stdin을 기다려 교착(테스트 결함, 프로세스 정리 후 수정); `npm test` 101 → 104 통과(1 skip) |
| `2026-11-24` | Node 20 CI 실패 가독성 · ARC-001 정비 | vitest `globalSetup` shim + `npm test` (`TC-U33`) + 변이 3종 | `PASS` | vitest 5.1.1 `engines: ^22.12 \|\| ^24 \|\| >=26` — Node 20(플러그인 하한)에서 리포터가 `Map.groupBy`(Node 21+)로 죽어 실패 내용 대신 `TypeError`만 출력(공식 Node 20.20.2로 일부러 실패하는 테스트를 돌려 측정) → shim 후 `AssertionError` 원문 출력, Node 22 출력 불변; ARC-001의 모듈 트리(3개 Tool·커맨드 3종)·의존 그래프(`cli-init → config` 등 실제와 다름)·CLI 탐색(`which/where` → 순수 JS 절대 경로 탐색)·IPC 표(`Set-Clipboard`·`xdotool` → `clip`·`xclip`) 정정, 파일 단위 그래프 대신 계층표 + `TC-U33`(윗 계층 import·순환·훅 고립 검사) |
| `2026-11-24` | path-guard Windows 경로 별칭 (ARC-003 §2.1) | `npm test` (`TC-S21`~`TC-S21c`) + 변이 4종 | `PASS` | `main`에서 실측: `ENV~1`·`.env::$DATA` 읽기가 `.env` 비밀 반환, `src/NODE_M~1/x.js` 쓰기 허용, `GIT~1`·`.git.`을 lockedPaths로 수락 → OS 실경로(`realpath.native`) 비교 + Windows에서 `:`·끝 점/공백 조각 거부로 RED→GREEN(Windows CI에서도 `TC-S21` 실제 실행); Node 20·22 108 통과; 두 레그 모두 이 PR에서 대조군 실패(할인), 실질 답(남은 우회 없음, 하드 링크는 한계)은 일치 |
| `2026-11-24` | Git Guard 시간 제한 · 롤백 안전 (ARC-003 §5.3·§5.4) | `npm test` (`TC-U34`, `TC-U35`·`b`, `TC-S22`~`TC-S22c`) + 변이 8종 | `PASS` | 실측: 저장소 clean 필터가 `git status`를 16.6초 붙잡음 → 120초(`AG_GIT_TIMEOUT_MS`) 제한·"Git did not answer" 표시; untracked 2만 개(1.3MB)에서 이전 목록 0개(출력 초과를 `[]`로 삼킴) → 64MiB·실패는 `undefined`·기준선 모르면 체크포인트 없음/삭제 없음; `-z` 없이 한글 이름이 인용돼 롤백이 `에이전트결과.txt`를 못 지움 → `-z`; Antigravity 레그(대조군 통과)가 지적한 `core.ignorecase=false` 저장소의 대소문자만 바뀐 추적 파일 삭제를 실측 후 수정; 변이 1종(체크포인트의 목록 실패 분기)은 결정적 재현 수단이 없어 생존 — 문서화; 108 → 114 통과(1 skip, `main` d81f07a 실측 108) |
| `2026-11-24` | 에이전트가 실행한 git 이후의 롤백 (ARC-003 §5.3·§8) | `npm test` (`TC-S23`~`TC-S23e`, `TC-U36`·`b`) + 변이 9종 | `PASS` | Grok 레그 지적(대조군은 실패)을 이전 번들로 실측: 에이전트의 `git add -A`(커밋 포함) 뒤 롤백이 사용자의 untracked `notes.txt`를 지움(3가지 경우 모두), 더러운 체크포인트 + 에이전트 커밋은 충돌 표시를 남기고 실패하며 저장소 merge driver 실행(ran=true), 에이전트가 사용자의 `dev`로 전환 뒤 롤백이 `dev`를 옮김, `revertedTrackedFiles`가 사용자 파일을 포함하고 커밋된 파일을 누락 → 인덱스에서 사용자 파일 제외·스냅샷 기준(`<ref>^1`) 복원(ran=false)·HEAD ref 기록 후 다르면 무변경 거부·`git diff --no-renames <ref>` 보고; untracked 내용 미스냅샷은 한계로 문서화(README 과장 문구 정정); Antigravity 레그의 오경보(무시 파일 삭제)가 가리킨 미고정 불변식을 `TC-S23e`로 고정; 114 → 121 통과(1 skip) |
| `2026-11-24` | `agy_agent` 설정 신뢰 (ARC-003 §7) | `npm test` (`TC-S18`·`TC-S18b` 단언 추가) + 변이 2종 | `PASS` | 설정 신뢰 묶음의 되살릴 조건("워크스페이스 정의를 읽는다는 재현")을 agy 자신의 출력으로 확인: `.agents/agents/probe-ws-agent.md`가 있는 새 폴더에서 헤드리스 `--agent no-such-agent-xyz` → `(available: probe-ws-agent)`, 대조 폴더 → `(no custom agents are available)` → `agy_agent`를 민감 키로(추적 설정이면 무시·보고, 사용자 비추적 설정은 그대로); `agy_project`는 agy 도움말상 사용자 자신의 프로젝트 선택이라 제외(되살릴 조건 기록); 121 통과(개수 불변, 1 skip) |
| `2026-11-24` | `agy_project` 설정 신뢰 (ARC-003 §7) | `npm test` (`TC-S18`·`TC-S18b` 단언 추가) + 변이 1종 | `PASS` | 되살릴 조건을 사용자 확인 아래 실측: 로컬 테스트 프로젝트 `f1`(폴더 F1, `~/.gemini/config/projects/`에만 생성, 기본 프로젝트 ID 불변)을 만들고 다른 폴더 W에서 `--project f1` → `(available: f1-only-agent)`·F1의 `SessionStart` 훅 실행, 없으면 둘 다 없음 → `agy_project`를 민감 키로; 세 AI(Claude·Grok·Antigravity) 1라운드 만장일치·2라운드 이의 없음; 121 통과(개수 불변, 1 skip) |
| `2026-11-24` | `list_ag_capabilities` 에이전트 목록 (SPC-002) | `npm test` (`TC-U37`~`TC-U37c`) + 변이 6종 | `PASS` | 실측: `agy agents`·`agy agent`는 파이프·파일로 0바이트 → 목록이 늘 `[]`; 없는 `--agent`로 묻는 헤드리스 실행은 세션 전에 `(available: …)`/`(no custom agents are available)`로 답함(대화 ID 없음, 0토큰, 워크스페이스 훅 미실행 — 일반 실행에서는 훅 실행됨) → 워크스페이스 cwd에서 탐침(무작위 이름·plan·`--print-timeout 10s`), `agy agents` 출력이 있으면 그쪽 우선; 실제 agy로 에이전트 2개 폴더 `["alpha-agent","beta agent"]`·대조 `[]`·각 약 3초; 세 AI 1라운드 만장일치(D)·2라운드 이의 없음; 121 → 124 통과(1 skip) |
| `2026-11-24` | Windows 시간 제한 뒤 남는 git 정리 (ARC-003 §5.4) | `npm test` (`TC-U34`, `TC-U34b`) + 변이 6종 | `PASS` | 실측: 오류에 런처 PID(`pid` 숫자); 런처에서 `ParentProcessId`를 따라 찾은 git.exe·sh.exe를 끝내니 폴더 3.3초(안 하면 7.5초 이상); 실제 바이너리 직접 실행은 `cannot spawn sh`인데 0으로 끝나 기각 → `ETIMEDOUT`이면 PowerShell 한 번으로 하위 프로세스를 멈춤(생성 시각 범위로 PID 재사용 차단); 런처 모드 4회 모두 "ended 2 processes"·폴더 즉시 해제·약 1.7초; TC-U34는 `sleep 8`·15초 상한(정리의 PowerShell 시간 포함, 제한 없으면 30초 이상); 구현 검토 후 강화(UTC·좁은 구간·두 번째 훑기); 변이 6종 중 3종 잡힘, 3종 생존 — PID 재사용 조건·두 번째 훑기는 재현 수단이 없고, 깊이 탐색은 두 단계 트리에서 두 번째 훑기와 겹침(문서화); 세 AI 1라운드 만장일치·2라운드 이의 없음; 124 → 125 통과(1 skip, #37 병합 후 `main` 124) |
| `2026-11-24` | 에이전트 탐침 답 정확 일치 (SPC-002) | `npm test` (`TC-U37d`) + 변이 2종 | `PASS` | 구현 검토 레그 둘(Grok·Antigravity)이 같이 지적: 고정 안 된 욕심 많은 `(.*)`가 `(available: a, b) (hint)`를 `["a", "b) (hint"]`로 읽음(RED 재현) → 끝 고정만으로는 `)`로 끝나는 덧붙임을 못 막아, 실측 형식과 정확히 같고 목록에 괄호가 없을 때만 읽음(아니면 경고·빈 목록); 실제 agy 결과 불변; 125 → 126 통과(1 skip, #38 병합 후 `main` 125) |
| `2026-11-24` | 롤백 복구 (ARC-003 §5.5) | `npm test` (`TC-S24`~`TC-S24j`, `TC-U38`, `TC-U36b` 갱신, `TC-I06` 확장) + 변이 13종 | `PASS` | 세 AI 2라운드 결정(옮기기 + 상한 스냅샷 + 롤백 직전 기록, 2,000개·50MB, 10개/7일/250MB)을 실측 비용(복사 2,000×25KB 2.5초 vs git 객체 18.6초, 20,000개 복사 20초)으로 구현: 롤백이 치우는 것은 `.ag-bridge/recovery/<task>/rollback-<시각>/`로 이동, 에이전트가 추가·스테이징·커밋한 파일도 인덱스에서 빼 reset이 지우지 않게 함; 사용자 untracked 사본을 체크포인트 때 복사하고 고치거나 지운 것을 되돌림(에이전트 판은 `replaced/`); 정션을 따라 밖에 쓰지 않음·매니페스트가 가리키는 다른 폴더는 무시; `preRollbackHead`·`refs/ag-bridge/pre-rollback/<task>`로 롤백 되돌리기; 보관 규칙 정리; 구현 검토(Antigravity 대조군 통과)의 지적을 실측 후 반영 — 정션 대상 안의 바깥 파일을 롤백이 빼냄(`main`은 지움) → 링크 뒤 경로는 손대지 않고 보고, `git rm` 후 다시 만든 파일이 리셋에 덮어써짐 → 리셋 전 `replaced/`, 사본이 정리된 경우 경고(Grok은 참인 TC-S24f를 틀렸다고 해 해당 주장 기각); 변이 13종 모두 잡힘; 126 → 137 통과(1 skip, #39 병합 후 `main` 126) |
| `2026-11-24` | 감사 결함 수정 및 보안 강화 (`fix/audit-bugs-and-hardening`) | `npm run typecheck` + `npm run build` + `smoke:bundle` + `check-doc-counts.mjs` + `npm test` (`TC-U34c`, `TC-U39`~`TC-U42`, `TC-S18g`, `TC-S25`, `TC-S26`) | `PASS` | 전수 감사 결함 일괄 수정: (1) 설정 신뢰 fail-closed(`git ls-files -z` 기반 로캘 독립 판정, 확인 불가 시 민감 키 무시, `TC-S18g`), (2) `cli-admin` `--env`/`--header` 비밀 마스킹·`.mcp.json` 제어문자 차단·HTTP `headers` 동기화·실패 보고(`TC-S26`), (3) API 워커 `catch` 경로 `report.md` 비밀 마스킹 및 `NaN` 숫자 인자 방어(`TC-S25`), (4) 디스패치 시 잔류 `report.md` 정리 및 `get_ag_job` 작업별 격리·마스킹(`TC-U39`, `TC-U40`), (5) `ag_session` 체크포인트 `.ag-bridge/history/` 아카이브(`checkpointTaskId`)·턴 타임아웃 시 프로세스 종료 및 세션 정리(`TC-U41`), (6) `list_ag_artifacts` 비표준 하위 폴더 스킵(`TC-U42`), (7) `rollbackCheckpoint` 타임아웃 원인 보존(`TC-U34c`)·`endWindowsLeftovers` 순환 방어·`auth` 리스너 정리·`subscription` Windows 인용/POSIX 프로세스 그룹/`close` 이벤트 보강; **13 suites / 146 tests PASS (0 fail)**, G1~G7 전부 통과 |
| `2026-11-25` | `v1.5.0` 릴리스 준비 및 문서 현행화 (`chore/release-1.5.0`) | `npm run typecheck` + `npm run build` + `smoke:bundle` + `check-doc-counts.mjs` + `npm test` | `PASS` | 버전 `1.4.1` → `1.5.0` 범프(`plugin.json`, `server/package.json`, `server/package-lock.json`, `server/src/index.ts`, `mcp-tools-api.md`, `README*.md`), 번들 재빌드, `session-handoff.md` (`v1.0.0` → `v1.5.0`) 및 `task-checklist.md` 현행화; **13 suites / 146 tests PASS (0 fail)**, `smoke:bundle` (`antigravity-delegate 1.5.0`) · `doc-counts` 전부 통과 |
| `2026-11-25` | 릴리스 자동화 CI & 버전 정합성 게이트 (`chore/release-workflow`) | `check-version-sync.mjs --tag v1.5.0` + `check-doc-counts.mjs` + `typecheck` + `build` + `npm test` (`TC-U43`, `TC-U43b`) | `PASS` | `server/scripts/check-version-sync.mjs`(6개 버전 선언 + 태그 일치 검증), `.github/workflows/release.yml`(태그 푸시 시 G1~G7 + 멱등 GitHub Release 발행), `.github/workflows/ci.yml` 버전 동기화 게이트 연동; **14 suites / 148 tests PASS (0 fail)** |
| `2026-11-25` | POSIX git 타임아웃 하위 프로세스 정리 (`fix/posix-git-timeout-cleanup`) | `typecheck` + `build` + `smoke:bundle` + `check-doc-counts.mjs` + `npm test` (`TC-U34d`, `TC-U34e`) | `PASS` | POSIX에서 `setsid -- <git>`(Linux) / `perl setpgrp` + `exec`(macOS 폴백)으로 git을 독립 프로세스 그룹(`PGID = pid`)에서 실행하고, `ETIMEDOUT` 시 `endPosixLeftovers`가 자기 서버 PID 미포함 확인 후 `-pgid`에 `SIGKILL`(2차 훑기 포함) 전송; Windows 로컬 149 pass + 1 POSIX skip, Ubuntu·macOS CI에서 `TC-U34d` 실측 검증 |
| `2026-11-25` | 실시간 MCP Progress Notification (`feat/mcp-progress-notifications`) | `typecheck` + `build` + `smoke:bundle` + `check-doc-counts.mjs` + `npm test` (`TC-U44`, `TC-I09`) | `PASS` | `ExecutionContext.onProgress` 추가, `SubscriptionEngine`(`stream-json` `init`/`step_update`/`result` → 마스킹 진행 이벤트) 및 `ApiWorkerEngine`(턴/도구 진행 이벤트) 연동, `delegate_to_antigravity`에서 `_meta.progressToken` 수신 시 `notifications/progress` 실시간 송출 및 `extra.signal` 취소 전파; **14 suites / 151 pass (+1 POSIX skip)**, 라이브 Stdio `TC-I09` 통과 |
| `2026-11-25` | Git Worktree 격리 병렬 위임 (`feat/worktree-parallel-delegation`) | `typecheck` + `build` + `smoke:bundle` + `check-doc-counts.mjs` + `check-version-sync.mjs` + `npm test` (`TC-U45`~`TC-U45c`, `TC-S27`) | `PASS` | `git-guard.ts`에 `createTaskWorktree`/`removeTaskWorktree`(경로 탈출·심볼릭 링크·`ag-task/` 외 브랜치 삭제 차단) 구현, `delegate_to_antigravity` 및 `start_ag_task`에 `isolateWorktree: true` 격리 병렬 실행 지원(다중 병렬 `start_ag_task` `BRIDGE_BUSY` 없음), `rollback_ag_task` 시 부모 트리 미변경 상태로 worktree+브랜치 정리; **14 suites / 155 pass (+1 POSIX skip)** |
| `2026-11-25` | `v1.6.0` 라이브 검증 및 릴리스 준비 (`chore/release-1.6.0`) | `typecheck` + `build` + `smoke:bundle` + `verify` + `check-version-sync.mjs --tag v1.6.0` + `check-doc-counts.mjs` + `npm test` | `PASS` | 버전 `1.5.0` → `1.6.0` 범프 및 번들 재빌드, `session-handoff.md` 현행화, 라이브 `npm run verify`(매니페스트 6종 · 공백 경로 `cli-init` · 라이브 Stdio 12종 MCP Tool · 로컬 `agy.exe` 감지) 통과, **14 suites / 155 pass (+1 POSIX skip)**, `v1.6.0` 태그로 자동 릴리스 CI 검증 |
