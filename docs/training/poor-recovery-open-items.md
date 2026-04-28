# Poor-Recovery Open Items

Date: 2026-04-28

## Closed By This Slice

| ID | Impact | Item | Status |
| --- | --- | --- | --- |
| PRV-001 | High | Cycling poor-recovery weeks repeated generic `Recovery Ride` outputs. | Closed with deterministic cycling variants. |
| PRV-002 | High | Hybrid poor-recovery weeks could flatten modality differences. | Closed with modality-aware variants and tests. |
| PRV-003 | Medium | Travel poor-recovery weeks could pretend a normal ride was realistic. | Closed for hotel/no-bike-trainer cases with off-bike recovery fallback. |
| PRV-004 | Medium | Strength mobility fallback could retain loaded strength exercises. | Closed by stripping exercises from mobility fallbacks. |
| PRV-005 | Medium | Readiness guardrail did not expose recovery scenario metadata. | Closed with `recoveryScenarios` and example explanations in readiness metadata. |

## Still Open

| ID | Impact | Item | Recommended Next Step |
| --- | --- | --- | --- |
| PRV-006 | Medium | Running-only poor-recovery week should have an explicit dedicated regression test. | Add a running-primary red/orange readiness test once the next test pass touches planner fixtures. |
| PRV-007 | Medium | Orange-readiness behavior needs more nuance between "maintenance downshift" and full recovery replacement. | Add scenario tests for orange cycling/running/strength and tune thresholds if product feedback says orange feels too conservative. |
| PRV-008 | Medium | Capacity reconciliation can still override or defer adapted recovery sessions. | Re-run constrained-week capacity tests after merging this branch with `feature/training-constrained-week-capacity-reconciliation`. |
| PRV-009 | Low | Swimming recovery variety remains a single technique swim option. | Add a second swim recovery variant if triathlon beta users report repetition. |
| PRV-010 | Low | Recovery variant telemetry is not yet promoted to analytics. | Consider logging scenario counts at plan-generation boundaries after privacy review. |

## Risk Assessment

This slice materially reduces the poor-recovery repetitiveness risk called out as `FTR-005`. It does not close broader calendar trust risks, session identity risks, or real-provider smoke requirements.

The remaining product risk is calibration: some orange-readiness weeks may now feel more conservative when high-stress sessions are rewritten into recovery variants. That is intentionally safer than allowing hard work during poor recovery, but it should be watched with beta feedback.
