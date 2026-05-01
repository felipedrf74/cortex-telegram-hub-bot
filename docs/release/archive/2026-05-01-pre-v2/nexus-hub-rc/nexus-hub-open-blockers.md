# Nexus Hub Open Blockers

Generated: 2026-04-29

## P0 Production Blockers

No active P0 blocker is confirmed for the restrained REST-backed release scope.

Do not proceed to production if any of these become true:

- Cross-tenant Chat conversation, memory, retrieval, attachment, tool-call, or shared-context leakage is reproduced.
- Prompt/provider fallback receives unauthorized tenant/user context.
- Raw Chat/admin/support content access is exposed without explicit permission and audit.
- Production deploy starts without a fresh production DB snapshot.
- Staging smoke fails on the exact release commit.

## P1 Must-Fix Or Must-Accept Before Release

| ID | Area | Blocker | Current evidence | Required closure |
|---|---|---|---|---|
| NH-P1-01 | Chat deploy gate | Focused staging Chat smoke must pass before production promotion. | `docs/chat/chat-production-open-blockers.md` | Deploy exact RC to staging, run focused Chat smoke, record pass/fail and cleanup. |
| NH-P1-02 | Shared context | `agent_signals` lacks tenant ID and mesh readers are user-scoped. | `docs/context/shared-context-release-gate.md` | Add tenant scoping or explicitly scope release claims to fail-closed/default-tenant behavior. |
| NH-P1-03 | Secretary | Secretary arbitrator is not wired into all skill/calendar write paths. | `docs/local/secretary-full-product-smoke-results.md` | Wire remaining live paths or state that this release ships the foundation only. |
| NH-P1-04 | Calendar | Universal stale/duplicate provider repair is incomplete outside tested paths. | `docs/calendar/calendar-release-gate.md` | Either complete repair coverage or limit release claim to tested Secretary/Training lifecycle paths. |
| NH-P1-05 | AI routing | Off-path provider routing/observability gaps remain. | `docs/ai/model-routing-open-blockers.md` | Close streaming/proxy/legacy attribution gaps or exclude those paths from release claims. |
| NH-P1-06 | iOS | Confirmation/clarification actions are render-only and WebSocket streaming is disabled. | iOS `ios-release-blockers.md` | Add action contracts or document render-only behavior; do not claim streaming support. |
| NH-P1-07 | iOS tenant switching | True same-user multi-workspace switching is not fully implemented/smoked. | iOS `ios-release-gate.md` | Implement and smoke, or remove complete tenant-switching claims. |
| NH-P1-08 | Local smoke | Full local smoke used fixtures and did not prove real provider reasoning/stream reconnects. | `docs/local/full-nexus-local-smoke-results.md` | Run bounded live-provider smoke for claimed live reasoning paths, or keep claims fixture-backed. |
| NH-P1-09 | Release operations | Production deployment sequence is not yet executed for this final RC. | Current release process | Fresh snapshot, push branches, staging deploy, staging smoke, promote, prod health. |

## P2 Should-Fix

| ID | Area | Item | Why it matters |
|---|---|---|---|
| NH-P2-01 | Chat | Single-command local smoke runner missing. | Reduces release-gate drift and operator error. |
| NH-P2-02 | Chat | Live vector namespace smoke absent or not clearly active. | Keeps future RAG activation from becoming a tenant leak. |
| NH-P2-03 | Chat | Cooking/Content natural-language orchestration mostly fixture-backed. | Raises confidence in day-to-day response quality. |
| NH-P2-04 | iOS | Non-empty Content Creation skill card needs live local/staging proof. | Prevents hidden rendering gaps. |
| NH-P2-05 | Portal | User Console Chat not implemented; raw support content intentionally absent. | Fine for current scope, but support workflows remain limited. |
| NH-P2-06 | Secretary | Reminder/follow-up lifecycle UI and action paths are thin. | Important for execution quality, not a launch blocker if not claimed. |
| NH-P2-07 | Model routing | Request-correlated cost/latency/fallback dashboards incomplete. | Improves post-release operations. |
| NH-P2-08 | Training | Signed TestFlight/device validation remains a separate closure path for simulator-limited capabilities. | Prevents device-only regressions. |

## P3 Deferrable

- Broader XCUITest coverage for every rich state variant.
- Portal quality dashboards and aggregate response sufficiency reporting.
- Additional release-note examples for end users.
- Expanded day-to-day transcript bank beyond current fixture scenarios.

## Non-Negotiable Release Guardrails

- Do not deploy from an unpushed or unreviewed branch.
- Do not skip a fresh production DB snapshot immediately before deploy.
- Do not skip staging deploy and focused staging smoke.
- Do not claim GPT or any single provider as the fixed Nexus runtime model.
- Do not claim complete WebSocket streaming until the path is enabled and smoked.
- Do not claim universal Secretary ownership until all calendar/skill write paths go through the Secretary ledger.
- Do not claim full multi-tenant shared-context orchestration until shared context storage and readers are tenant-scoped.
