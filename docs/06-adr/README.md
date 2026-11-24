# Architecture Decision Records (ADR)

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-IDX` |
| **버전** | `1.0.0` |
| **상태** | `Approved` |
| **최종 수정일** | `2026-11-22` |
| **관련 문서** | [문서 작성 표준](../00-standards/documentation-standard.md), [시스템 아키텍처](../02-architecture/system-architecture.md) |

본 디렉터리는 `claude-antigravity-plugin` 설계 과정에서 내린 주요 아키텍처 의사결정과 그 배경·대안·결과를 기록한다.

---

## ADR 목록

| ADR ID | 제목 | 상태 | 결정일 | 요약 |
| :--- | :--- | :---: | :--- | :--- |
| [ADR-001](./ADR-001-file-based-ag-bridge.md) | 파일 기반 `.ag-bridge/` SSOT 프로토콜 채택 | `Accepted` | `2026-11-22` | 소켓/HTTP IPC 대신 파일 기반 브릿지를 채택하여 투명성·디버깅성·도구 독립성 확보 |
| [ADR-002](./ADR-002-dual-execution-engine.md) | Subscription 우선 + Gemini API 폴백 듀얼 엔진 아키텍처 | `Accepted` | `2026-11-22` | 로컬 구독자 무과금·브라우저 검증과 비구독/헤드리스 환경 범용성을 단일 인터페이스로 통합 |
| [ADR-003](./ADR-003-antigravity-cli-and-paths.md) | Antigravity CLI(`agy`/`antigravity`) 및 `.agent`/`.agents` 호환 전략 | `Accepted` | `2026-11-22` | 현행 Antigravity CLI(`agy`)·2.0 앱 환경과 원본 스펙(`.agent/workflows/`) 간 호환성 확보 |
| [ADR-004](./ADR-004-prebuilt-server-bundle.md) | 미리 빌드된 자체완결 서버 번들을 저장소에 커밋 | `Accepted` | `2026-11-24` | 마켓플레이스 설치는 빌드를 돌리지 않으므로 esbuild 번들 두 개를 커밋하고 CI가 드리프트·무의존 기동을 검사 |
| [ADR-005](./ADR-005-local-git-exclude.md) | 워크스페이스 git 무시 등록은 `.git/info/exclude`로 — 훅은 프로그램을 실행하지 않는다 | `Accepted` | `2026-11-24` | 사용자 저장소의 추적 파일 `.gitignore`를 고치지 않고, 자동 실행 훅에서 `git`을 띄우지 않으며 링크를 따라 쓰지 않음 (ADR-001의 `.gitignore` 등록을 부분 대체) |

---

## 새 ADR 작성 템플릿

새 결정을 추가할 때는 `ADR-NNN-short-kebab-title.md` 형식으로 아래 구조를 따른다.

```markdown
# ADR-NNN: 결정 제목

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-NNN` |
| **상태** | `Proposed` / `Accepted` / `Superseded` |
| **결정일** | `YYYY-MM-DD` |

## 1. 배경 (Context)
## 2. 결정 (Decision)
## 3. 검토한 대안 (Alternatives Considered)
## 4. 결과 및 트레이드오프 (Consequences)
```
