# 세션 인계서 (Session Handoff)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `IMP-003` |
| **버전** | `3.0.0` |
| **상태** | `Active` |
| **최종 수정일** | `2026-11-25` |
| **현재 진행 단계** | **`v1.5.0` 릴리스 준비 및 보안·롤백 복구 하드닝 완료 (`PR #1` ~ `#42` 머지 완료)** |
| **관련 문서** | [구현 마스터 플랜](./implementation-plan.md), [작업 체크리스트](./task-checklist.md), [보안 & Git Guard](../02-architecture/security-and-git-guard.md), [AGENTS.md](../../AGENTS.md) |

---

## 1. 누적 릴리스 및 PR 이력 요약 (`#1` ~ `#42`)

- **GitHub 저장소:** `xzawed/claude-antigravity-plugin` (`Apache License 2.0`)
- **`v1.0.0` (`#1` ~ `#16`):** 듀얼 실행 엔진(`subscription` / `api`), Git Guard 체크포인트/롤백, Path Guard, MCP Stdio 서버, 3-OS × Node 20/22 CI, 영문/한글 README, `claude plugin validate` 통과
- **`v1.4.0` (`#17` ~ `#21`):**
  - `v1.1` (`#17`): 전체 `agy` CLI 플래그 패리티, `--dangerously-skip-permissions`, 토큰 사용량 집계(`get_ag_usage`)
  - `v1.2` (`#18`): `/ag-login` 및 `ag_auth` OAuth 로그인/상태/로그아웃 지원
  - `v1.3` (`#19`): 비동기 백그라운드 작업(`start_ag_task`/`get_ag_job`/`cancel_ag_job`), `/ag-browser`·`/ag-boost`·`/ag-swarm`·`/ag-goal`·`/ag-review` 프리셋
  - `v1.4` (`#20`~`#21`): 지속 멀티턴 `stream-json` 세션(`ag_session`), 아티팩트 뷰어(`list_ag_artifacts`), CLI 관리(`ag_cli_admin`), MCP Tool 12종·슬래시 커맨드 21종 완성
- **`v1.4.1` (`#22` ~ `#24`):**
  - `taskId` 경로 탈출 차단 및 광범위 비밀 마스킹 (`#22`)
  - 마켓플레이스 즉시 실행을 위한 자체완결 번들(`server/dist/index.js`, `server/dist/cli-init.js`) 커밋 및 G5/G6 CI 게이트 ([ADR-004](../06-adr/ADR-004-prebuilt-server-bundle.md), `#23`)
  - `.git/info/exclude` 로컬 전용 무시 등록 및 훅 내 외부 프로세스 실행 제거 ([ADR-005](../06-adr/ADR-005-local-git-exclude.md), `#24`)
- **`v1.5.0` 보안 강화·롤백 복구·감사 수정 (`#25` ~ `#42`):**
  - **절대 경로 실행 강제 (`#25`):** `exec-path.ts`로 모든 외부 바이너리 절대 경로 실행 (`TC-S12`~`TC-S16`)
  - **문서 수량 정합성 CI (`#26`):** `check-doc-counts.mjs` (G7) 추가
  - **워크스페이스 설정 신뢰 경계 (`#27`, `#34`, `#36`, `#42`):** `.ag-bridge/config.json` 민감 키 10종(`TRUST_SENSITIVE`) fail-closed 검증 (`TC-S17`~`TC-S19d`)
  - **Git Guard 보안·타임아웃·안전 롤백 (`#28`, `#32`, `#33`, `#38`):** 저장소 정의 `fsmonitor`/훅/전송 차단(`TC-S20`~`TC-S20c`), git 호출 120초 타임아웃 및 Windows 런처 하위 프로세스 정리(`TC-U34`~`TC-U34c`), 에이전트 git 실행 이후 안전 롤백(`TC-S23`~`TC-S23e`)
  - **Path Guard Windows 별칭 차단 (`#31`, `#35`):** 8.3 짧은 이름·ADS·끝 점/공백 거부 (`TC-S21`~`TC-S21c`)
  - **아키텍처 계층 가드 & Node 20 CI 개선 (`#29`, `#30`):** 모듈 계층 규칙 검사(`TC-U33`) 및 vitest Node 20 리포터 shim
  - **에이전트 목록 탐침 (`#37`, `#39`):** `list_ag_capabilities`에서 워크스페이스 커스텀 에이전트 정확 탐침 (`TC-U37`~`TC-U37d`)
  - **롤백 복구 폴더·스냅샷·롤백 되돌리기 (`#40`, `#41`):** `.ag-bridge/recovery/<taskId>/` 이동 보관, 사용자 untracked 상한 스냅샷(2,000개/50MB), `preRollbackHead`/`preRollbackRef` 기록 (`TC-S24`~`TC-S24j`, `TC-U38`)
  - **전수 감사 결함 일괄 수정 (`#42`):** `cli-admin`/`api-worker` 비밀 마스킹, `report.md` 격리, `ag_session` 체크포인트 아카이브 및 타임아웃 정리, `list_ag_artifacts` 비표준 폴더 스킵 (`TC-U39`~`TC-U42`, `TC-S25`~`TC-S26`)

---

## 2. 현재 검증 지표 (`v1.5.0`)

| 지표 | 현황 |
| :--- | :--- |
| **MCP Tool / 슬래시 커맨드** | **12종** MCP Tools · **21종** Slash Commands (CI G7 자동 검증) |
| **자동화 TDD 스위트 (`npm --prefix server test`)** | **13 suites / 146 tests PASS** |
| **GitHub Actions CI 게이트** | **G1~G7 전원 통과** (Ubuntu · macOS · Windows × Node 20/22 + Docs Integrity) |
| **무의존 번들 (`smoke:bundle`)** | `node_modules` 없이 `server/dist/index.js`·`server/dist/cli-init.js` 정상 기동 |

---

## 3. 후속 로드맵 (순차 PR 단위 진행)

1. **`v1.5.0` 정식 릴리스 발행** (버전 범프 + 문서 현행화 + `git tag v1.5.0` + GitHub Release)
2. **릴리스 자동화 CI (`.github/workflows/release.yml`):** 태그 푸시 시 버전 일치·G1~G7 검증 후 GitHub Release 자동 생성
3. **POSIX git 타임아웃 하위 프로세스 정리:** macOS/Linux에서도 git 타임아웃 시 필터 하위 프로세스 그룹 정리
4. **실시간 MCP Progress Notification (`notifications/progress`):** `agy --output-format stream-json` 진행 이벤트를 Claude Code로 실시간 스트리밍
5. **Git Worktree 격리 병렬 위임:** 워크스페이스당 단일 활성 작업 잠금을 확장해 다중 위임 작업 격리 실행 지원
6. **실전 Claude Code 파일럿 점검 및 차기 릴리스 발행**

---

## 4. 세션 시작용 프롬프트

```text
docs/04-implementation/session-handoff.md와 AGENTS.md를 읽고 현재 상태를 확인해 줘.
이후 모든 작업은 main 직접 푸시 없이 전용 브랜치 + PR 단위로 진행하고,
server/src 변경 시 재빌드한 server/dist 번들을 같은 커밋에 포함하자.
```
