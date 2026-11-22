# 안티그래비티 개발 표준 문서 작성안 (Documentation Standard)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `STD-001` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **작성자** | Architecture & Planning |
| **관련 문서** | [AGENTS.md](../../AGENTS.md), [docs/README.md](../README.md) |

---

## 1. 목적 및 기본 원칙

본 문서는 **Antigravity 에이전트와 인간 개발자가 협업하는 프로젝트**에서 문서를 일관되게 작성·구조화·유지보수하기 위한 개발 표준을 정의한다.

### 1.1 핵심 5대 원칙
1. **Progressive Disclosure (점진적 정보 공개):** AI 에이전트의 컨텍스트 윈도우 낭비를 방지하기 위해 루트 `AGENTS.md`는 간결한 규칙과 문서 인덱스만 유지하고(권장 `24 KB` 이하), 상세 설계는 `docs/` 하위 영역별 문서로 분리한다.
2. **Single Source of Truth (SSOT):** 동일 스키마·에러 코드·상태 머신을 여러 문서에 중복 정의하지 않고, 소유 문서(Owner Doc)에 1회 정의한 뒤 상대 경로 링크로 참조한다.
3. **Executable Clarity (구현 가능한 명확성):** 모호한 서술 대신 TypeScript 타입, JSON 스키마, 상태 전이표, 명확한 에러 코드와 수용 기준(Acceptance Criteria)으로 작성한다.
4. **Traceability (추적 가능성):** 모든 요구사항(`FR-*`, `NFR-*`)은 설계 문서(`ARC-*`, `SPC-*`), 구현 태스크(`T-*`), 테스트 케이스(`TC-*`)로 상호 추적 가능해야 한다.
5. **Living Documentation (코드와 문서의 동기화):** 인터페이스·프로토콜·폴더 구조 변경 시 동일 PR/작업 단위에서 문서를 함께 갱신한다.

---

## 2. 표준 문서 폴더 구조

Antigravity 프로젝트는 라이프사이클 순서에 따라 번호가 부여된 7개 표준 디렉터리와 루트 `AGENTS.md`를 배치한다.

```text
<project-root>/
├── AGENTS.md                       # [필수] Antigravity Always-On 프로젝트 규칙 & 문서 네비게이션
├── README.md                       # [필수] 사람 중심 프로젝트 개요 및 빠른 시작
└── docs/
    ├── README.md                   # [필수] 문서 허브 (전체 목차 및 역할별 읽기 가이드)
    ├── 00-standards/               # 문서 작성 표준, 코딩 컨벤션, Git/PR 규칙
    ├── 01-planning/                # PRD, 사용자 여정, 요구사항 및 범위 정의
    ├── 02-architecture/            # 시스템 아키텍처, 프로토콜, 데이터 모델, 보안 설계
    ├── 03-specs/                   # API/MCP 스키마, 모듈 상세 명세, 프롬프트/CLI 명세
    ├── 04-implementation/          # 마일스톤 구현 계획(WBS), 실행 체크리스트
    ├── 05-verification/            # 테스트 전략, QA 매트릭스, 릴리스 체크리스트
    └── 06-adr/                     # Architecture Decision Records (중요 기술 의사결정)
```

### 2.1 디렉터리별 역할과 산출물 기준

| 디렉터리 | 접두사(ID) | 주요 산출물 | 소유 책임 |
| :--- | :--- | :--- | :--- |
| `00-standards/` | `STD-###` | 문서화 표준, 코드 스타일, 브랜치 전략 | 프로젝트 거버넌스 |
| `01-planning/` | `PLN-###` | `PRD.md`, `user-flows.md` | 무엇을·왜 만드는가 |
| `02-architecture/` | `ARC-###` | `system-architecture.md`, 프로토콜/보안 설계 | 전체 구조 및 불변 제약 |
| `03-specs/` | `SPC-###` | API/MCP 명세, 엔진·프롬프트 상세 명세 | 구현 가능한 인터페이스 계약 |
| `04-implementation/` | `IMP-###` | `implementation-plan.md`, `task-checklist.md` | 단계별 실행 순서 및 완료 기준 |
| `05-verification/` | `VER-###` | `test-and-qa-plan.md`, 검증 리포트 | 품질 보증 및 릴리스 게이트 |
| `06-adr/` | `ADR-###` | `ADR-001-*.md`, `ADR-002-*.md` | 대안 비교 및 결정 근거 |

---

## 3. 문서 네이밍 및 메타데이터 규약

### 3.1 파일 네이밍 규칙
- 디렉터리: `NN-lowercase-kebab` (예: `02-architecture`)
- 일반 문서: `lowercase-kebab-case.md` (단, 업계 관례 문서인 `README.md`, `AGENTS.md`, `PRD.md`는 대문자 허용)
- ADR 문서: `ADR-NNN-short-kebab-title.md` (3자리 0-padding, 예: `ADR-001-file-based-ag-bridge.md`)

### 3.2 표준 메타데이터 헤더
`docs/` 하위의 모든 문서는 제목(`# ...`) 바로 아래에 다음 표준 메타데이터 표를 포함한다.

```markdown
| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `SPC-001` |
| **버전** | `1.0.0` |
| **상태** | `Draft` / `Review` / `Approved` / `Active` / `Deprecated` |
| **최종 수정일** | `YYYY-MM-DD` |
| **관련 문서** | `[PRD](../01-planning/PRD.md)` |
```

### 3.3 문서 상태 라이프사이클
- `Draft`: 초안 작성 중 (구현 착수 불가)
- `Review`: 검토 및 기술 타당성 검증 중
- `Approved`: 승인 완료, 구현 기준으로 사용 가능
- `Active`: 체크리스트/로드맵 등 지속적으로 갱신되는 살아있는 문서
- `Deprecated`: 대체 문서로 이관됨 (상단에 대체 문서 링크 명시 필수)

---

## 4. 마크다운 및 다이어그램 작성 규약

### 4.1 구조 및 서식
- **헤딩 계층:** H1(`#`)은 문서당 1회만 사용하고, H2(`##`) → H3(`###`) 순서를 건너뛰지 않는다.
- **표 활용:** 요구사항, 스키마 필드, 에러 코드, 비교 매트릭스는 산문 대신 GFM 표로 정리한다.
- **요구사항/태스크 ID 부여:**
  - 기능 요구사항: `FR-001`, `FR-002` ...
  - 비기능 요구사항: `NFR-001`, `NFR-002` ...
  - 구현 태스크: `T-101`, `T-201` ... (Phase 번호 반영)
  - 테스트 케이스: `TC-U01`(단위), `TC-I01`(통합), `TC-S01`(보안), `TC-E01`(E2E)
- **강조 블록(GitHub Alerts):** 핵심 주의사항만 선별적으로 사용하며 중첩하거나 연속 배치하지 않는다.
  - `> [!NOTE]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`

### 4.2 Mermaid 다이어그램 규칙
- 허용 다이어그램 타입: `flowchart TD/LR`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`
- 괄호`()`, 대괄호`[]`, 특수문자가 포함된 노드 라벨은 반드시 큰따옴표로 감싼다.
  - 올바른 예: `A["MCP Server (server/dist/index.js)"]`
  - 잘못된 예: `A[MCP Server (server/dist/index.js)]`
- HTML 태그(`<br/>` 등) 사용을 지양하고 간결한 텍스트 라벨을 유지한다.

---

## 5. Antigravity 에이전트 협업 및 아티팩트 승격 규칙

### 5.1 임시 아티팩트 vs 영구 문서
Antigravity 세션 중 생성되는 브레인 아티팩트(`implementation_plan.md`, `walkthrough.md` 등)는 세션 단위 작업 기록이다. 다음 조건을 만족하면 저장소의 `docs/`로 승격(Promote)하여 버전 관리한다.
- 아키텍처·프로토콜·인터페이스가 변경된 경우 → `docs/02-architecture/`, `docs/03-specs/` 갱신
- 중요한 기술적 트레이드오프를 결정한 경우 → `docs/06-adr/ADR-NNN-*.md` 추가
- 마일스톤 진행 상태가 변경된 경우 → `docs/04-implementation/task-checklist.md` 체크박스 갱신

### 5.2 에이전트 컨텍스트 최적화 규칙
- `AGENTS.md`는 항상 로드되므로 **24,000 bytes 미만**으로 유지한다(Antigravity 단일 Rule 파일 상한 준수).
- 긴 코드 스니펫이나 방대한 프롬프트 전문은 `AGENTS.md`에 넣지 않고 `docs/03-specs/`로 분리하여 필요할 때만 읽도록 한다.
- 모든 문서 간 참조는 저장소 루트 또는 현재 파일 기준의 유효한 상대 경로 링크를 사용한다.
