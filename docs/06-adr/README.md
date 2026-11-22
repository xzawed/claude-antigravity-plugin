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
