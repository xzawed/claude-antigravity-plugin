# 테스트 및 QA 검증 계획서 (Test & QA Plan)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `VER-001` |
| **버전** | `1.12.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-24` |
| **관련 문서** | [PRD](../01-planning/PRD.md), [보안 & Git Guard](../02-architecture/security-and-git-guard.md), [구현 마스터 플랜](../04-implementation/implementation-plan.md) |

---

## 1. 테스트 전략 개요

본 플러그인은 외부 프로세스(Antigravity 앱/CLI), 외부 API(Gemini), 로컬 파일시스템 및 Git에 직접 작용하므로 **실환경 의존성을 격리한 결정론적 자동화 테스트**와 **실제 OS 스모크 테스트**를 결합하여 검증한다.

### 테스트 피라미드
1. **단위 테스트 (`TC-U*`):** `path-guard`, `config`, `detector`, `bridge-fs`, `git-guard` (임시 디렉터리 및 Mock FS/Process 사용)
2. **보안 테스트 (`TC-S*`):** Path Traversal, Symlink 탈출, 금지 경로, 셸 인젝션, API 키 마스킹
3. **통합 테스트 (`TC-I*`):** Mock MCP Stdio 클라이언트 → `index.ts` → Mock Subscription / Mock Gemini API 전체 파이프라인
4. **E2E / 스모크 테스트 (`TC-E*`):** 실제 빌드 산출물(`server/dist/*.js`) 실행, `SessionStart` 훅, 실제 Claude Code 연동 점검

---

## 2. 테스트 케이스 매트릭스

### 2.1 단위 테스트 (`TC-U`)

| ID | 대상 모듈 | 시나리오 | 기대 결과 | 추적 FR/NFR |
| :--- | :--- | :--- | :--- | :--- |
| `TC-U01` | `detector.ts` | `mode: auto`, 로컬 `agy` 감지 + API 키 존재 | `resolvedMode === 'subscription'` 우선 선택 | `FR-002` |
| `TC-U02` | `detector.ts` | `mode: auto`, 앱/CLI 미설치 + `GEMINI_API_KEY` 존재 | `resolvedMode === 'api'` 자동 폴백 | `FR-002` |
| `TC-U03` | `detector.ts` | `mode: auto`, 둘 다 미존재 | `unavailable` 및 `NO_ANTIGRAVITY_PROVIDER` 가이드 반환 | `FR-002` |
| `TC-U04` | `bridge-fs.ts` | git 작업 트리 **밖**에서 2회 연속 호출 | `.gitignore`에 `.ag-bridge/`가 정확히 1회만 등록됨 (Idempotent) | `FR-001` |
| `TC-U04b` | `bridge-fs.ts` | git 저장소에서 2회 연속 호출 | `.git/info/exclude`에 패턴 3종이 각 1회, `.gitignore` 미생성 ([ADR-005](../06-adr/ADR-005-local-git-exclude.md)) | `FR-001` |
| `TC-U04c` | `cli-init.ts` | 커밋된 저장소(`.gitignore`·`.agents/` 보유)에서 초기화 | `git status --porcelain --untracked-files=all` 빈 출력, `.gitignore` 바이트 동일 | `FR-001` |
| `TC-U04d` | `cli-init.ts` | 이전 버전이 `.gitignore`에 `.ag-bridge/`를 넣어 둔 저장소 | `.gitignore` 바이트 동일, 템플릿도 숨김(status 빈 출력) | `FR-001` |
| `TC-U04e` | `cli-init.ts` | 저장소의 하위 디렉터리를 워크스페이스로 초기화 | 저장소 `info/exclude` 사용, 하위 `.gitignore` 미생성, status 빈 출력 | `FR-001` |
| `TC-U04f` | `cli-init.ts` | 연결된 worktree에서 초기화 | 주 저장소와 공유하는 `info/exclude` 사용, status 빈 출력 | `FR-001` |
| `TC-U04g` | `cli-init.ts` | 기존 `info/exclude`가 줄바꿈 없이 끝남 / CRLF | 기존 줄과 새 패턴이 각자 한 줄, status 빈 출력 | `FR-001` |
| `TC-U05` | `bridge-fs.ts` | `RUNNING` 상태(미만료)에서 신규 위임 시도 | `BRIDGE_BUSY` 에러 반환 | `ARC-002` |
| `TC-U06` | `bridge-fs.ts` | `RUNNING` 상태(`timeout_sec` 초과 Stale)에서 신규 위임 시도 | 기존 작업 `FAILED(STALE_TIMEOUT)` 아카이브 후 신규 작업 수락 | `ARC-002` |
| `TC-U07` | `git-guard.ts` | Clean 트리에서 체크포인트 생성 → 파일 수정/생성 → 롤백 | 수정 파일 원복 + 신규 생성 파일 삭제, `git status` Clean | `FR-005`, `FR-010` |
| `TC-U08` | `git-guard.ts` | Dirty 트리(기존 수정 + 기존 untracked)에서 위임 → 롤백 | 위임 전 사용자 미커밋 수정 및 기존 untracked 파일 100% 보존 | `FR-005`, `FR-010` |
| `TC-U09` | `git-guard.ts` | Git 저장소가 아닌 임시 폴더에서 `best_effort` 모드 실행 | 경고와 함께 `gitCheckpointRef: undefined`로 정상 진행 | `PLN-002` |
| `TC-U10` | `cli-init.ts` | `--silent`로 최초 실행 후 `claude-handoff.md` 동기화 | 종료 코드 `0`, `.ag-bridge/config.json` 및 템플릿 생성 | `FR-001` |
| `TC-U33` | `server/src/**` | 계층표에 없는 새 모듈, 윗 계층 import, 순환 import, `cli-init`이 `bridge-fs` 외 모듈 import | 0건 — 계층 규칙은 [ARC-001 §3](../02-architecture/system-architecture.md) | `ARC-001` |
| `TC-U34` | `git-guard.ts` | 저장소의 clean 필터가 `git status`를 붙잡음, `AG_GIT_TIMEOUT_MS=1000` | 3초 안에 끊기고 `error`에 "1000 ms" 명시(저장소 아님으로 오인 안 함) | `ARC-003` |
| `TC-U35`, `TC-U35b` | `git-guard.ts` | 사용자의 `사용자 메모.txt`가 있는 상태에서 에이전트가 `에이전트결과.txt` 생성 후 롤백; 추적되는 `설정.json` 수정 | 에이전트 파일만 삭제·사용자 파일 보존, 변경 목록에 이름 그대로 표시(`-z`) | `ARC-003` |
| `TC-U36`, `TC-U36b` | `git-guard.ts` | 사용자 untracked 파일이 있는 상태에서 에이전트가 `app.ts`만 수정 후 롤백; 에이전트가 `git mv lib.ts util.ts` 후 롤백 | `revertedTrackedFiles`가 정확히 `['app.ts']`(사용자 파일 제외); 이름 바꾸기는 `['lib.ts', 'util.ts']` 두 이름 모두 | `ARC-003` |
| `TC-U37` ~ `TC-U37c` | `subscription.ts` · `index.ts` | 실측한 agy 응답(`available: alpha-agent, beta agent` / `no custom agents are available` / 텍스트 모드 stderr / 세션이 시작된 결과); `agy agents`는 아무것도 출력하지 않고 탐침에는 실측 형식으로 답하는 가짜 agy; `list_ag_capabilities`에 워크스페이스 전달 | 이름 목록 그대로(공백 포함), 세션이 시작된 답은 목록 아님; 탐침은 워크스페이스 cwd·`--mode plan`·`--print-timeout`·무작위 이름으로 실행, `ag_auth` 경로에는 탐침 없음; `{ cwd: workspaceRoot, probeAgents: true }` | `SPC-002` |

---

### 2.2 보안 테스트 (`TC-S`)

| ID | 대상 모듈 | 공격/위반 시나리오 | 기대 결과 | 추적 NFR |
| :--- | :--- | :--- | :--- | :--- |
| `TC-S01` | `path-guard.ts` | `lockedPaths: ["src/ui/"]`, 대상 `src/ui/../../server/secret.ts` | `PATH_TRAVERSAL_BLOCKED` 거부 | `NFR-001` |
| `TC-S02` | `path-guard.ts` | `src/ui/link.ts`가 워크스페이스 외부 파일을 가리키는 Symlink일 때 쓰기 시도 | `realpath` 검증으로 차단 | `NFR-001` |
| `TC-S03` | `path-guard.ts` | `lockedPaths`에 `.git/config` 또는 `.env` 포함 시도 | 금지 목록(Denylist)에 의해 무조건 거부 | `NFR-001` |
| `TC-S04` | `api-worker.ts` | `run_command("npm run build && rm -rf /")` 또는 `curl ...` 호출 | `COMMAND_NOT_ALLOWED` 반환, 프로세스 미실행 | `ARC-003` |
| `TC-S05` | `config.ts` / `index.ts` | 더미 `GEMINI_API_KEY` (`AIza` 패턴) 설정 후 오류 로그 및 `check_ag_environment` 검사 | 모든 출력/로그/리포트에서 원문 0건 노출 (`[REDACTED]`) | `NFR-002` |
| `TC-S06` | `bridge-fs.ts` / `artifacts.ts` | `taskId: "../../.."` 또는 `"../config"`로 아티팩트/아카이브 조회 시도 | `PATH_TRAVERSAL_BLOCKED` 즉시 거부 | `NFR-001` |
| `TC-S07` | `config.ts` / `cli-admin.ts` | `ya29.`/`4/0...`/`sk-`/`ghp_`/`Bearer` 토큰 마스킹 및 `mcp_add` CRLF 제어문자 주입 시도 | 모든 토큰 `[REDACTED]` 처리 및 제어문자 거부 | `NFR-002` |
| `TC-S08` | `cli-init.ts` 번들 | SessionStart 훅이 워크스페이스에 심어 둔 `git` 실행 (PATH에 `.` 같은 상대 경로가 있으면 성립 — 실측) | `dist/cli-init.js`에 `child_process` 참조 0건 — 훅 경로는 프로그램을 실행하지 않음 | `NFR-001` |
| `TC-S09` | `bridge-fs.ts` | 워크스페이스의 `.git` 파일이 git 디렉터리가 아닌 곳을 `gitdir:`로 가리킴 | 그곳에 쓰지 않음(`.gitignore` 경로로 처리) | `NFR-001` |
| `TC-S10` | `bridge-fs.ts` | `.git/info`가 저장소 밖을 가리키는 정션/심볼릭 링크 | 링크 대상에 아무것도 쓰지 않음 | `NFR-001` |
| `TC-S11` | `bridge-fs.ts` | `.git/info/exclude`가 바깥 파일을 가리키는 심볼릭 링크 (심볼릭 링크 권한이 없는 Windows에서는 skip) | 링크 대상 바이트 동일 | `NFR-001` |
| `TC-S12` | `exec-path.ts` | `PATH`에 `.`·`bin`·`C:tools`·`\Tools`·`node_modules\.bin`·POSIX 빈 항목이 있고 그 안에 같은 이름의 프로그램이 있음; 앞선 항목의 `git.cmd`; 프로그램 이름의 디렉터리·실행 비트 없는 파일(POSIX); POSIX `PATH` 미설정/빈 값 | 완전한 절대 경로 항목의 실행 가능한 `.com`/`.exe`(POSIX: 실행 비트) 파일만 반환, 없으면 `undefined`; 미설정이면 `/usr/bin:/bin`, 빈 값이면 `undefined` | `NFR-001` |
| `TC-S13` | `detector.ts` | `PATH`의 상대 항목에 `agy`를 심어 둠 | 절대 경로 항목의 `agy`만 탐지 | `NFR-001` |
| `TC-S14` ~ `TC-S14c` | `git-guard.ts` | 서버 cwd = 워크스페이스, 워크스페이스에 가짜 `git` + `PATH` 앞에 `.` (저장소 아님 / 저장소 / `PATH`가 `.`뿐) | 진짜 Git으로 판정(가짜 출력 0), `PATH`가 `.`뿐이면 저장소 없음으로 처리 — 이름으로 되돌아가지 않음 | `NFR-001` |
| `TC-S15` | `exec-path.ts` / `subscription.ts` | `.cmd` 래퍼 셸: `ComSpec`이 절대/상대/없음, `SystemRoot`가 절대/상대 | 항상 절대 경로(`%ComSpec%` 또는 `%SystemRoot%\System32\cmd.exe`) | `NFR-001` |
| `TC-S16` | `server/src/**` | 프로그램 이름 리터럴로 `spawn`/`execFile*` 호출, `command: '…'`, `shell: true`, `'cmd.exe'` 값, `git-guard.ts` 밖의 git 실행 | 0건 | `NFR-001` |
| `TC-S17` ~ `TC-S17c` | `config.ts` / `path-guard.ts` | `app_path`가 상대 경로 / 워크스페이스 안 절대 경로 / 밖에서 안으로 이어지는 링크 / 안쪽 경로의 `\\?\` 표기(Windows) / 워크스페이스 밖 절대 경로 | 마지막 하나만 따름, 나머지는 `auto` + 무시 목록 | `NFR-001` |
| `TC-S18` ~ `TC-S18f` | `config.ts` | 민감 키 10종(`agy_agent`·`agy_project` 포함)을 안전하지 않은 값으로 둔 설정이 git 추적(소문자 / 다른 대소문자 / 서브모듈) · 링크 경유 / 사용자 자신의 비추적 파일; 기본값을 조이는 값; 환경변수 opt-in | 저장소 쪽은 기본값으로 되돌리고 무시 목록에 기록, 사용자 파일·조이는 값·환경변수는 그대로 | `NFR-001` |
| `TC-S19` ~ `TC-S19d` | `detector.ts` / `index.ts` / `jobs.ts` / `sessions.ts` | 추적되는 설정 파일이 민감 키를 품은 채 `check_ag_environment` · 위임 · `start_ag_task` · `ag_session` 호출 | 권고·경고에 무시한 키와 해결 방법(`git rm --cached …`) 표시, 엔진은 안전한 기본값으로 실행 | `NFR-001` |
| `TC-S20` ~ `TC-S20c` | `git-guard.ts` | 저장소 `.git/config`의 `core.fsmonitor` 프로그램 · `.git/hooks/reference-transaction` 훅이 있는 저장소에서 상태 확인·체크포인트; 원격을 `ssh://`+`core.sshCommand`로 바꾼 부분 클론에서 없는 blob이 필요한 롤백 | 어느 것도 실행되지 않음(표식 파일 없음), 체크포인트 ref는 정상 생성, 지연 fetch가 필요한 롤백은 실패로 끝남 | `NFR-001` |
| `TC-S21` ~ `TC-S21c` | `path-guard.ts` (Windows) | `.env`·`.git`·`node_modules`의 8.3 짧은 이름(`ENV~1`·`GIT~1`·`NODE_M~1`, 8.3이 꺼진 볼륨이면 건너뜀), `.env::$DATA`·`App.tsx:hidden`(대체 데이터 스트림), `.git.`·`.env `·`ui. `(끝 점/공백) | 모두 거부(`PROTECTED_PATH_BLOCKED` 또는 `PATH_TRAVERSAL_BLOCKED`), 일반 점 포함 이름(`App.test.tsx`)은 그대로 허용 | `NFR-001` |
| `TC-S22` ~ `TC-S22c` | `git-guard.ts` | 기준선 없는 매니페스트로 롤백(사용자의 untracked 파일 존재); 저장소가 아닌 폴더에서 untracked 목록 요청; `core.ignorecase=false` 저장소에서 에이전트가 추적 파일 이름의 대소문자만 바꾼 뒤 롤백(Windows·macOS) | untracked 파일을 하나도 지우지 않고 `untrackedBaselineMissing`; 목록 실패는 `[]`가 아니라 `undefined`; 추적 파일은 롤백 뒤에도 남음 | `NFR-001` |
| `TC-S23` ~ `TC-S23e` | `git-guard.ts` | 사용자의 untracked `notes.txt`가 있는 상태에서 에이전트가 `git add -A` + 커밋(깨끗한 체크포인트) / `git add -A`(더러운 체크포인트) 후 롤백; 더러운 체크포인트에서 에이전트가 같은 브랜치에 커밋 후 롤백; 에이전트가 사용자의 다른 브랜치 `dev`로 전환 후 롤백; `.gitignore` 대상(사용자의 `.env`, 작업 중 생긴 `dist/`)이 있는 상태에서 롤백 | `notes.txt` 내용 그대로·다시 untracked, HEAD는 체크포인트 커밋; 사용자 편집본이 충돌 표시 없이 복원; 아무것도 바꾸지 않고 `GIT_CHECKPOINT_FAILED`(두 ref와 `git switch <branch>` 안내), `dev` 끝 커밋 그대로; 무시 대상은 하나도 지우지 않음 | `NFR-001` |

---

### 2.3 통합 테스트 (`TC-I`)

| ID | 시나리오 | 검증 방식 | 기대 결과 |
| :--- | :--- | :--- | :--- |
| `TC-I01` | **MCP Stdio 프로토콜 검증** | 자식 프로세스로 `server/dist/index.js` 실행 후 JSON-RPC `tools/list` 및 `check_ag_environment` 호출 | `stdout`이 순수 JSON-RPC 프레임만 포함, MCP Tool 12종 정상 노출 |
| `TC-I02` | **Subscription 전체 파이프라인 (Mock)** | `delegate_to_antigravity(modeOverride: "subscription")` 호출 중 백그라운드 모킹 타이머가 500ms 후 `RUNNING`, 1000ms 후 `report.md` 작성 및 `VERIFIED` 갱신 | `fs.watch`/폴링이 즉시 감지하고 `reportMarkdown`, `artifacts`, `changedFiles` 반환 |
| `TC-I03` | **Subscription 타임아웃** | `timeout_sec: 2` 설정 후 상태 미변경 유지 | 2초 후 `FAILED(TASK_TIMEOUT)` 반환, 체크포인트 유지 |
| `TC-I04` | **API Worker 전체 파이프라인 (Mock Gemini)** | `@google/genai` 모킹: Turn 1 `list_dir` → Turn 2 `write_file(locked)` → Turn 3 `write_file(out-of-scope 거부)` → Turn 4 `run_command("npx tsc --noEmit")` → Turn 5 최종 응답 | 허용 파일만 생성, 범위 외 쓰기 차단, `report.md` 생성 및 `VERIFIED` 반환 |
| `TC-I05` | **API Worker `max_turns` 초과** | `max_turns: 3`, 매 턴 Function Call만 반환하는 Mock | `max_turns` 도달 시 무한 루프 방지, `FAILED(MAX_TURNS_EXCEEDED)` 반환 |

---

### 2.4 크로스플랫폼 & 릴리스 게이트 (`TC-E`)

릴리스(v1.0.0) 전 반드시 아래 게이트를 모두 통과해야 한다.

| 게이트 | 검증 항목 | 통과 기준 |
| :--- | :--- | :--- |
| **G1. 컴파일 & 타입** | `cd server && npm run typecheck && npm run build` | 경고/에러 0건 |
| **G2. 자동화 테스트** | `cd server && npm test` | `TC-U*`, `TC-S*`, `TC-I*` 100% 통과 |
| **G3. Windows 경로 안전성** | 공백 포함 경로(`C:\Test Dir\plugin`)에서 `cli-init.js` 및 `index.js` 실행, 그리고 `git init`한 공백 포함 경로에서 `cli-init.js` 실행 | 정상 기동 및 종료, git 저장소에서는 `.gitignore` 미생성 + `git status` 빈 출력 |
| **G4. 매니페스트 정합성** | `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json` JSON 파싱 및 참조 경로 검증 | 모든 참조 파일 실제 존재 |
| **G5. 무의존 번들 기동** | `npm ci` **전에** `node server/scripts/smoke-bundle.mjs` — 두 번들의 참조가 Node 내장 모듈뿐인지 정적 검사(`bundle-scan.mjs`, 단위 테스트 `bundle-scan.test.ts`), 이어 `NODE_PATH`를 지운 환경에서 `dist/index.js` MCP `initialize` + `tools/list`, 공백 포함 경로에서 `dist/cli-init.js` 실행 ([ADR-004](../06-adr/ADR-004-prebuilt-server-bundle.md)) | 비내장 참조 0(선택 모듈 3개 제외), 도구 12개 응답, `cli-init` exit 0 |
| **G6. 번들 드리프트** | `npm run build` 뒤 `git diff --exit-code -- server/dist/index.js server/dist/cli-init.js` | 커밋된 번들 = 새 빌드 (diff 0) |
| **G7. 문서 수량** | `node server/scripts/check-doc-counts.mjs` — `.md`·`.svg`가 적은 슬래시 커맨드 수·MCP Tool 수를 `commands/*.md` 개수·`server/src/index.ts`의 `server.tool(` 등록 수와 대조 (날짜가 박힌 기록 3개 제외, 읽은 주장이 8개 미만이면 실패) | 불일치 0건 |
