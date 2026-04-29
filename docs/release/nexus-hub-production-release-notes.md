# Nexus Hub Production Release Notes

Generated: 2026-04-29

## Release Status

Prepared for production deployment package only. **Not deployed by this run.**

Final verdict: **GO WITH CONDITIONS**.

## What Changed

This release candidate hardens Nexus Hub across the core orchestration surfaces:

- Chat tenant isolation, scoped context, safer callbacks, richer message lifecycle handling, and deterministic day-to-day evaluation.
- Secretary scheduling-arbitrator foundation with explicit scheduling intents, agenda ownership, lifecycle states, source-skill attribution, decision reasons, and capacity-aware decisions for tested paths.
- Training release hardening around rich payloads, cancellation/regeneration cleanup, constrained-week behavior, weak-profile prompts, feedback ingestion, and iOS rendering compatibility.
- Calendar lifecycle hardening for Secretary-owned Google and Outlook staging events, including create, update/move, retry idempotency, duplicate cleanup, external deletion repair, regenerate/supersede cleanup, replacement, cancellation, read-back verification, and exact-ID cleanup.
- iOS rich-state readiness for Chat, Secretary, Training, tenant-scoped Chat cache behavior, unknown future-state fallback, and local full-product backend connectivity.
- iOS now treats local grounded Chat metadata as a known structured response, so grounded facts and memory hints render without an unknown-type fallback card.
- Model-routing safety and observability improvements while preserving configurable live routing.
- Shared-context metadata for source, freshness, confidence, ownership boundaries, invalidation, and stale-context handling in shipped paths.
- Local full-product smoke runner evidence across backend APIs, auth/session, Chat, Secretary, Training, Cooking, Finance, Content Creation, shared context, local database/cache, local calendar mock, and iOS simulator.

## User Impact

Users should see a more stable Nexus experience across:

- Chat history and message handling.
- Home/dashboard data loading.
- Secretary/agenda state handling in supported paths.
- Training plans and rich training payloads.
- Local and staging calendar lifecycle reliability for tested Secretary-owned events.
- iOS rendering of richer backend states without crashing on unknown future enum/block types.

## Tenant And Security Impact

This release strengthens backend tenant/user boundaries for the current REST-backed Chat scope:

- Chat conversation, message, memory, callback, attachment, and tool-access tests cover cross-tenant denial.
- Prompt construction is expected to receive tenant/user-scoped context before model/provider calls.
- Portal/support diagnostics remain metadata-first; raw private Chat content is not part of the release.
- iOS cache scoping is improved, but backend authorization remains the security boundary.

Do not claim complete same-user multi-workspace switching yet. The tested release scope uses current tenant behavior and documented cache guards.

## Chat Behavior Changes

Supported claims:

- REST-backed Chat tenant-safety foundation.
- Deterministic day-to-day simulation coverage.
- Safer tool/callback boundaries in the tested paths.
- Improved context/memory handling with freshness, confidence, source attribution, and ambiguity handling in deterministic paths.
- Richer metadata rendering support on iOS.

Do not claim:

- Complete WebSocket streaming.
- Complete true same-user multi-workspace Chat switching.
- Live-provider response quality beyond bounded tested paths.
- Raw admin/support review of private Chat content.

## Secretary Behavior Changes

Supported claims:

- Secretary now has a tested scheduling-arbitrator foundation.
- Scheduling intents can carry source skill, tenant/user ownership, priority, duration, constraints, decision reasons, and lifecycle state in tested service paths.
- Tested states include scheduled, reflowed, compressed, unscheduled, and superseded.

Do not claim:

- Every skill/calendar write path is already routed through Secretary.
- Every provider-side stale/duplicate event is repaired outside tested Secretary/Training paths.
- Full iOS action workflow for Secretary clarifications/approvals.

## Training Behavior Changes

Supported claims:

- Training local release smoke passed through the Nexus product engine.
- Plan generation, constrained-week behavior, cancellation cleanup, regeneration duplicate prevention, feedback submission, rich payload rendering, and tenant-scoped local behavior are covered by local tests/smoke.

Do not claim:

- Live model-backed Training Chat quality unless separately smoke-tested.
- Real device HealthKit/TestFlight-only behavior from simulator results.

## Calendar Behavior Changes

Supported claims:

- Google and Outlook staging smoke passed for Secretary-owned lifecycle operations.
- Cleanup uses exact provider event IDs and Secretary markers.
- No broad date-range cleanup was used.

Do not claim:

- Universal agenda lifecycle ownership for generic calendar/tool writes that have not been migrated through Secretary.

## iOS Behavior Changes

Supported claims:

- Full scheme tests passed.
- iOS can connect to the full local Nexus backend when launched with the correct local backend URL.
- iOS renders rich Chat, Secretary, Training, Cooking, Finance, and Content surfaces in tested local/fixture paths.
- Unknown future states fall back safely.

Known iOS limitations:

- Chat live streaming is not a shipped claim.
- Confirmation/clarification action workflows are render-ready but not fully productized.
- True same-user tenant switching is not fully simulator-proven.
- A stale local backend override can still cause a simulator/debug build to show "Could not reach Nexus Hub"; clear the override or launch with the intended backend URL. The local runner's detached `start` path has been hardened to keep the Node backend process alive for simulator smoke.

## Model-Routing Behavior

Nexus Hub runtime model selection remains configurable and provider-agnostic.

This release does **not** hardcode GPT, Gemini, Claude, or any single provider as the production default. It preserves:

- task type routing such as classify/chat/toolUse/tool-continuation,
- tier/domain/operator overrides,
- environment overrides,
- Anthropic gating,
- category tags for observability/cost tracking.

Known limitation: some off-path streaming/proxy/legacy attribution gaps remain conditional and should not be described as fully solved.

## Known Limitations

- Focused staging Chat smoke is still required before production promotion.
- Fresh production DB snapshot is required immediately before deployment.
- Shared-context mesh/signal tenant-awareness is not fully complete.
- Universal Secretary ownership is not complete.
- Live-provider fallback quality was not proven in this local RC package.
- iOS tenant-switch and streaming claims must remain restrained.

## Rollback Instructions

Use `docs/release/nexus-hub-rollback-plan.md`.

High-level rollback:

1. Stop promotion if staging smoke fails.
2. For production, restore previous backend commit/build first.
3. Use the fresh DB snapshot only if a migration/data defect is confirmed.
4. Do not broad-delete calendar events; use exact provider IDs and ownership rows.
5. Roll back iOS through the previous known-good build/TestFlight path.
6. Preserve provider-agnostic model routing during rollback.
