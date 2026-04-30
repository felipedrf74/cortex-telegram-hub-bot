# Cooking Eval Baseline Results

Date: 2026-04-30

## Mode

Focused deterministic fixtures.

## Baseline

| Area | Score | Evidence |
|---|---:|---|
| Tenant safety foundation | 4/5 | Service-level tenant tests pass; full same-user runtime blocked by auth |
| Allergy/restriction safety | 4/5 | Deterministic allergy blocker added; explicit Cooking preference memory now feeds meal-plan assessment |
| Grocery coherence | 4/5 | Missing ingredient and pantry available/expired checks added |
| Schedule fit | 3/5 | Assessment accepts schedule capacity; Secretary window integration open |
| Budget fit | 3/5 | Assessment accepts budget input; Finance read path open |
| Training fit | 4/5 | Existing route adaptations plus hard-day coverage warning |
| iOS/portal readiness | 2/5 | Backend additive fields exist; rich UI not implemented |
| Full local runtime evidence | 2/5 | Focused tests pass; full smoke not archived |

Overall: 26/40, PASS WITH CONDITIONS for backend candidate foundation.
