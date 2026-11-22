# ADR-003: Antigravity CLI(`agy`/`antigravity`) 및 `.agent`/`.agents` 호환 전략

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-003` |
| **상태** | `Accepted` |
| **결정일** | `2026-11-22` |
| **관련 문서** | [듀얼 엔진 명세](../03-specs/execution-engines.md), [프롬프트 & 커맨드 명세](../03-specs/prompts-and-commands.md) |

---

## 1. 배경 (Context)

원본 기술 명세(`claude_antigravity_plugin_spec_md.md`)는 다음과 같이 로컬 Antigravity 환경을 가정한다:
- CLI 바이너리: `antigravity` 또는 `ag`
- 워크플로우 배포 경로: `<target-workspace>/.agent/workflows/claude-handoff.md`

그러나 실제 최신 Google Antigravity 생태계(Antigravity CLI, Antigravity 2.0, Antigravity IDE)에서는:
1. 공식 CLI 명령어가 **`agy`**이며(구버전·별칭 환경에서 `antigravity` 또는 `ag` 사용 가능),
2. 워크스페이스 커스터마이징 자동 탐색 경로가 **`.agents/`**(및 하위 호환 `.agent/`)를 우선 지원한다.
3. OS·버전에 따라 CLI 비대화형 워크플로우 인자 규격이 다르거나 데스크톱 GUI 앱만 설치된 환경도 존재한다.

## 2. 결정 (Decision)

원본 명세의 인터페이스를 보존하면서도 실제 Antigravity 환경에서 실패하지 않도록 **다중 탐색 및 점진적 폴백(Progressive Fallback) 전략**을 채택한다.

1. **CLI 바이너리 탐색 순서 (`detector.ts`):**
   - `config.subscription.app_path` 사용자 지정 경로 → `agy` → `antigravity` → `ag` → OS별 데스크톱 앱 기본 경로 순으로 탐색한다.
2. **워크플로우 배포 호환성 (`cli-init.ts`, `subscription.ts`):**
   - 원본 명세의 기본 배포 경로인 `.agent/workflows/claude-handoff.md`에 항상 배포한다.
   - 대상 프로젝트에 이미 `.agents/` 디렉터리가 존재하는 경우 `.agents/workflows/claude-handoff.md`도 동기화 여부를 점검(또는 안내)하여 Antigravity 2.0/IDE/CLI 어느 환경에서도 핸드오프 문서를 즉시 참조할 수 있게 한다.
3. **3단계 트리거 폴백 체인 (`subscription.ts`):**
   - **1차:** 감지된 CLI 바이너리(`agy` / `antigravity`)로 워크스페이스 세션 트리거 시도.
   - **2차:** CLI 미지원/실패 시 OS별 GUI IPC(macOS AppleScript, Windows PowerShell, Linux xdotool) 폴백.
   - **3차:** IPC도 불가한 환경에서는 핸드오프 명령을 클립보드에 복사 + 데스크톱 알림 발송 후 `.ag-bridge/manifest.json` 감시를 유지하여 반자동 완주를 보장한다.

## 3. 검토한 대안 (Alternatives Considered)

| 대안 | 장점 | 단점 및 기각 사유 |
| :--- | :--- | :--- |
| **원본 명세(`antigravity` + `.agent/`만) 하드코딩** | 코드 단순 | `agy` CLI만 설치된 실제 Antigravity 환경에서 구독 감지 실패 및 불필요한 API 폴백 발생 |
| **`agy` 전용으로 원본 명세 변경** | 최신 CLI에 최적화 | 기존 `antigravity` 바이너리/별칭 및 GUI 전용 사용자 호환성 상실 |
| **다중 바이너리 감지 + 3단계 폴백 + 설정 오버라이드 (채택)** | 모든 버전·OS·설치 형태 대응 | 감지기/트리거 단위 테스트 케이스 추가 필요 (허용 가능한 수준) |

## 4. 결과 및 트레이드오프 (Consequences)

- **긍정적 결과:** Antigravity CLI(`agy`), Antigravity 2.0 데스크톱 앱, Antigravity IDE 어느 환경에서도 `auto` 감지와 핸드오프가 안정적으로 동작한다.
- **트레이드오프:** `config.subscription.app_path` 및 `trigger_method`를 통해 사용자가 특정 환경에서 감지를 명시적으로 고정할 수 있도록 문서를 제공한다.
