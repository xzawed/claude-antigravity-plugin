# ADR-001: 파일 기반 `.ag-bridge/` SSOT 프로토콜 채택

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-001` |
| **상태** | `Accepted` |
| **결정일** | `2026-11-22` |
| **관련 문서** | [브릿지 프로토콜](../02-architecture/bridge-protocol.md) |

---

## 1. 배경 (Context)

Claude Code(내장 MCP 서버)와 로컬 Antigravity 에이전트(또는 내장 API 워커) 사이에 작업 지시, 진행 상태, 검증 결과, 스크린샷 아티팩트를 교환할 통신 매체가 필요하다. 로컬 에이전트 환경은 macOS·Windows·Linux 전반에 걸쳐 GUI 앱, CLI, 헤드리스 컨테이너 등 실행 형태가 다양하다.

## 2. 결정 (Decision)

대상 워크스페이스 루트에 `.ag-bridge/` 디렉터리를 생성(자동으로 `.gitignore` 등록)하고, `manifest.json` · `dispatch.md` · `report.md` · `artifacts/` 파일을 **단일 진실 공급원(SSOT)**으로 사용하는 파일 기반 브릿지 프로토콜을 채택한다. 상태 파일 갱신은 임시 파일 기록 후 `rename`하는 원자적 쓰기로 구현한다.

## 3. 검토한 대안 (Alternatives Considered)

| 대안 | 장점 | 단점 및 기각 사유 |
| :--- | :--- | :--- |
| **로컬 HTTP / WebSocket 서버** | 실시간 양방향 이벤트 스트리밍 가능 | 포트 충돌·방화벽 이슈, 로컬 Antigravity 앱이 임의 로컬 포트 호출을 기본 지원하지 않음 |
| **OS Named Pipe / Unix Domain Socket** | 저지연 프로세스 간 통신 | Windows/POSIX 간 구현 분기 복잡, 크래시 시 상태 복구 및 사람에 의한 디버깅 불가 |
| **파일 기반 `.ag-bridge/` (채택)** | 모든 OS·에이전트에서 추가 의존성 없이 읽기/쓰기 가능, 마크다운/JSON으로 완전한 가시성·감사 추적 | `fs.watch` 지연 및 부분 읽기 가능성 → 원자적 쓰기 + 2초 폴링 하이브리드로 해결 |

## 4. 결과 및 트레이드오프 (Consequences)

- **긍정적 결과:**
  - Claude Code와 Antigravity 모두 기본 파일 읽기/쓰기 도구만으로 즉시 프로토콜에 참여할 수 있다.
  - 개발자가 `.ag-bridge/dispatch.md`와 `report.md`를 직접 열어 위임 내용과 스크린샷을 투명하게 검수할 수 있다.
  - Subscription 모드와 API 모드가 동일한 브릿지 포맷을 공유하므로 결과 회수 및 롤백 로직이 100% 일원화된다.
- **트레이드오프 및 대응:**
  - `.ag-bridge/`가 실수로 Git에 커밋될 위험 → `cli-init.ts`와 `bridge-fs.ts`가 `.gitignore` 등록을 자동 보장한다. *(등록 위치는 [ADR-005](./ADR-005-local-git-exclude.md)가 대체 — git 저장소는 로컬 전용 `.git/info/exclude`, 아니면 `.gitignore`.)*
  - 비정상 종료 시 상태 잔류 위험 → `updatedAt` + `timeout_sec` 기반 Stale Lock 자동 감지/아카이브를 적용한다.
