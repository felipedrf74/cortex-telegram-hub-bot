# Final Open Items Remaining Risks

Date: 2026-04-28

## Risk Register

| ID | Severity | Area | Risk | Current Evidence | Required Action |
|---|---|---|---|---|---|
| OI-R001 | Critical | Calendar lifecycle | Real Google/Outlook Training lifecycle has not passed staging read-back. | Calendar smoke result is `blocked` for both providers. | Run staging smoke with real test user, OAuth tokens, read-back, and cleanup. |
| OI-R002 | High | Merge hygiene | The earlier dirty-tree packaging risk could have hidden or over-included work. | Closed and pushed for review: backend branch head `2f14acb` (code `b8f9be7`) and iOS branch head `b1aad7f` (code `537abf6`) are clean candidate commits. | Human review still required; rerun affected gates after any merge conflict resolution. |
| OI-R003 | High | Cross-skill runtime | Cross-skill staging smoke has not run against real seeded data. | Local fixture contracts passed; staging prerequisites blocked. | Seed isolated staging user and rerun smoke. |
| OI-R004 | High | Feedback adaptation | iOS can send rich feedback, but backend persistence/adaptation of all fields is not proven. | iOS tests passed; feedback docs list backend persistence confirmation as high priority. | Add backend route/storage/adaptation tests for all adaptive fields. |
| OI-R005 | Medium | iOS rich state visual proof | Capped/reflowed/unscheduled/canceled/superseded rich states lack screenshot-level simulator proof. | Live simulator ran, but synthetic states are fixture/unit-level only. | Add debug fixture injection and XcodeBuildMCP/XCUITest screenshot smoke. |
| OI-R006 | Medium | Secretary capacity integration | Real Secretary busy windows are not yet direct inputs to the engine-level capacity model. | Constrained-week open items call this out as high impact. | Pass Secretary/calendar busy windows into `reconcileWeeklyCapacity`. |
| OI-R007 | Medium | Inactive session persistence | Deferred/unscheduled sessions are skipped by persistence to avoid calendar pollution. | This is intentional in capacity docs. | Decide product behavior; add plan-adjustments artifact if users should see unscheduled intent after reload. |
| OI-R008 | Medium | Provider marker freshness | Provider update path updates title/time but not necessarily description markers. | Session identity open items identify this gap. | Extend `updateEvent` provider adapters to patch descriptions/identity marker. |
| OI-R009 | Medium | Route/API proof | `profileQuality` and `decisionReasons` need route serialization tests and iOS rendering. | Backend object tests exist; route/UI display remains open. | Add API contract tests and iOS display tests. |
| OI-R010 | Low | Recovery calibration | Poor-recovery variation improved but needs beta calibration for orange readiness and running-only cases. | Poor-recovery open items list this. | Add running-only regression and monitor beta feedback. |
| OI-R011 | Low | Catalog depth continuation | Catalog is better but not exhaustive. | Catalog open items list event-specific cycling, deeper machine/barbell, schema validation. | Continue tested catalog expansion after beta gates. |

## Production Blockers

These must be closed before production promotion if Training calendar trust is part of the release promise:

1. `OI-R001` real Google/Outlook staging lifecycle smoke.
2. Full backend typecheck/test/eval after any future merge conflict resolution.

Resolved locally: `OI-R002` clean merge/commit hygiene is no longer a code packaging blocker for the local candidates.

## Beta Readiness Risks

For a beta where users actively create, sync, cancel, and regenerate Training plans:

- `OI-R001` remains the biggest blocker.
- `OI-R003` should be closed before claiming Nexus-wide cross-skill intelligence.
- `OI-R004` should be closed before claiming the coach learns from rich feedback.
- `OI-R005` should be closed before broad TestFlight if rich states are expected in real payloads.

## Calendar Lifecycle Confidence

| Layer | Confidence | Reason |
|---|---|---|
| Local identity/hash semantics | High | 63 focused tests cover shape hash, ownership, reuse, replacement, cancellation, and retry behavior. |
| Backend calendar safety model | Medium-high | The model avoids broad date/title deletion and prefers ownership/marker matching. |
| Real Google Calendar behavior | Low | Staging smoke is blocked. |
| Real Outlook Calendar behavior | Low | Staging smoke is blocked. |
| Production calendar trust | Medium-low | Code evidence is good, provider proof is missing. |

## Cross-Skill Confidence

| Layer | Confidence | Reason |
|---|---|---|
| Local fixture contracts | Medium-high | Secretary, Cooking, Finance, Content fixtures passed. |
| Runtime staging data flow | Low | Staging smoke is blocked. |
| Tenant/user scoping in smoke | Not proven | Staging user/env missing. |
| Production cross-skill orchestration | Medium-low | Architecture is stronger, but live integration proof is missing. |

## Risk Acceptance Position

Do not accept missing calendar staging proof silently. The engine has become much smarter, but stale or duplicate calendar events are the kind of failure users immediately notice and stop trusting.

The only acceptable shortcut would be an explicit beta flag that keeps Training calendar sync limited or clearly labels it as experimental until Google and Outlook staging smoke passes.
