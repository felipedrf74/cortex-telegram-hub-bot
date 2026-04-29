# Content Frontend Open Items

Date: 2026-04-29
Scope: iOS and portal readiness blockers for upgraded Content Creation.

## P0 Production Blockers

| ID | Item | Why it matters | Status |
|---|---|---|---|
| CONTENT-FE-P0-001 | Tenant-safe Content reference cache on iOS | Current `@AppStorage` keys for books/channels/brand voice are not tenant-qualified; same-user tenant switching could show stale reference data. | Open |
| CONTENT-FE-P0-002 | Tenant-safe portal User/Tenant Console authorization | Current portal Content surfaces are operator/global; exposing them as tenant admin/user surfaces would risk private content leakage. | Open |
| CONTENT-FE-P0-003 | Backend-gated private draft/reference access before frontend rendering | Frontend must not hide unauthorized content after receiving it. | Open |

## P1 Must Fix Before Rich Content Release

| ID | Item | Why it matters | Status |
|---|---|---|---|
| CONTENT-FE-P1-001 | iOS provenance DTO/rendering | Users need to know which sources supported a script, claim, or idea. | Open |
| CONTENT-FE-P1-002 | Portal provenance inspector UI | Power users need to inspect source snippets, grounding, freshness, unsupported claims, and reuse lineage. Backend review-pack/comparison contracts now exist. | Open UI |
| CONTENT-FE-P1-003 | iOS lifecycle/approval/review rendering | Rich workflow states must not be flattened to planned/drafting/ready. | Open |
| CONTENT-FE-P1-004 | Portal editorial workflow board | Content needs review, approve, revise, schedule, publish, archive, reject, and repurpose workflows. | Open |
| CONTENT-FE-P1-005 | Reference Center for books, links, channels, notes, previous content | Links are not a first-class visible portal reference type yet. | Open |
| CONTENT-FE-P1-006 | Content Agent configuration UI | Portal needs a coherent configuration surface for pillars, audience, voice, cadence, source preferences, and platform settings. | Open |
| CONTENT-FE-P1-007 | Secretary schedule decision rendering | Content blocks need scheduled/reflowed/compressed/deferred/unscheduled explanations. | Open |
| CONTENT-FE-P1-008 | Novelty/reuse warnings | Duplicate and repurpose decisions should be inspectable instead of hidden backend behavior. | Open |
| CONTENT-FE-P1-009 | Full local iOS/portal smoke with Content fixtures | Static audit is not enough for release. | Open |

## P2 Should Fix

| ID | Item | Why it matters | Status |
|---|---|---|---|
| CONTENT-FE-P2-001 | Content notification resolver/deep links | Backend resolver now returns exact/fallback targets; iOS/portal need route handling for topic/script/approval/radar/source-review/reference targets. | Partially closed |
| CONTENT-FE-P2-002 | iOS compact Content memory/voice profile status | Users should see why the output sounds a certain way. | Open |
| CONTENT-FE-P2-003 | Portal content memory review | Tenant-shared creative preferences need inspect/correct/delete workflows. | Open |
| CONTENT-FE-P2-004 | iOS quick approval/review | Mobile should handle lightweight approvals without becoming the full editor. | Open |
| CONTENT-FE-P2-005 | Portal content calendar | Content deadlines and Secretary schedule blocks should be inspectable in portal. | Open |

## P3 Deferrable

| ID | Item | Why it matters | Status |
|---|---|---|---|
| CONTENT-FE-P3-001 | Portal visual diff for script refinements | Useful for power editing, not needed for first rich release. | Open |
| CONTENT-FE-P3-002 | Advanced source graph visualization | Helpful for trust/debug, but compact provenance table is enough first. | Open |
| CONTENT-FE-P3-003 | Platform-specific preview simulators | Valuable for creators, but can follow after core lifecycle/provenance support. | Open |

## Release Gate

Verdict: **NO-GO** for claiming full iOS/portal readiness for upgraded Content Creation.

Reason:

- Current iOS supports the existing Content feature set but not the upgraded provenance/lifecycle/approval/memory/novelty contract.
- Current portal supports an operator Content dashboard, not a tenant-safe Content power console.
- No full local iOS/portal smoke was run for the upgraded rich Content states in this batch.

Minimum condition to move to **PASS WITH CONDITIONS**:

- Tenant-safe iOS cache behavior implemented and tested.
- Portal private content policy and scoped read/write routes implemented or explicitly limited to platform operator mode.
- iOS renders provenance, lifecycle, review, approval, novelty, and schedule decision states from deterministic fixtures.
- Portal shows Reference Center, workflow state, approval queue, and provenance inspector behind backend authorization.
- Focused local smoke covers iOS Content idea, radar signal, source attribution, portal books/links/channels, tenant-switch isolation, and private draft denial.
