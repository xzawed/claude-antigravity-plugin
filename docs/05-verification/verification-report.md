# 실측 검증 및 TDD 감사 리포트 (Empirical Verification Report)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `VER-002` |
| **버전** | `1.1.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-23` |
| **검증 환경** | Windows 11 x64, Node.js `v24.14.1`, Git `2.56.0.windows.2`, 로컬 `agy.exe`, GitHub Actions 3-OS Matrix |
| **관련 문서** | [테스트 & QA 계획](./test-and-qa-plan.md), [PRD](../01-planning/PRD.md), [보안 & Git Guard](../02-architecture/security-and-git-guard.md) |

---

## 1. End-to-End 전 구간 실측 감사 개요

`main` 브랜치 전체를 대상으로 **빌드·보안·매니페스트·훅·라이브 Stdio MCP·실제 Windows `.cmd` 스폰·NDJSON 스트림 하트비트·무손실 롤백·문서/시각 자산 정합성**까지 처음부터 끝까지 실측 감사를 수행했다.

---

## 2. 전 구간 실측 벤치마크 및 검증 매트릭스

| 단계 | 검증 영역 | 목표 기준 | 개선 전 실측 | 최종 실측 (`v1.1`) | 판정 |
| :---: | :--- | :---: | :---: | :---: | :---: |
| **S1** | TypeScript Strict 빌드 & `npm audit` | `0 errors`, `0 vulns` | 4건(6 advisories) 취약점 | **`0 errors`**, **`0 vulnerabilities`** (`vitest 5.1`, `zod 4.6`, `MCP 1.27`) | **PASS** |
| **S2** | 매니페스트·템플릿·자산·문서 링크 | 5 JSON, 0 broken links, `AGENTS.md < 24KB` | 33→34 테스트 수치 드리프트 감지 | 5 JSON 유효, 28개 MD **0 broken links**, `AGENTS.md` `5,262 B`, JPEG/SVG 정상 및 수치 100% 동기화 | **PASS** |
| **S3** | `SessionStart` 훅 (`cli-init.js --silent`, 공백 경로 5회) | `< 300ms` (`NFR-005`), 멱등성 | avg `99.1ms` | avg **`90.3ms`** (max `98.8ms`), `.gitignore` 중복 `1`회, `.agent`/`.agents` 미러링 정상 | **PASS** |
| **S4** | 라이브 Stdio MCP `check_ag_environment` (5회) | `< 500ms` (`NFR-005`), `stdout` 무오염 | avg **`652.9ms` (FAIL)** | avg **`149.9ms`** (max `171.8ms`, **4.3× 고속화**), `stderr: 0B`, `agy.exe` 자동 감지 | **PASS** |
| **S5-A** | `subscription.app_path` 명시적 오버라이드 | `agy` 플래그 유지 | `cliBinary: undefined` 결함 발견 | `inferCliBinaryFromPath()`로 `agy`/`antigravity`/`ag` 자동 추론 + `TC-U13` 추가 | **PASS** |
| **S5-B** | 라이브 Stdio MCP 전체 위임 + Windows `.cmd` + `stream-json` + 롤백 E2E | `VERIFIED` → 무손실 롤백 | `.cmd` `EINVAL` & `changedFiles` 기준선 노이즈 감지 | `delegationOk: true`, `agy-cli.log` 키 `[REDACTED]`, `changedFiles` 기준선 필터링, `rollbackOk: true` (WIP·untracked 100% 보존) | **PASS** |
| **S5-C** | `defaultCommandRunner` 실실행 & 셸 차단 정책 | `exitCode === 0`, 주입 100% 차단 | `npx tsc --noEmit` `exitCode: 0` | `exitCode: 0`, 위험 명령 5종 100% 차단 | **PASS** |
| **S6** | 호스트 `agy --help` 공식 플래그 호환성 | 5개 플래그 일치 | `--print`, `--mode`, `--print-timeout`, `--sandbox`, `--output-format stream-json` | 호스트 `agy.exe` 100% 일치 확인 | **PASS** |
| **S7** | 자동화 TDD 스위트 & 크로스플랫폼 CI | 6개 스위트 & 3-OS × Node 20/22 | 27개 → 33개 → 34개 | **6 스위트 / 35 테스트 100% 통과**, GitHub Actions **7 / 7 잡 PASS** | **PASS** |

---

## 3. 실측 감사로 발견·수정된 실제 결함 이력

1. **`check_ag_environment` `NFR-005` 지연 초과 (`652.9ms` → `149.9ms`):** `detector.ts` 순수 JS `findBinaryInPath()` 전환 및 `git-guard.ts` 단일 `git status --porcelain=v1 -b` 통합으로 **4.3× 고속화**.
2. **MCP 호스트 최소 `PATH` 환경에서 `agy` 미감지:** OS별 표준 설치 경로(`%LOCALAPPDATA%\agy\bin\agy.exe`, `~/.gemini/antigravity-cli/bin/agy`, `~/.local/bin/agy`) 폴백 추가.
3. **Windows Node 20.12+/24 `.cmd` 스폰 `EINVAL`:** `buildCliSpawnSpec()`에서 Windows `.cmd`/`.bat`만 `cmd.exe /d /s /c`로 안전 래핑.
4. **macOS/Ubuntu CI `findBinaryInPath` 구분자 오류:** 호스트 OS가 아닌 대상 `platform` 기준 `path.win32` / `path.posix` 명시 분기.
5. **`subscription.app_path` 명시 설정 시 `cliBinary` 누락 (`v1.1` 감사 발견):** `inferCliBinaryFromPath()` 추가로 커스텀 `agy.exe` 경로에서도 `--print --output-format stream-json` 플래그 정상 적용.
6. **`SubscriptionEngine` `changedFiles` 기준선 노이즈 (`v1.1` 감사 발견):** 위임 전부터 존재하던 `gitUntrackedBaseline` 및 `.agent/`·`.agents/` 핸드오프 템플릿을 `changedFiles` 집계에서 제외하여 보고 정확도 향상.
7. **`README.md` 및 `assets/performance-benchmarks.svg` 수치·설정 동기화 (`v1.1` 감사 발견):** 최신 테스트 수(`35 / 35`), 실측 지연(`149.9ms` / `90.3ms`), `agy_stream_heartbeat: true` 설정 반영 완료.
