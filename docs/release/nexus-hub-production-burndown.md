# Nexus Hub Production Burn-Down

Generated: 2026-04-29

## Verdict

**GO WITH CONDITIONS for a restrained release candidate. NO-GO for an unconditional production release today.**

No reviewed document proves an active P0 data leak in the current restrained REST-backed scope, but several release gates remain conditional. Nexus Hub must not be marketed or operated as fully production-ready for broad Chat streaming, universal Secretary agenda ownership, true multi-workspace Chat memory, or full shared-context orchestration until the critical P1 items below are closed or explicitly accepted with narrowed release claims.

## Evidence Reviewed

- Chat: `docs/chat/chat-final-production-go-no-go.md`, `docs/chat/chat-production-open-blockers.md`, `docs/chat/p0-tenant-release-gate.md`, `docs/local/chat-tenant-security-smoke-results.md`
- Secretary: `docs/secretary/secretary-release-gate.md`, `docs/local/secretary-full-product-smoke-results.md`, Secretary audit and orchestration docs
- Training: `docs/training/final-production-go-no-go.md`, `docs/training/production-open-blockers.md`, `docs/training/training-release-gate.md`
- Calendar: `docs/calendar/calendar-release-gate.md`, Google/Outlook/local calendar smoke docs
- AI/model routing: `docs/ai/model-routing-release-gate.md`, `docs/ai/model-routing-open-blockers.md`, model-routing audit and test docs
- Shared context: `docs/context/shared-context-release-gate.md`, shared-context audit and test docs
- Local smoke: `docs/local/full-nexus-local-smoke-results.md`, `docs/local/cross-skill-smoke-results.md`
- Portal: `docs/portal/chat-portal-readiness.md`
- iOS repo: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/ios-release-gate.md`, `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/ios-release-blockers.md`, Chat and Secretary iOS smoke docs
- Product truth: `/Users/felipedominguez/Desktop/Nexus Hub IOS/specs/00-CURRENT-PRODUCT-TRUTH.md`, tenant readiness and handover specs

## P0 Blockers

No currently confirmed P0 blocker remains for the narrowed REST-backed release scope if all documented constraints are honored.

The following become P0 blockers if release scope expands beyond the proven paths:

- Claiming or enabling cross-tenant/shared-context behavior before `agent_signals` and mesh readers are tenant-scoped.
- Enabling raw Chat support/admin content access without explicit permission and audit.
- Enabling provider fallback paths that rebuild prompt context outside the tenant-safe context builder.
- Releasing iOS tenant switching as complete before true same-user multi-workspace switching is implemented and smoked.
- Deploying without a fresh production DB snapshot and staging smoke gate immediately before promotion.

## Critical P1 Must-Fix Or Must-Accept Conditions

1. **Focused staging Chat smoke is still a production gate.**
   Evidence: `docs/chat/chat-production-open-blockers.md` requires staging deployment plus focused Chat smoke before promotion.
   Release impact: Do not promote Chat changes to production until staging smoke passes on the exact release commit.

2. **Shared-context tenant model remains conditional.**
   Evidence: `docs/context/shared-context-release-gate.md` lists `agent_signals` without `tenant_id` and mesh readers that are user-scoped only.
   Release impact: Do not claim full tenant-safe shared-context orchestration until closed. Current behavior may ship only if documented as fail-closed or default-tenant constrained.

3. **Secretary is not yet universally wired as the agenda owner.**
   Evidence: `docs/local/secretary-full-product-smoke-results.md` is PASS WITH CONDITIONS; generic calendar/tool writes can still bypass the Secretary ledger and provider-side repair is incomplete.
   Release impact: Foundation can ship behind honest claims, but do not claim every skill/calendar write is arbitrated by Secretary.

4. **Model-routing safety still has off-path gaps.**
   Evidence: `docs/ai/model-routing-open-blockers.md` lists OpenAI streaming bypass attribution, Python proxy tenant attribution, legacy user-only context blocks, and incomplete request-correlated observability.
   Release impact: Live routing must remain configurable; do not claim every provider path has complete tenant-safe observability until fixed.

5. **iOS rich-state support is conditional.**
   Evidence: iOS `ios-release-gate.md` and `ios-release-blockers.md` are PASS WITH CONDITIONS. Confirmation/clarification actions are render-only, WebSocket streaming is disabled, active tenant UI is incomplete, and final backend RC simulator smoke is still required.
   Release impact: iOS may ship only with restrained feature claims and after final simulator smoke against the release backend.

6. **Calendar provider smoke passed, but universal lifecycle ownership is not complete.**
   Evidence: `docs/calendar/calendar-release-gate.md` is PASS WITH CONDITIONS. Google/Outlook staging lifecycle passed, but generic write-path migration through Secretary remains separate.
   Release impact: Calendar lifecycle proof supports tested Secretary/Training paths, not every calendar mutation path.

7. **Local full-product smoke used fixtures and constrained provider behavior.**
   Evidence: `docs/local/full-nexus-local-smoke-results.md` is PASS WITH CONDITIONS. Real provider calls, WebSocket reconnects, and true same-user multi-workspace flows were not fully exercised.
   Release impact: Do not claim broad live-model reasoning quality or streaming reliability from this smoke alone.

8. **Production deployment process gates remain mandatory.**
   Required sequence: fresh production DB snapshot, commit/push release branches, merge/deploy staging, focused staging smoke, promote only after staging passes, production health checks.
   Release impact: Any production deployment that skips this sequence is a NO-GO.

## P2 Should-Fix

- Add a single-command local Chat smoke runner that covers backend, fixtures, workers, and cleanup.
- Add provider-backed natural-language smoke for Cooking and Content Creation orchestration.
- Add live vector namespace isolation smoke, or document vector/RAG as not active in the release.
- Complete portal/support diagnostic audit for any future raw content access.
- Add first-class fixture provider mode with provider-call limits and runaway-call detection.
- Add non-empty iOS Content Creation result-card smoke.
- Add dedicated iOS reminder/follow-up and Secretary approval action flows.
- Add request-correlated provider fallback/cost dashboards.

## P3 Deferrable

- Broader copy polish across release docs.
- XCUITest expansion for all rich backend state cards.
- Portal analytics dashboards for response sufficiency and clarification rate.
- Richer end-user release notes after release scope is finalized.

## Release Recommendation

Proceed only as a **restrained release candidate** after the critical P1 gates are closed or explicitly accepted with narrow release copy:

- Chat: REST-backed, tenant-safe Chat foundation only; no WebSocket streaming claim.
- Secretary: scheduling-arbitrator foundation only; no universal agenda ownership claim.
- Shared context: scoped/default-tenant-safe behavior only; no full multi-tenant mesh claim.
- iOS: render-safe rich states only; no complete tenant-switching or action-confirmation claim.
- Model routing: configurable routing preserved; do not claim every off-path provider has complete observability.

Unconditional production release remains **NO-GO** until the critical P1 items are closed.
