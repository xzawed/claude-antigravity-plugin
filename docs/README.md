# Documentation Hub (`docs/`)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `DOC-INDEX` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **적용 표준** | [안티그래비티 개발 표준 문서 작성안](./00-standards/documentation-standard.md) |

본 디렉터리는 `claude-antigravity-plugin`의 기획, 아키텍처, 상세 명세, 구현 계획, 검증 및 의사결정 기록(ADR)을 **안티그래비티 개발 표준 문서 체계**에 따라 배치한 단일 진실 공급원(SSOT)입니다.

---

## 1. 문서 맵 (Document Map)

| 분류 | 문서 ID | 파일 | 핵심 내용 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| **00. 표준** | `STD-001` | [documentation-standard.md](./00-standards/documentation-standard.md) | 폴더 구조, 메타데이터, 작성 규칙, Mermaid 규칙, 에이전트 연동 표준 | `Approved` |
| **01. 기획** | `PLN-001` | [PRD.md](./01-planning/PRD.md) | 배경, 목표, 페르소나, 기능/비기능 요구사항(FR/NFR), 범위, 성공 지표 | `Approved` |
| **01. 기획** | `PLN-002` | [user-flows.md](./01-planning/user-flows.md) | 자동/수동 위임, 설정, 진단, 롤백, 장애 복구 시나리오 및 엣지 케이스 | `Approved` |
| **02. 아키텍처** | `ARC-001` | [system-architecture.md](./02-architecture/system-architecture.md) | 전체 아키텍처, 디렉터리 스캐폴딩, 모듈 의존성, 크로스플랫폼 전략 | `Approved` |
| **02. 아키텍처** | `ARC-002` | [bridge-protocol.md](./02-architecture/bridge-protocol.md) | `.ag-bridge/` 파일 구조, 상태 머신, 원자적 I/O, 동시성/타임아웃 복구 | `Approved` |
| **02. 아키텍처** | `ARC-003` | [security-and-git-guard.md](./02-architecture/security-and-git-guard.md) | `lockedPaths` 보안 검증, 셸 샌드박싱, 비밀정보 보호, Git 체크포인트/롤백 | `Approved` |
| **03. 상세 명세** | `SPC-001` | [mcp-tools-api.md](./03-specs/mcp-tools-api.md) | MCP Tool 3종 입출력 스키마, 에러 코드 카탈로그, 환경변수/설정 우선순위 | `Approved` |
| **03. 상세 명세** | `SPC-002` | [execution-engines.md](./03-specs/execution-engines.md) | `detector.ts`, `subscription.ts`, `api-worker.ts` 상세 로직 및 인터페이스 | `Approved` |
| **03. 상세 명세** | `SPC-003` | [prompts-and-commands.md](./03-specs/prompts-and-commands.md) | `SKILL.md`, `/ag-delegate`, `/ag-config`, `/ag-status`, `claude-handoff.md` 명세 | `Approved` |
| **04. 구현** | `IMP-001` | [implementation-plan.md](./04-implementation/implementation-plan.md) | Phase 1~4 마일스톤, WBS, 모듈별 완료 기준(DoD), 리스크 대응 | `Approved` |
| **04. 구현** | `IMP-002` | [task-checklist.md](./04-implementation/task-checklist.md) | 구현 및 검증을 단계별로 추적하는 실행 체크리스트 | `Active` |
| **04. 구현** | `IMP-003` | [session-handoff.md](./04-implementation/session-handoff.md) | 세션 간 컨텍스트 인계서 및 다음 세션 착수 가이드 | `Active` |
| **05. 검증** | `VER-001` | [test-and-qa-plan.md](./05-verification/test-and-qa-plan.md) | 단위/통합/보안/크로스플랫폼 테스트 매트릭스 및 출시 게이트 | `Approved` |
| **05. 검증** | `VER-002` | [verification-report.md](./05-verification/verification-report.md) | 실측 벤치마크, 발견 결함 수정 및 TDD 확장 검증 리포트 | `Approved` |
| **06. ADR** | `ADR-IDX` | [06-adr/README.md](./06-adr/README.md) | 아키텍처 의사결정 기록 인덱스 및 템플릿 (`ADR-001` ~ `ADR-003`) | `Approved` |

---

## 2. 역할별 권장 읽기 순서

- **신규 참여자 / 기획 리뷰어:** `PRD.md` → `user-flows.md` → `system-architecture.md`
- **MCP 서버 & 엔진 개발자(에이전트):** `AGENTS.md` → `bridge-protocol.md` → `security-and-git-guard.md` → `mcp-tools-api.md` → `execution-engines.md` → `implementation-plan.md`
- **프롬프트 / Claude 플러그인 작성자:** `prompts-and-commands.md` → `user-flows.md` → `ADR-003`
- **QA / 검증 담당자:** `test-and-qa-plan.md` → `security-and-git-guard.md` → `task-checklist.md`
