# 보안 모델 및 Git Guard 설계서 (Security & Git Guard)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ARC-003` |
| **버전** | `1.2.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-24` |
| **관련 문서** | [PRD](../01-planning/PRD.md), [브릿지 프로토콜](./bridge-protocol.md), [테스트 & QA 계획](../05-verification/test-and-qa-plan.md) |

---

## 1. 위협 모델 (Threat Model)

외부 에이전트(로컬 Antigravity 또는 Gemini API 루프)에 파일 쓰기 및 셸 명령 실행 권한을 위임할 때 발생할 수 있는 핵심 위협은 다음과 같다.

| 위협 ID | 위협 내용 | 영향 | 완화 계층 |
| :--- | :--- | :--- | :--- |
| `TH-01` | `../` Path Traversal 또는 Symlink를 이용한 워크스페이스 외부/허용 외 파일 덮어쓰기 | 백엔드 코어·시스템 파일 변조 | `path-guard.ts` |
| `TH-02` | `.git/`, `.env`, `.ag-bridge/config.json` 등 민감 파일 변조 | 저장소 오염, 비밀 탈취, 설정 변조 | `path-guard.ts` 금지 목록 |
| `TH-03` | API 워커 `run_command`를 통한 파괴적 명령(`rm -rf`, `git push --force`) 또는 셸 인젝션 | 데이터 손실, 원격 저장소 훼손 | `api-worker.ts` 명령 정책 |
| `TH-04` | `GEMINI_API_KEY`가 로그, `report.md`, `manifest.json`에 노출 | API 키 유출 및 과금 피해 | 로그 마스킹 & git 무시 등록(`.git/info/exclude` / `.gitignore`) |
| `TH-06` | 플러그인이 자동 실행되는 SessionStart 훅에서 워크스페이스가 심어 둔 프로그램을 실행하거나, 링크로 바깥 파일에 쓰게 만듦 | 폴더를 여는 것만으로 코드 실행 / 임의 위치 쓰기 | `bridge-fs.ts` — 훅 경로는 프로세스를 띄우지 않고 링크를 따라 쓰지 않음([ADR-005](../06-adr/ADR-005-local-git-exclude.md), `TC-S08`~`TC-S11`) |
| `TH-05` | 위임 작업 실패 또는 저품질 결과로 인한 작업 트리 오염 | 수동 복구 비용 발생 | `git-guard.ts` 체크포인트/롤백 |
| `TH-07` | 복제한 저장소가 `git.exe`·`agy`·`taskkill.exe` 같은 이름의 프로그램을 넣어 두고, `PATH`의 상대 경로 항목(`.`, `bin`, `node_modules\.bin`)이 그것을 가리킴 | 위임·롤백·작업 취소 때 저장소가 넣은 코드 실행 | `exec-path.ts` — 완전한 절대 경로 항목만 검색 (§6, `TC-S12`~`TC-S16`) |

---

## 2. `lockedPaths` 경로 격리 설계 (`server/src/path-guard.ts`)

### 2.1 검증 알고리즘 (Strict Path Canonicalization)
`api-worker.ts`의 `write_file(targetPath, content)` 호출 시 반드시 다음 6단계를 순차 수행한다.

1. **빈 경로 및 Null Byte 차단:** `targetPath`에 `\0`이 포함되거나 빈 문자열이면 즉시 거부.
2. **절대 경로 정규화:** `resolvedTarget = path.resolve(workspaceRoot, targetPath)`.
3. **워크스페이스 경계 검증:** `path.relative(workspaceRoot, resolvedTarget)`가 `..`로 시작하거나 절대 경로(`path.isAbsolute`)이면 즉시 거부 (`PATH_TRAVERSAL_BLOCKED`).
4. **Symlink 탈출 검증:** 대상 파일(또는 가장 가까운 기존 상위 디렉터리)에 대해 `fs.realpathSync`를 수행하여 실제 물리 경로도 `workspaceRootReal` 내부인지 확인한다.
5. **절대 금지 경로(Denylist) 차단:** `lockedPaths`에 포함되었더라도 아래 경로는 무조건 거부한다(`PROTECTED_PATH_BLOCKED`):
   - `.git/**`
   - `.env`, `.env.*` (단, `.env.example` 읽기 전용은 허용 가능, 쓰기는 기본 차단)
   - `.ag-bridge/config.json`
   - `node_modules/**`
6. **`lockedPaths` 범위 일치 검사:**
   - 각 `lockedPath`를 정규화(`resolvedScope`)한 뒤, 다음 중 하나를 만족해야 허용한다:
     - 정확히 일치 (`resolvedTarget === resolvedScope`)
     - 디렉터리 접두사 일치 (`resolvedTarget.startsWith(resolvedScope + path.sep)`)
   - Windows 환경에서는 드라이브 문자 및 대소문자 비교를 정규화(`toLowerCase()`)한다.
   - `lockedPaths`가 빈 배열인 경우 쓰기를 전면 차단한다(Fail-Closed).

### 2.2 `read_file` / `list_dir` 경계
- 읽기 작업은 `lockedPaths` 외의 워크스페이스 파일(예: 백엔드 타입 정의, `package.json`, `tsconfig.json`)도 참조할 수 있도록 **워크스페이스 내부 읽기 허용**을 기본으로 하되, 워크스페이스 외부 탈출(`../`) 및 비밀 파일(`.env`, `.env.local`, `.ssh`, `*.pem`, `*.key`) 읽기는 차단한다.

---

## 3. API 워커 셸 명령 샌드박싱 (`run_command`)

`api-worker.ts`가 호출하는 `run_command(command)`는 **빌드·타입체크·린트·단위 테스트 검증 전용**으로 제한한다.

### 3.1 명령 허용/차단 정책
- **기본 허용 패턴 (Allowlist 기반 검증):**
  - 패키지 매니저 스크립트: `npm run <script>`, `pnpm <script>`, `yarn <script>`, `bun run <script>`
  - 타입체크/컴파일/린트/테스트: `npx tsc`, `tsc`, `eslint`, `prettier --check`, `vitest`, `jest`, `next build`, `vite build`
- **절대 차단 패턴 (Denylist — 최우선 차단):**
  - 셸 체이닝/리다이렉션 악용: `;`, `&&`, `||`, `|`, `` ` ``, `$(`, `>`, `<` (단, 안전한 단일 명령 인자만 허용하거나 엄격 파싱)
  - 파괴적·외부 전송 명령: `rm`, `del`, `rmdir`, `git push`, `git reset`, `git checkout`, `curl`, `wget`, `powershell`, `cmd`, `bash -c`, `sh -c`, `sudo`, `chmod`, `chown`
- **실행 제약:**
  - `cwd`는 항상 `workspaceRoot`로 고정
  - 타임아웃: `config.api.command_timeout_sec` (기본 `60s`), 초과 시 프로세스 트리 강제 종료(`SIGKILL` / Windows `taskkill`)
  - 출력 절단: `stdout` + `stderr` 합산 최대 `16 KB` (`tail` 우선 보존 + 앞부분 요약 표시)
  - 환경변수 필터링: 자식 프로세스 `env`에서 `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 등 민감 키 제거 후 전달

---

## 4. 비밀정보 보호 정책

1. **환경변수 우선:** `GEMINI_API_KEY`는 `.ag-bridge/config.json`에 평문 저장하지 않고 환경변수(`api_key_env: "GEMINI_API_KEY"`) 참조를 기본으로 한다.
2. **출력 마스킹 유틸리티 (`maskSecrets`):**
   - `stderr` 로그, `report.md`, MCP Tool 에러 메시지에 `process.env.GEMINI_API_KEY` 원문이나 `AIza[0-9A-Za-z_-]{20,}` 패턴이 포함될 경우 `[REDACTED]`로 치환한다.
3. **`check_ag_environment` 응답:** API 키는 절대 원문을 반환하지 않고 `{ configured: boolean, source: "env" | "config" | "none" }`만 반환한다.

---

## 5. Git Guard 설계 (`server/src/git-guard.ts`)

### 5.1 설계 목표
- 사용자가 작업 중이던 **미커밋 변경사항(Dirty Working Tree)을 절대 덮어쓰거나 날리지 않고** 안전하게 체크포인트를 만든다.
- 사용자의 `HEAD` 커밋 히스토리나 `git stash list`를 불필요하게 오염시키지 않는다.
- 롤백 시 위임 이전의 미커밋 상태까지 정확히 복원하고, 위임 중 새로 생성된 untracked 파일만 선별 삭제한다.

### 5.2 체크포인트 생성 전략 (`createCheckpoint`)

```mermaid
flowchart TD
    A["createCheckpoint(workspaceRoot)"] --> B{"Git 저장소인가?"}
    B -- No --> C{"git_guard 정책"}
    C -- best_effort --> D["경고 반환 (checkpointRef = undefined)"]
    C -- required --> E["에러 반환 (GIT_NOT_A_REPO)"]
    B -- Yes --> F["위임 전 untracked 파일 목록 스냅샷 (git status --porcelain)"]
    F --> G["git stash create 실행 (작업트리/스태시 목록 비변경)"]
    G --> H{"stash commit 해시 생성됨?"}
    H -- Yes (Dirty Tree) --> I["refs/ag-bridge/checkpoints/<taskId> 에 해시 핀 고정"]
    H -- No (Clean Tree) --> J["현재 HEAD 해시를 checkpointRef로 기록"]
    I --> K["{ ref, isStashSnapshot: true, untrackedBaseline } 반환"]
    J --> L["{ ref, isStashSnapshot: false, untrackedBaseline } 반환"]
```

> [!IMPORTANT]
> `git stash create`는 임시 커밋 객체(dangling commit)를 생성하지만 **작업 트리를 변경하지 않고 `git stash list`에도 쌓이지 않는다.** 단, `git gc`에 의해 수거되지 않도록 `git update-ref refs/ag-bridge/checkpoints/<taskId> <hash>`로 로컬 ref를 핀 고정한다.

### 5.3 안전 롤백 전략 (`rollback(manifest)`)
1. `manifest.gitCheckpointRef` 유효성 확인 (없으면 `ROLLBACK_NO_CHECKPOINT` 반환).
2. 추적 파일 복원:
   - **Clean 기준(`isStashSnapshot === false`):** `git reset --hard <ref>` 대신 `git checkout <ref> -- .` 또는 `git restore --source=<ref> --staged --worktree .` 수행.
   - **Dirty 기준(`isStashSnapshot === true`):** `git checkout HEAD -- .` 후 `git stash apply --index <ref>`(또는 스냅샷 트리 복원 `git read-tree` + `git checkout-index`)로 위임 직전의 미커밋 상태까지 원복.
3. 신규 Untracked 파일 정리:
   - 현재 untracked 파일 목록(`git ls-files --others --exclude-standard`)에서 `manifest.gitUntrackedBaseline`에 **없던 파일**만 선별 삭제(위임 전부터 사용자가 갖고 있던 untracked 파일은 100% 보존).
4. 정리 완료 후 해당 `refs/ag-bridge/checkpoints/<taskId>` ref 삭제(또는 롤백 완료 마킹) 및 복구된 파일 목록 반환.

---

## 6. 프로그램 실행 경로 (`server/src/exec-path.ts`)

**규칙:** 플러그인이 띄우는 프로그램(`git`, `taskkill`, 클립보드·알림 도구, `powershell`, `osascript`, `.cmd` 래퍼 셸)은 모두 `requireExecutable`/`resolveExecutable`/`windowsShell`로 얻은 **절대 경로**로 실행한다. 프로그램 이름을 `spawn`/`execFileSync`에 그대로 넘기지 않고 `shell: true`를 쓰지 않는다. `agy`/`antigravity` 탐지(`detector.ts`의 `findBinaryInPath`)도 같은 경로 목록을 쓴다.

**왜:** 이름만 넘기면 `PATH`를 검색하는데, 상대 경로 항목(`.`, `bin`, `node_modules\.bin`, 드라이브 상대 `C:tools`, 루트 상대 `\tools`, POSIX의 빈 항목)은 자식 프로세스의 cwd — 곧 사용자가 연 워크스페이스 — 를 기준으로 풀린다. MCP 서버 자신의 cwd도 워크스페이스다. 실측(Windows 11, Node 22.18, libuv 1.51): 기본 `PATH`에서는 진짜 Git이 돌고, 앞에 `.`을 넣으면 워크스페이스에 둔 `git.exe`가 돈다.

**검색 규칙:**
- 완전한 절대 경로 항목만 본다 — Windows는 `X:\…` 또는 `\\server\share\…`, POSIX는 `/`로 시작하는 항목. POSIX에서 `PATH`가 아예 없으면 `execvp`처럼 `/usr/bin:/bin`을 보고, 비어 있으면(= cwd) 아무것도 보지 않는다.
- Windows는 `name.com`·`name.exe`만 후보다. libuv가 이름에 붙여 보는 확장자가 이 둘이고, `.cmd`/`.bat`는 셸 없이 띄울 수 없다(Node 20.12부터 `EINVAL`).
- POSIX는 실행 비트가 있는 일반 파일만 후보다. `execvp`처럼 실행할 수 없는 파일은 건너뛰고 다음 항목을 본다.
- Windows 셸은 `%ComSpec%`가 완전한 절대 경로일 때 그것을 쓰고, 아니면 `%SystemRoot%\System32\cmd.exe`(SystemRoot도 쓸 수 없으면 `C:\Windows`)를 쓴다.
- 못 찾으면 `requireExecutable`이 예외를 던진다. 이름으로 실행했다면 `ENOENT`가 났을 자리라 기존 `catch`가 그대로 처리하고, 이름으로 되돌아가지 않는다(`TC-S14c`).

**알려진 한계:** App Execution Alias(`%LOCALAPPDATA%\Microsoft\WindowsApps\*.exe`, 예: `winget`)는 `fs.statSync`가 `EACCES`를 내서 후보에서 빠진다(실측). 이름으로 실행하면 libuv가 찾아 띄우는 파일이다. 지금 띄우는 프로그램 중 alias는 없으니, 새 프로그램을 추가할 때 확인한다.

**의도한 예외:** API 워커 `run_command`의 허용 목록 도구(`npm`, `tsc`, `eslint` …)는 이름 그대로 실행한다. 이 도구들은 워크스페이스의 스크립트·설정을 실행하는 것이 목적이라, 같은 저장소가 심은 바이너리가 더 얻는 것이 없다(§3).

**검증:** `TC-S12`(해석기: 상대 항목·확장자·디렉터리·실행 비트), `TC-S13`(agy 탐지), `TC-S14`~`TC-S14c`(워크스페이스에 심은 `git` + `PATH`의 `.`, 서버 cwd = 워크스페이스로 재현), `TC-S15`(Windows 셸 경로), `TC-S16`(`src/`에 이름 리터럴 실행·`shell: true`·`'cmd.exe'` 값 0건).
