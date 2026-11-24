# ADR-005: 워크스페이스 git 무시 등록은 `.git/info/exclude`로 — 훅은 프로그램을 실행하지 않는다

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-005` |
| **상태** | `Accepted` |
| **결정일** | `2026-11-24` |
| **관련 문서** | [브릿지 프로토콜 §5.3](../02-architecture/bridge-protocol.md), [보안 & Git Guard](../02-architecture/security-and-git-guard.md), [ADR-001](./ADR-001-file-based-ag-bridge.md) |

---

## 1. 배경 (Context)

v1.4.0까지 SessionStart 훅(`cli-init.js`)은 Claude Code가 여는 모든 워크스페이스에서 (1) 추적 파일인 `.gitignore`에 `# Antigravity Claude Bridge` / `.ag-bridge/` 블록을 덧붙이고 (2) `.agent/workflows/claude-handoff.md`를 만들었다. 그래서 플러그인을 켠 사람의 저장소마다 `git status`에 ` M .gitignore`와 `?? .agent/`가 남았고, `git add -A` 한 번이면 둘 다 사용자 프로젝트 커밋에 섞였다(작성자의 다른 저장소에서 실측).

[ADR-001](./ADR-001-file-based-ag-bridge.md)과 `AGENTS.md` 불변식 2는 「`.ag-bridge/`를 `.gitignore`에 등록」을 요구했다. 목적은 `.ag-bridge/`가 커밋되지 않게 하는 것이고, 추적 파일을 고치는 것은 그 수단이었다.

## 2. 결정 (Decision)

1. **git 작업 트리 안에서는 저장소의 로컬 전용 `info/exclude`에 쓴다.** 머리말 한 줄과 `.ag-bridge/`, `**/.agent/workflows/claude-handoff.md`, `**/.agents/workflows/claude-handoff.md` 중 없는 것만 덧붙인다. 템플릿 경로는 가운데에 `/`가 있어 저장소 루트 기준으로 고정되므로 `**/`를 붙여 하위 디렉터리 워크스페이스에서도 맞게 한다. 추적 파일 `.gitignore`는 고치지 않으며, 이전 버전이 넣은 줄도 그대로 둔다.
2. **git 작업 트리 밖에서는 기존대로 `.gitignore`에 쓴다.** 더럽힐 추적 파일이 없고, 나중에 `git init`해도 보호가 남는다.
3. **훅 경로는 프로그램을 실행하지 않는다.** `info/exclude`를 `git rev-parse` 대신 코드로 찾는다. 가장 가까운 `.git`까지 올라가고(`GIT_CEILING_DIRECTORIES` 준수), `.git` 파일의 `gitdir:`과 `commondir`를 따라 worktree·submodule을 처리한다. SessionStart 훅은 사용자가 연 모든 폴더에서 자동 실행되는데, 이름만으로 `git`을 실행하면 PATH에 상대 경로(`.` 등)가 있을 때 그 폴더에 심어 둔 `git` 바이너리가 실행된다(2026-11-24 Windows 실측: `git.exe`로 이름을 바꾼 `node.exe`가 실행됨. 기본 PATH에서는 재현되지 않음).
4. **링크를 따라 쓰지 않는다.** `HEAD`가 있는 실제 디렉터리만 git 디렉터리로 인정한다. `.git`·`info`·`exclude`가 심볼릭 링크나 정션이면 그 경로를 버리고 2번으로 간다. `.gitignore`도 링크면 쓰지 않고 `protected: false`로 보고한다. 링크된 `.gitignore`를 따라 쓰는 것은 v1.4.0 이전부터 있던 같은 부류라 함께 막는다.
5. **계약은 유지한다.** 상태 필드 `bridge.gitignoreProtected`의 이름은 그대로 두고 의미만 「`.gitignore` 또는 `info/exclude`가 `.ag-bridge/`를 덮는다」로 넓힌다. `cli-init` 결과는 `ignoreUpdated`와 `ignoreFile`(`git-info-exclude` / `gitignore`)을 돌려준다.

## 3. 검토한 대안 (Alternatives Considered)

| 대안 | 장점 | 단점 및 기각 사유 |
| :--- | :--- | :--- |
| **현행 유지 (`.gitignore`에 기록)** | 팀의 다른 clone에도 보호가 공유됨 | 플러그인을 쓰는 사람의 모든 저장소에 추적 파일 변경이 생겨 커밋에 섞임 — 이번 결함 그 자체 |
| **`git rev-parse --git-path info/exclude`로 경로 찾기** | worktree·submodule·`GIT_DIR`까지 git이 정확히 처리 | 자동 실행 훅에서 프로그램을 띄움 → PATH에 상대 경로가 있으면 바이너리 바꿔치기(실측). 저장소가 링크로 쓰기 대상을 돌릴 수도 있음(`TC-S10` — 이 방식으로 짠 첫 구현이 정션 너머 바깥 폴더에 썼다) |
| **`git check-ignore`로 보호 여부 판정** | 전역 excludes·중첩 `.gitignore`까지 정확 | 같은 실행 문제, 상태 조회마다 프로세스 |
| **템플릿을 세션 시작이 아니라 위임 시점에만 동기화** | 대부분의 저장소에 `.agent/`가 생기지 않음 | Antigravity IDE에서 `/claude-handoff`를 바로 쓰는 흐름이 깨지고 동작 변경 폭이 큼. 무시 등록만으로 증상이 해결됨 |
| **로컬 `info/exclude` + 코드 해석 + 링크 거부 (채택)** | 추적 파일 무수정, 훅이 아무것도 실행하지 않음 | 드문 git 구성(`GIT_DIR` 환경변수, 심볼릭 링크 `.git`)은 `.gitignore` 경로로 처리됨. `info/exclude`는 clone마다 따로임 |

## 4. 결과 및 트레이드오프 (Consequences)

- **긍정적 결과:** 플러그인을 켠 채 세션을 열어도 사용자 저장소의 `git status`가 깨끗하다(`TC-U04c`, CI G3). 훅 번들에 `child_process`가 없다(`TC-S08`).
- **트레이드오프:** `info/exclude`는 clone마다 따로라서 다른 clone에서는 그 clone의 첫 세션 때 다시 등록된다. 이전 버전이 `.gitignore`에 남긴 블록은 사용자가 지운다(README 문제 해결 표).
- **ADR-001과의 관계:** 파일 기반 브릿지 결정은 그대로다. 「`.gitignore`에 등록」이라는 수단만 이 ADR이 대체한다.
- **검증:** `TC-U04` ~ `TC-U04f`, `TC-S08` ~ `TC-S11`, CI G3(git).
