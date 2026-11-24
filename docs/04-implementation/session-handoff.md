# 세션 인계서 (Session Handoff)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `IMP-003` |
| **버전** | `3.1.0` |
| **상태** | `Active` |
| **최종 수정일** | `2026-11-25` |
| **현재 진행 단계** | **`v1.6.0` 릴리스 완료 (`PR #1` ~ `#48` 머지, 자동 릴리스 CI·POSIX git 정리·실시간 MCP Progress·Git Worktree 격리 병렬 위임 완료)** |
| **관련 문서** | [구현 마스터 플랜](./implementation-plan.md), [작업 체크리스트](./task-checklist.md), [보안 & Git Guard](../02-architecture/security-and-git-guard.md), [AGENTS.md](../../AGENTS.md) |

---

## 1. 누적 릴리스 및 PR 이력 요약 (`#1` ~ `#48`)

- **GitHub 저장소:** `xzawed/claude-antigravity-plugin` (`Apache License 2.0`)
- **`v1.0.0` (`#1` ~ `#16`):** 듀얼 실행 엔진(`subscription` / `api`), Git Guard 체크포인트/롤백, Path Guard, MCP Stdio 서버, 3-OS × Node 20/22 CI, 영문/한글 README, `claude plugin validate` 통과
- **`v1.4.0` (`#17` ~ `#21`):** 전체 `agy` CLI 플래그 패리티, `/ag-login` (`ag_auth`), 비동기 백그라운드 작업(`start_ag_task`/`get_ag_job`/`cancel_ag_job`), 지속 멀티턴 세션(`ag_session`), 아티팩트 뷰어(`list_ag_artifacts`), CLI 관리(`ag_cli_admin`), MCP Tool 12종·슬래시 커맨드 21종 완성
- **`v1.4.1` (`#22` ~ `#24`):** `taskId` 경로 탈출 차단, 마켓플레이스 즉시 실행용 자체완결 번들 커밋([ADR-004](../06-adr/ADR-004-prebuilt-server-bundle.md)), `.git/info/exclude` 로컬 전용 무시 등록([ADR-005](../06-adr/ADR-005-local-git-exclude.md))
- **`v1.5.0` (`#25` ~ `#43`):**
  - 절대 경로 실행 강제(`exec-path.ts`, `#25`), 문서 수량 정합성 CI G7(`#26`)
  - 워크스페이스 설정 신뢰 경계 fail-closed(`TRUST_SENSITIVE` 10종, `#27`, `#34`, `#36`, `#42`)
  - Git Guard 저장소 정의 명령 차단(`#28`), 타임아웃 및 Windows 잔여 git 정리(`#32`, `#38`), 에이전트 git 실행 이후 안전 롤백(`#33`), 롤백 복구 폴더·사용자 untracked 스냅샷·롤백 되돌리기(`#40`, `#41`)
  - `path-guard` Windows 8.3/ADS/끝 점·공백 차단(`#31`, `#35`), 아키텍처 계층 가드 `TC-U33`(`#30`), `list_ag_capabilities` 에이전트 탐침(`#37`, `#39`), 전수 감사 결함 수정(`#42`), `v1.5.0` 정식 릴리스 발행(`#43`)
- **`v1.6.0` (`#44` ~ `#48`):**
  - **릴리스 자동화 CI & 버전 동기화 게이트 (`#44`):** `server/scripts/check-version-sync.mjs` (`TC-U43`, `TC-U43b`), `.github/workflows/release.yml`(태그 푸시 시 버전 일치 + G1~G7 + 멱등 GitHub Release 발행), `ci.yml` 버전 정합성 체크 연동
  - **POSIX git 타임아웃 하위 프로세스 정리 (`#45`):** Linux(`setsid --`) / macOS(`perl setpgrp` + `exec`) 독립 프로세스 그룹 격리 및 `endPosixLeftovers` `-pgid` `SIGKILL` 정리 (`TC-U34d`, `TC-U34e`)
  - **실시간 MCP Progress Notification (`#46`):** `delegate_to_antigravity`에서 `_meta.progressToken` 수신 시 `SubscriptionEngine`(`stream-json`) 및 `ApiWorkerEngine`(턴/도구) 진행 상황을 비밀 마스킹 후 `notifications/progress`로 실시간 스트리밍 및 `extra.signal` 취소 전파 (`TC-U44`, `TC-I09`)
  - **Git Worktree 격리 병렬 위임 (`#47`):** `isolateWorktree: true` 옵션으로 `.ag-bridge/worktrees/<taskId>` + `ag-task/<taskId>` 브랜치 격리 실행(다중 `start_ag_task` 동시 병렬 실행 지원, `rollback_ag_task` 시 부모 트리 미변경 worktree·브랜치 정리, 경로 탈출·비`ag-task/` 브랜치 삭제 차단 `TC-U45`~`TC-U45c`, `TC-S27`)
  - **라이브 E2E 검증 & `v1.6.0` 자동 릴리스 (`#48`):** `npm --prefix server run verify` 통과, 버전 `1.6.0` 범프 및 `v1.6.0` 태그 푸시로 `.github/workflows/release.yml` 실측 완료

---

## 2. 현재 검증 지표 (`v1.6.0`)

| 지표 | 현황 |
| :--- | :--- |
| **MCP Tool / 슬래시 커맨드** | **12종** MCP Tools · **21종** Slash Commands (CI G7 자동 검증) |
| **자동화 TDD 스위트 (`npm --prefix server test`)** | **14 suites / 156 tests** (Windows 155 pass + 1 POSIX-only skip; Ubuntu/macOS 156/156 pass) |
| **GitHub Actions CI 게이트** | **G1~G7 + 버전 동기화 게이트 + 릴리스 자동화 워크플로우 전원 통과** |
| **라이브 E2E (`npm --prefix server run verify`)** | 매니페스트 6종 · 공백 경로 `cli-init` · 라이브 MCP Stdio 12종 Tool · 로컬 `agy.exe` 감지 모두 **PASS** |

---

## 3. 향후 선택적 확장 후보

1. 실제 외부 프론트엔드 프로젝트에 `/plugin install` 마운트 후 장시간 실사용 피드백 수집 (`/ag-start` 병렬 worktree, `/ag-browser` E2E 스크린샷, `/ag-session` 멀티턴 캐시 히트)
2. 원격/HTTP SSE MCP 분산 워커 또는 GitHub Marketplace 공개 배포 패키지 확장 (필요 시)

---

## 4. 세션 시작용 프롬프트

```text
docs/04-implementation/session-handoff.md와 AGENTS.md를 읽고 현재 v1.6.0 상태를 확인해 줘.
이후 모든 작업은 main 직접 푸시 없이 전용 브랜치 + PR 단위로 진행하고,
server/src 변경 시 재빌드한 server/dist 번들을 같은 커밋에 포함하자.
```
