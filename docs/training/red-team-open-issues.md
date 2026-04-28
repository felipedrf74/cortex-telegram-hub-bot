# Training Engine Red-Team Open Issues

Date: 2026-04-28  
Source benchmark: `reports/training-red-team/training-eval-2026-04-28T01-40-32-426Z.json`

## Open Issues

| ID | Severity | Area | Evidence | Root Cause | Recommended Fix | Status |
|---|---|---|---|---|---|---|
| RT-OPEN-001 | High | Travel-week schedule overload | `travel-week-hotel-gym__poor-recovery` scored `92`; repeated penalties for `Total sessions above maximum (6/4)`, `friday has 2 sessions, above max 1`, and missing calendar times. | Planner/guardrail stack still tries to preserve too many sessions when a travel persona has fewer compatible windows than desired sessions. Some unscheduled sessions are kept as active prescriptions instead of being explicitly deferred. | Add a final availability capacity reconciler that converts lowest-priority overflow sessions to explicit deferred/recovery placeholders, with guardrail results explaining why. Do not leave active sessions without start/end when the user has no window. | Open |
| RT-OPEN-002 | Medium | Poor-recovery variety | `cyclist-ftp-build__poor-recovery`, `hybrid-gym-cycling__poor-recovery`, and `travel-week-hotel-gym__poor-recovery` show repeated recovery signatures and only two session types. | Red/orange readiness correctly downshifts intensity but collapses too many roles into identical recovery labels/content. | Add role-preserving recovery variants: recovery cadence ride, aerobic spin, short walk/run, technique ride, mobility-plus-breathing, upper/lower technique strength variants. | Open |
| RT-OPEN-003 | High | Plan regeneration identity | `*_plan-cancel-regenerate` cases report regenerated sessions reusing ids for changed session shapes. | Session identity remains partly title/day based. When regenerated content changes materially, old ids can survive and make agenda diffing less trustworthy. | Include plan version plus stable shape hash or session role revision in agenda-owned session identity. Preserve ids only when shape, day, role, and duration are materially equivalent. | Open |
| RT-OPEN-004 | Medium | Weak-profile explanation | `low-time-user__weak-profile-completeness` and `travel-week-hotel-gym__weak-profile-completeness` still miss profile/completeness gap messaging in some combinations. | Profile follow-up notes exist but can be diluted by later plan notes or not triggered for certain persona/scenario merges. | Promote missing-critical-data notes to a first-class plan warning/decision-trail category and assert they survive note rebuilds. | Open |
| RT-OPEN-005 | Low | Large volume drops need frontend rendering | Backend now emits structured `decisionReasons` for compression, reflow, unscheduled sessions, weekly caps, and recovery-driven reductions. | `docs/training/schedule-compression-explanations.md` and `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` cover the backend explanation path. | Add iOS rendering and route-level serialization tests for `decisionReasons`. | Backend fixed; frontend/API contract hardening remains |
| RT-OPEN-006 | Medium | Frontend compatibility not runtime-smoked in this pass | Backend DTO/test coverage passed, but no iOS simulator smoke was run during this backend-only red-team turn. | This pass ran in the backend repo only. Richer alternatives/tags/unscheduled states must still be checked in iOS rendering. | Run iOS smoke against a payload containing `availability_capped`, `availability_reflowed`, `availability_unscheduled`, and regenerated plan states. | Open |

## Deferred / Not Fixed In This Pass

- Broad plan capacity pruning for travel weeks was not fixed here because it changes product behavior around whether overloaded sessions are deferred, moved, or kept as unscheduled recommendations.
- Plan-version/session-id semantics were not changed here because they affect agenda lifecycle contracts and should be done as a focused lifecycle slice.
- Poor-recovery variety can be improved safely, but it is catalog/archetype work rather than a tiny red-team patch.

## Production Risk Summary

No remaining issue suggests the engine is broadly broken. The largest production trust risk is still agenda/lifecycle behavior under replacement/regeneration and heavily constrained travel weeks. Those should be fixed before claiming the Training engine is fully production-ready.
