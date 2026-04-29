# Content Creation Open Blockers

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## P0 Production Blockers

None proven as an immediate exploit in this audit pass.

Important release-copy restriction: do not claim full tenant-shared Content memory, tenant-owned reference libraries, or tenant-safe creative intelligence until the P1 tenant/scope items below are fixed and tested.

## P1 Must Fix Before Content Creation Release

1. Content dedup must stop bypassing live model routing. - CLOSED IN CODE, NEEDS BROADER REGRESSION
   - Evidence: `src/services/content-dedup.ts` direct Anthropic API call.
   - Applied: `isDuplicateIdea()` now uses `completeOneShotWithFallback()` with category `content_dedup`, user-scoped cache keys, and explicit userId call sites.
   - Validation: `__tests__/services/content-dedup-routing.test.ts` passed.

2. Content discovery route must use consistent user-scope validation. - CLOSED IN CODE
   - Evidence: `/api/v1/content/discover` in `src/api/routes/content.ts` does not call `ensureValidContentRouteScope`.
   - Applied: route now validates `content_route_discover` before importing/running discovery.
   - Validation: invalid-scope route test passed.

3. Content reference routes need explicit route-scope validation. - CLOSED IN CODE
   - Evidence: `registerContentReferenceRoutes(router)` receives no guard.
   - Applied: books/channels/Voice DNA routes now receive and call `ensureValidContentRouteScope`.
   - Validation: `__tests__/api/content-reference-routes.test.ts` passed.

4. Content learning routes need explicit route-scope validation. - CLOSED IN CODE
   - Evidence: `registerContentLearningRoutes(router, resolveContentLanguage)` previously had no shared guard.
   - Applied: route-level learning middleware validates `content_route_learning` before all learning endpoints.
   - Validation: `__tests__/api/content-learning-routes.test.ts` passed.

5. Python content-engine AI proxy needs tenant/user-safe metadata. - PARTIALLY CLOSED IN CODE
   - Evidence: `content-engine/services/claude_client.py` body includes prompt/system/category, not tenant/user/scope.
   - Applied: internal AI proxy accepts normalized `userId`/`tenantId`; Python `ask_claude()` forwards optional `user_id`/`tenant_id`; script generation passes `user_id`.
   - Remaining: true `tenant_id` is not available in the Content script request path yet. Do not claim full tenant-level provider attribution until active tenant metadata is propagated.

6. Id-only content helper mutations need scoped contracts. - PARTIALLY CLOSED IN CODE
   - Evidence: `updateFeedback`, `markScriptGenerated`, `getTopicById`, `removeChannel`, `updateChannelStatus`.
   - Applied: `updateFeedback`, `markScriptGenerated`, and `getTopicById` now accept optional `userId`; app-facing learning route passes userId; tests prove cross-user mutation/read denial when userId is provided.
   - Remaining: legacy Telegram Content workflow callbacks still call backward-compatible id-only helpers; `removeChannel` and `updateChannelStatus` remain id-only for worker/admin paths.

7. Portal/admin content surfaces must be classified and protected.
   - Evidence: platform-global dashboard and id-based writes.
   - Required: document founder/platform-only status or implement tenant/admin visibility and audit model.

8. Content-to-Secretary scheduling path must move toward intents.
   - Evidence: topic sync creates tasks/calendar events directly.
   - Required: scheduling intent contract or documented backward-compatible bridge.

9. Content source/provenance contract is missing.
   - Required: unified source/reference model for books, channels, links, snippets, extracted patterns, freshness, confidence, owner scope, rights, and last-used metadata.

10. Skill memory and skill version tracking are missing.
   - Required: cross-skill version ledger and memory/version docs/tests.

## P2 Should Fix

- Replace static creator config/niche buckets with user/tenant creator profile.
- Add link references as first-class Content sources.
- Add Content artifact lifecycle and editorial workflow state.
- Add quality/novelty evaluation harness.
- Add iOS rendering for provenance, lifecycle, novelty, source trust, and editorial status.
- Add specific Content notification resolver and deep-link target handling.
- Update misleading fixed-provider comments.

## P3 Deferrable

- Copy polish on Content workbench.
- Portal aggregate analytics UI polish.
- Additional platform-specific output previews beyond core lifecycle/source states.

## Current Validation State

- Tests added: `__tests__/services/content-dedup-routing.test.ts`; route guard tests and internal AI proxy/Python metadata tests added/updated.
- Local smoke: not run in this audit-only pass.
- Staging smoke: not run.
- Production deploy: not run.

## Release-Gate Verdict

Verdict: NO-GO for production release of the upgraded Content Creation workstream.

Reason: audit and rollback setup are complete, but P1 routing/scope/provenance/Secretary/versioning blockers remain open.
