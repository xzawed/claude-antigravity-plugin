# ADR-004: 미리 빌드된 자체완결 서버 번들을 저장소에 커밋

| 항목 | 내용 |
| :--- | :--- |
| **문서 ID** | `ADR-004` |
| **상태** | `Accepted` |
| **결정일** | `2026-11-24` |
| **관련 문서** | [시스템 아키텍처](../02-architecture/system-architecture.md), [테스트 & QA 계획](../05-verification/test-and-qa-plan.md) |

---

## 1. 배경 (Context)

`.mcp.json`은 `node "${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"`를, `hooks/hooks.json`은 `node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli-init.js" --silent`를 실행한다. 그런데 `server/dist/`는 `.gitignore`로 제외돼 한 번도 커밋된 적이 없었고, 의존성(`@modelcontextprotocol/sdk`·`@google/genai`·`zod`)도 설치본에 없다.

마켓플레이스 설치(`/plugin marketplace add xzawed/claude-antigravity-plugin` → `/plugin install`)는 저장소를 커밋된 그대로 플러그인 캐시에 복사할 뿐 `npm install`·`npm run build`를 돌리지 않는다. 그래서 v1.4.0까지는 GitHub에서 설치하거나 업데이트할 때마다 MCP 서버와 SessionStart 훅이 모두 `Cannot find module …/server/dist/index.js`로 실패했다. 캐시 안에서 손으로 빌드하면 동작하지만, 다음 업데이트가 새 캐시 디렉터리를 깔면서 그 빌드는 사라진다.

## 2. 결정 (Decision)

1. **esbuild로 두 진입점만 번들한다 (`server/build.mjs`).** `src/index.ts` → `dist/index.js`, `src/cli-init.ts` → `dist/cli-init.js`. `bundle: true`, `platform: 'node'`, `format: 'esm'`, `target: 'node20'`(`engines.node`와 같은 하한), 번들 안의 CommonJS가 쓰는 `require`는 `createRequire` 배너로 제공한다. 두 진입점은 각자 `import.meta.url` 직접 실행 가드를 가지므로 별개 번들로 유지한다.
2. **두 파일만 커밋한다.** `.gitignore`는 `server/dist/*`를 제외하되 `!server/dist/index.js`·`!server/dist/cli-init.js`로 되살린다. `.gitattributes`가 LF를 고정하고 생성 파일로 표시한다.
3. **타입 검사는 `tsc --noEmit`으로 분리한다.** esbuild는 타입을 검사하지 않으므로 `npm run typecheck`(G1)가 계속 그 역할을 한다.
4. **CI가 두 가지를 막는다.**
   - **G5:** `npm ci` *전에* `server/scripts/smoke-bundle.mjs`가 (1) 두 번들이 Node 내장 모듈만 참조하는지 정적으로 검사하고(`scripts/bundle-scan.mjs` — 0열 `import`, esbuild의 `__require("x")`, 리터럴 `import("x")`; ws·debug가 `try/catch`로 감싼 선택 모듈 3개만 허용), (2) `NODE_PATH`를 지운 환경에서 번들을 띄워 MCP `initialize` + `tools/list`(12개)와 공백 포함 경로의 `cli-init`을 확인한다. 기동만으로는 증명이 안 된다 — 배너의 `createRequire`가 만든 `require()`는 `NODE_PATH`와 Node 전역 폴더도 뒤지므로, 실행기 환경이 번들이 빠뜨린 의존성을 채워 줄 수 있다(ESM `import`는 `NODE_PATH`를 보지 않는다. 둘 다 2026-11-24 실측: `NODE_PATH`로 zod를 대 주면 정적 검사 없는 스모크는 통과했다).
   - **G6:** 빌드 뒤 `git diff --exit-code -- server/dist/index.js server/dist/cli-init.js` — 커밋된 번들이 새 빌드와 다르면 실패한다.
5. **계산된 `import(<식>)`·`require(<식>)`는 빌드에서 막는다.** esbuild는 이런 호출을 번들하지 않고 남기면서 기본값으로는 경고조차 내지 않는다(실측). `build.mjs`가 `unsupported-dynamic-import`·`unsupported-require-call`을 오류로 올린다.

## 3. 검토한 대안 (Alternatives Considered)

| 대안 | 장점 | 단점 및 기각 사유 |
| :--- | :--- | :--- |
| **`tsc` 산출물(`dist/` 전체)을 커밋** | 빌드 도구 변경 없음 | 의존성이 번들되지 않아 `node_modules` 없이는 여전히 `ERR_MODULE_NOT_FOUND` |
| **`dist/` + `node_modules/` 커밋** | 빌드 변경 없음 | 수천 개 파일·플랫폼별 바이너리를 저장소에 넣게 되고 리뷰·감사가 불가능 |
| **훅이 첫 실행 때 `npm ci && npm run build`를 수행** | 저장소에 산출물 없음 | 세션 시작마다 네트워크·수십 초 지연, 오프라인/프록시 환경에서 실패, 실행 중인 캐시를 훅이 고치는 구조 |
| **npm 패키지로 배포 후 `npx`로 실행** | 표준 배포 경로 | 별도 레지스트리 게시·버전 동기화가 필요하고, 첫 실행이 네트워크에 의존 |
| **esbuild 자체완결 번들 커밋 + CI 드리프트 검사 (채택)** | 설치·업데이트에 빌드 불필요, 의존성 버전이 lockfile로 고정된 채 배포 | 번들(약 3 MB)이 저장소에 들어가고, `src` 변경 시 재빌드·커밋을 잊으면 CI가 실패 |

같은 작성자의 `claude-grok-build-plugin`이 이미 같은 방식(`mcp-server/build.mjs` + `.gitignore` 예외)으로 마켓플레이스 설치를 동작시키고 있다.

## 4. 결과 및 트레이드오프 (Consequences)

- **긍정적 결과:** GitHub 마켓플레이스 설치와 업데이트가 추가 단계 없이 동작한다. 로컬 클론 사용자의 `npm install`·`npm run build`는 선택 사항이 된다(`npm run verify`만 `node_modules`가 필요하다).
- **트레이드오프:** `server/src/`를 고치는 PR은 재빌드한 두 파일을 함께 커밋해야 한다(AGENTS.md 불변식 7). 의존성 업데이트도 번들 diff를 만든다.
- **검증:** G5·G6 — [테스트 & QA 계획](../05-verification/test-and-qa-plan.md) §2.4.
