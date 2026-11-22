# ADR-002: Subscription 우선 + Gemini API 폴백 듀얼 실행 엔진 아키텍처

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-002` |
| **상태** | `Accepted` |
| **결정일** | `2026-11-22` |
| **관련 문서** | [PRD](../01-planning/PRD.md), [듀얼 엔진 명세](../03-specs/execution-engines.md) |

---

## 1. 배경 (Context)

플러그인 사용자는 크게 두 그룹으로 나뉜다:
1. 로컬 머신에 Antigravity를 구독·설치하여 사용 중이며, 추가 API 종량 과금 없이 구독 쿼터와 내장 Browser Subagent(실제 브라우저 렌더링·스크린샷 검증)를 활용하고 싶은 개발자.
2. Antigravity 데스크톱 앱이 없거나 원격 SSH/WSL/CI 같은 헤드리스 환경에서 `GEMINI_API_KEY`만으로 즉시 위임 기능을 사용하고 싶은 개발자.

단일 모드만 지원할 경우 한쪽 사용자층이 배제되거나 불필요한 과금·설치 장벽이 발생한다.

## 2. 결정 (Decision)

공통 전략 인터페이스(`ExecutionEngine`) 뒤에 **Subscription Engine(`subscription.ts`)**과 **API Fallback Engine(`api-worker.ts`)**을 분리 배치하고, `execution_mode: "auto"` 기본값에서 **`subscription` 우선 감지 → 미감지 시 `api` 자동 폴백** 순서를 적용한다. 사용자가 `/ag-config mode <auto|subscription|api>`로 명시적 고정도 가능하게 한다.

## 3. 검토한 대안 (Alternatives Considered)

| 대안 | 장점 | 단점 및 기각 사유 |
| :--- | :--- | :--- |
| **Subscription 전용** | 구현 단순, 브라우저 검증 항상 보장 | 비구독자·원격 SSH/CI 환경에서 전혀 동작 불가 |
| **Gemini API 전용 (`claude-grok-build-plugin` 단일 방식)** | 헤드리스 환경에서 안정적 | Antigravity 구독자가 이중 과금 부담, 내장 Browser Subagent 시각적 검증 불가 |
| **Dual Engine + `auto` 감지 (채택)** | 무과금 구독 경험과 헤드리스 범용성을 모두 충족 | 두 엔진의 유지보수 및 테스트 범위 증가 → 공통 `ExecutionEngine` 계약과 `.ag-bridge/` 프로토콜로 결합도 최소화 |

## 4. 결과 및 트레이드오프 (Consequences)

- **긍정적 결과:**
  - `index.ts`와 `SKILL.md`는 동일한 MCP Tool(`delegate_to_antigravity`)을 유지하면서 환경에 최적화된 검증 기준(브라우저 스크린샷 vs `tsc`/빌드 통과)을 자동 분기한다.
  - 향후 Antigravity SDK 등 제3의 실행 엔진을 추가할 때도 `ExecutionEngine` 구현체만 추가하면 된다.
- **트레이드오프 및 대응:**
  - API 모드에서는 내장 브라우저 검증이 제공되지 않으므로, `SKILL.md`와 `report.md`에 "Browser E2E: SKIPPED (API mode)"와 "Build/Typecheck: PASS"를 명확히 구분 표기해 오해를 방지한다.
