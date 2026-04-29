# Content Creation Implementation Notes

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Batch Summary

This first implementation pass intentionally stayed small. It closed safe P1 routing/scope issues discovered during the audit without attempting the larger source/provenance, tenant-shared reference, editorial lifecycle, iOS, portal, or full-product smoke work.

## Changes Applied

1. Content discovery route guard
   - `POST /api/v1/content/discover` now calls `ensureValidContentRouteScope()` before importing/running discovery.
   - This prevents invalid authenticated user scope from reaching an AI-spending path.

2. Content reference route guard
   - Books, channels, and Voice DNA reference routes now receive and use the shared Content route-scope guard.
   - The guard covers list/create/delete/upsert operations.

3. Content learning route guard
   - Content learning routes now add a scoped middleware before topic generation, topic feedback, pending topics, weekly packages, taste profile, performance, learned patterns, artifact chain, and recent scripts.

4. Content dedup provider routing
   - `isDuplicateIdea()` no longer posts directly to Anthropic.
   - It now uses `completeOneShotWithFallback()` with category `content_dedup`.
   - Anthropic remains available only through the existing gated fallback thunk.
   - The dedup cache key now includes resolved user scope so one user's duplicate decision cannot be reused for another user.
   - Call sites in discovery and workflow pass explicit `userId`.

5. Model-routing copy drift
   - The script route comment no longer claims the canonical path is fixed to Claude Sonnet. It now describes the TypeScript AI proxy live routing path.

6. Python content-engine scoped provider metadata
   - The internal AI proxy now accepts optional `userId` and `tenantId` fields.
   - Provider cascade options receive normalized scope ids for usage attribution.
   - Python `ask_claude()` and `ask_claude_json()` can forward `user_id` and `tenant_id`.
   - Script generation forwards `user_id` from the TypeScript Content script request into the Python script writer and then to the internal AI proxy.

7. Scoped content workflow helper contracts
   - `updateFeedback()`, `markScriptGenerated()`, and `getTopicById()` now accept optional `userId`.
   - App-facing learning routes now pass `userId` into feedback mutation.
   - Legacy Telegram callback callers remain backward compatible through the optional argument, but are still listed as follow-up until that path has explicit owner scope.

## Tests Added Or Updated

Added:

- `__tests__/services/content-dedup-routing.test.ts`

Updated:

- `__tests__/api/internal-routes.test.ts`
- `__tests__/api/content-home-route.test.ts`
- `__tests__/api/content-reference-routes.test.ts`
- `__tests__/api/content-learning-routes.test.ts`
- `__tests__/services/python-engine-hardening.test.ts`
- `__tests__/services/content-workflow-user-scope.test.ts`

## Validation

Commands run:

```bash
npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/content-workflow-user-scope.test.ts
npm run typecheck
npm test -- --run __tests__/api/content-learning-routes.test.ts __tests__/api/content-reference-routes.test.ts __tests__/services/content-dedup-routing.test.ts
npm test -- --run __tests__/api/internal-routes.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/content-reference-routes.test.ts __tests__/services/content-dedup-routing.test.ts
npm run typecheck
npm test -- --run __tests__/services/content-workflow-user-scope.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/internal-routes.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/services/content-dedup-routing.test.ts
npm run typecheck
```

Results:

- Focused Content route/workflow/dedup suite passed: 5 files / 24 tests.
- Typecheck passed.
- Post-typecheck focused regression passed: 3 files / 19 tests.
- Internal AI proxy/Python metadata regression passed: 5 files / 83 tests.
- Final typecheck passed.
- Scoped content workflow helper regression passed: 5 files / 81 tests.
- Final typecheck after scoped helper changes passed.

## Local Smoke

No local full-product smoke was run in this batch.

Reason: this pass changed backend route guards and provider-routing plumbing only. Full local product smoke remains a later gate after the source/provenance, lifecycle, iOS, and Secretary scheduling work is implemented.

## Release-Gate Verdict

Verdict: NO-GO for the full Content Creation release.

This batch reduced P1 risk, but important release blockers remain:

- Full tenant-owned Content reference model is not implemented.
- Python content-engine proxy now forwards optional user metadata for script generation, but true tenant metadata is still blocked until Content requests carry real active tenant IDs.
- Portal/admin Content surfaces are still platform-global and need policy/hardening before tenant-admin use.
- Legacy Telegram Content workflow callbacks still use backward-compatible id-only helper calls.
- Content source/provenance model is missing.
- Superseded by the production-candidate pass: Content-to-Secretary scheduling intents and the backend Secretary ledger handoff are implemented for `requestContentScheduleThroughSecretary()`. Provider-backed staging calendar smoke remains separate.
- Skill memory/version tracking is still docs-only.
- iOS and portal readiness for richer Content states is not implemented.
- Local full-product smoke has not been run.
