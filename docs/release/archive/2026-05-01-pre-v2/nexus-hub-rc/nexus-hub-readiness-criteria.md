# Nexus Hub Readiness Criteria

Generated: 2026-04-29

## Overall Release Rule

Nexus Hub is release-ready only when:

- No P0 blockers are open.
- Every critical P1 item is fixed or explicitly accepted with a narrowed release scope.
- The exact release commit has passed staging smoke.
- A fresh production DB snapshot exists immediately before production deployment.
- Production health checks pass after promotion.

Current status: **not unconditionally release-ready**.

## Required Criteria

### 1. Chat Readiness

- Backend authorization is enforced before conversation, message, memory, retrieval, attachment, tool-call, and prompt access.
- Tenant/user scope is applied before prompt construction and before any provider call.
- Provider fallback receives the same scoped context and does not rebuild unsafe context.
- Focused staging Chat smoke passes on the release commit.
- Release copy does not claim WebSocket streaming unless enabled and smoked.
- Release copy does not claim true multi-workspace Chat continuity unless same-user tenant switching is implemented and smoked.

Required evidence:

- `docs/chat/p0-tenant-release-gate.md`
- `docs/chat/chat-final-production-go-no-go.md`
- `docs/chat/chat-production-open-blockers.md`
- focused staging smoke result for the RC

### 2. Secretary Readiness

- Scheduling intents, agenda ownership, lifecycle states, source attribution, decision reasons, and tenant/user ownership are present for the shipped paths.
- Secretary owns the shipped scheduling paths that are claimed in release notes.
- Skills that still bypass Secretary are documented and not claimed as arbitrated.
- Stale/duplicate repair coverage is present for shipped paths or documented as a limitation.

Required evidence:

- `docs/secretary/secretary-release-gate.md`
- `docs/local/secretary-full-product-smoke-results.md`
- Secretary orchestration test results

### 3. Training Readiness

- Training release gates remain green for constrained/travel weeks, cancellation/regeneration cleanup, rich payload states, weak-profile handling, and iOS-facing contracts.
- Calendar cleanup for Training uses precise ownership/event IDs, not broad date/title matching.
- Any remaining simulator/device-only limitations are documented.

Required evidence:

- `docs/training/final-production-go-no-go.md`
- `docs/training/training-release-gate.md`
- `docs/local/training-release-smoke-results.md`

### 4. Calendar Readiness

- Local lifecycle smoke passes for create, update, cancel, regenerate, retry, stale cleanup, and duplicate prevention.
- Google staging smoke passes with read-back verification and cleanup.
- Outlook staging smoke passes with read-back verification and cleanup.
- No unrelated events are deleted.
- Universal calendar ownership claims are limited to paths actually routed through Secretary/Training ownership.

Required evidence:

- `docs/calendar/calendar-release-gate.md`
- `docs/calendar/local-calendar-smoke-results.md`
- `docs/calendar/google-staging-smoke-results.md`
- `docs/calendar/outlook-staging-smoke-results.md`

### 5. Shared Context Readiness

- Shared context records used by Chat and Secretary include sufficient source, freshness, confidence, tenant/user scope, and invalidation behavior for shipped paths.
- `agent_signals` and mesh readers are tenant-safe before claiming full multi-tenant shared-context orchestration.
- Stale context is either invalidated or presented as uncertain.

Required evidence:

- `docs/context/shared-context-release-gate.md`
- `docs/context/shared-context-test-results.md`

### 6. Model-Routing Readiness

- Nexus runtime model routing remains configurable and provider-agnostic.
- No global hardcoded GPT, Claude, Gemini, or other fixed-provider assumption is introduced.
- Operator overrides, tier pins, domain pins, category tags, provider gates, and fallbacks remain functional.
- Provider/model/tier/category/fallback metadata is observable without raw prompt leakage.
- Any off-path provider gaps are fixed or explicitly excluded from release claims.

Required evidence:

- `docs/ai/model-routing-release-gate.md`
- `docs/ai/model-routing-test-results.md`
- `docs/ai/model-routing-open-blockers.md`

### 7. iOS Readiness

- iOS points to the intended backend environment and does not retain stale local override settings.
- Tenant-scoped cache behavior is safe for the shipped tenant model.
- Rich Chat, Secretary, Training, and skill states decode without crashes.
- Unknown enum/message/block states fall back safely.
- Confirmation, clarification, streaming, retry, and tenant-switch claims match what was actually smoked.

Required evidence:

- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/ios-release-gate.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/ios-release-blockers.md`
- final iOS simulator smoke against the release backend

### 8. Local Full-Product Readiness

- Backend health, auth/session, tenant context, permissions, Chat, Secretary, Training, Cooking, Finance, Content Creation, shared context, workers, database/cache, and local agenda mock are validated.
- Smoke report states whether fixtures or real providers were used.
- Cleanup confirms backend, workers, containers, tunnels, and provider-call loops were stopped.

Required evidence:

- `docs/local/full-nexus-local-smoke-results.md`
- `docs/local/full-nexus-local-cleanup-confirmation.md`

### 9. Portal/Support Readiness

- Portal/admin/support surfaces do not expose raw private Chat content without explicit role, tenant policy, and audit.
- Metadata-only diagnostics are acceptable for this release if raw support access remains intentionally absent.
- Aggregate analytics must not leak prompt or private message content.

Required evidence:

- `docs/portal/chat-portal-readiness.md`
- support/admin access notes in release package

### 10. Deployment Readiness

Before production promotion:

1. Create a fresh production DB snapshot.
2. Commit and push backend and iOS release branches.
3. Merge/deploy to staging.
4. Run focused staging Chat smoke and any scoped Secretary/calendar smoke required by the release.
5. Promote to production only after staging smoke passes.
6. Run production health checks.
7. Confirm monitoring for Chat, Secretary, calendar, model-routing, tenant authorization, iOS decode/render errors, duplicate events/messages, stale state, and provider/cost anomalies.

## Current Release State

The evidence supports **GO WITH CONDITIONS** only. The release can move forward as a restrained candidate after critical P1 gates are either closed or accepted with explicit release-scope limits. It must not be called fully production-ready while the shared-context tenant gaps, Secretary universal-ownership gaps, iOS tenant/action gaps, and model-routing off-path gaps remain unresolved.
