# Single-Agent Beta Status

Date: 2026-04-24

Active branch: `beta/single-agent-rc`

Active worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-codex-single-agent`

## Tracker

| Gap | Status | Evidence | Remaining Work | Tests Needed | Notes |
|---|---|---|---|---|---|
| Gap 1: Live TestFlight smoke | Not started | Backend repo has no live TestFlight proof. | Coordinate with iOS worktree and staging credentials. | TestFlight/manual smoke. | Out of scope for Gap 7. |
| Gap 2: Tenant/data isolation | Implemented, needs verification | `docs/beta/security-foundation-handoff.md`; backend local proof previously passed. | Staging two-user smoke. | Tenant/data isolation staging smoke. | Preserved during this phase. |
| Gap 3: Auth + onboarding reliability | Partially done | `docs/beta/agent-3-auth-onboarding-handoff.md`; auth/onboarding tests exist. | iOS adoption and staging validation. | Auth/onboarding regression and device smoke. | Preserved during this phase. |
| Gap 4: iOS degraded/error states | Implemented, needs verification | Implemented in the iOS single-agent worktree, not this backend worktree. | Visual/TestFlight verification. | iOS degraded-state smoke. | Out of scope for Gap 7 backend work. |
| Gap 5: Portal/admin operator sessions | Implemented, needs verification | `docs/beta/security-foundation-handoff.md`; signed session/admin scope tests previously passed. | Staging signed operator-session smoke. | Portal/admin staging smoke. | Preserved during this phase. |
| Gap 6: Gmail/Outlook/Health integration truth | Partially done | `docs/beta/agent-6-integration-truth-handoff.md`; backend contract exists. | iOS contract adoption and staging validation. | Provider-state backend/iOS smoke. | Preserved during this phase. |
| Gap 7: Observability/on-call loop | Implemented, needs verification | Durable alert lifecycle, delivery states, portal ack/resolve/retry, beta-critical telemetry, `docs/OBSERVABILITY-ONCALL.md`, and focused tests passed. | Provision external alert webhook and run staging delivery/ack/resolve/dead-letter smoke. | Live webhook smoke plus full backend verify before release. | Handoff: `docs/beta/observability-oncall-handoff.md`. |
| Gap 8: Release/runbook discipline | Partially done | Existing docs and beta handoffs. | Consolidate release gate and runbook commands. | Docs/script verification. | Later phase. |
| Gap 9: Frontend architecture debt | Not started | Backend repo only. | Handle in iOS worktree if needed. | iOS build/tests. | Out of scope for Gap 7. |
| Gap 10: Product polish consistency | Not started | Backend repo only. | Handle in iOS worktree if needed. | UI/accessibility smoke. | Out of scope for Gap 7. |

## Single-Agent Rules

- Use branch `beta/single-agent-rc`.
- Do not merge into `beta/rc`.
- Commit after each phase.
- Update this status file after each phase.
- Prefer reusing safe previous work, but never blindly merge stale branches.
- If credentials or staging access are missing, document exact commands and env vars.
