# 실측 검증 및 TDD 감사 리포트 (Empirical Verification Report)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `VER-002` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **검증 환경** | Windows 11, Node.js `v24.14.1`, Git `2.56.0.windows.2`, 로컬 `agy.exe` |
| **관련 문서** | [테스트 & QA 계획](./test-and-qa-plan.md), [PRD](../01-planning/PRD.md), [보안 & Git Guard](../02-architecture/security-and-git-guard.md) |

---

## 1. 검증 개요

`main` 머지 완료 후 [test-and-qa-plan.md](./test-and-qa-plan.md) (`VER-001`) 및 [PRD.md](../01-planning/PRD.md) (`NFR-001`~`NFR-007`) 기준으로 구현부를 **실측 검증(Empirical Verification)**하고 TDD 커버리지 갭을 감사했다.

---

## 2. 실측 결과 및 발견 사항 (Before vs After)

| 검증 항목 | 목표 기준 (`PRD`/`ARC`) | 개선 전 실측 | 개선 후 실측 | 판정 | 조치 내역 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **`cli-init.js --silent` 지연** | `< 300ms` (`NFR-005`) | avg `99.1ms` (max `103.8ms`) | avg **`98.0ms`** (max `100.9ms`) | **PASS** | 기준 대비 3배 빠름 |
| **`check_ag_environment` 지연 (라이브 Stdio MCP)** | `< 500ms` (`NFR-005`) | avg **`652.9ms`** (max `708.5ms`) — **FAIL** | avg **`162.6ms`** (max `182.2ms`) | **PASS (4.0× 개선)** | `detector.ts` 순수 JS `PATH` 탐색(`findBinaryInPath`) 전환 + `git-guard.ts` 3회 `git` 호출을 단일 `git status --porcelain=v1 -b`로 통합 |
| **Windows `.cmd` CLI 실행 (`NFR-003`)** | 크로스플랫폼 안전 | Node 24 `spawn(..., { shell: false })` 시 **`EINVAL` 크래시 재현** | `buildCliSpawnSpec()`로 `.cmd`/`.bat` → `cmd.exe /d /s /c` 안전 래핑 | **PASS** | `subscription.ts` 수정 및 단위 테스트 추가 |
| **`defaultCommandRunner` 실실행** | `exitCode === 0`, 키 미유출 | `npx tsc --version` → `Version 5.9.3` | 동일 (`exitCode: 0`) | **PASS** | Windows 실실행 검증 완료 |
| **Git Guard Staged + Deleted 복원** | 100% 무결성 (`FR-010`) | `a.ts`(staged), `b.ts`(삭제 복구) 정상 | 자동화 테스트 `TC-U11` 승격 완료 | **PASS** | 회귀 방지 테스트 영구 편입 |
| **라이브 Stdio MCP 환경 감지** | `agy.exe` 자동 감지 | `resolved=subscription` (`C:\Users\dirtc\AppData\Local\agy\bin\agy.exe`) | 동일 | **PASS** | `npm --prefix server run verify` 통과 |

---

## 3. TDD 커버리지 감사 및 보강 내역 (27 → 33 테스트)

실측 감사에서 식별된 미테스트 핵심 분기를 모두 자동화 테스트로 보강하여 **6개 테스트 스위트 / 33개 테스트 100% 통과**를 달성했다.

| 추가된 테스트 영역 | 대상 파일 | 검증 내용 |
| :--- | :--- | :--- |
| **순수 JS PATH 탐색** | `tests/config-and-detector.test.ts` | Windows 대소문자 혼합 `Path` + `PATHEXT` 및 POSIX `:` 서브프로세스 없는 탐색 검증 |
| **History 프루닝 & 템플릿 업그레이드** | `tests/bridge-fs-and-init.test.ts` | `history/` 20건 상한 프루닝, `atomicWriteFile` 잔여 `.tmp` 0건, 구버전 템플릿(`0.9.0` → `1.0.0`) 업그레이드 및 `--force-template` |
| **Staged + Deleted 롤백 (`TC-U11`)** | `tests/git-guard.test.ts` | 위임 전 `git add`된 변경, unstaged 변경, 위임 중 삭제된 추적 파일의 완벽 복원 |
| **Windows `.cmd` 스폰 & API 복원력** | `tests/engines-and-mcp.test.ts` | `buildCliSpawnSpec` (`.cmd` vs `.exe`), 429 지수 백오프 재시도 복구, `package.json` 빌드 검증 너지, `read_file` 라인 슬라이싱 & `.env` 읽기 차단, 치명적 401 에러 키 마스킹 |
| **라이브 Stdio MCP 에러 프레임 (`TC-I07`)** | `tests/mcp-stdio.test.ts` | `ROLLBACK_NO_CHECKPOINT`, `PROTECTED_PATH_BLOCKED` 발생 시 `stdout` 오염 없이 구조화된 `isError: true` 반환 확인 |
