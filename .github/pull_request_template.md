## Summary
<!-- 변경 목적 및 핵심 내용을 요약해 주세요. -->

- 

## Related Docs / Tasks
<!-- 관련 문서(PRD, ADR, Spec) 또는 task-checklist 태스크 ID를 기재해 주세요. -->

- Task IDs: 
- Docs: 

## Changes
- 

## Verification
- [ ] `npm --prefix server run typecheck` (0 errors)
- [ ] `npm --prefix server run build` — rebuilt `server/dist/index.js` · `cli-init.js` committed with any `server/src/` change (CI G6)
- [ ] `npm --prefix server test`
- [ ] `npm --prefix server run smoke:bundle` (committed bundle starts with no `node_modules`, CI G5)
- [ ] 보안 경계(`lockedPaths`, 비밀정보 마스킹) 및 문서-코드 동기화 확인
