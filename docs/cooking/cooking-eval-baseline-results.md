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
| Schedule fit | 4/5 | Secretary availability read path now feeds assessment; alternate-window proposals remain open |
| Budget fit | 4/5 | Finance monthly budget headroom feeds assessment; item-price grocery optimization remains open |
| Training fit | 4/5 | Existing route adaptations plus hard-day coverage warning |
| iOS/portal readiness | 3.75/5 | iOS assessment/context/preference and pantry freshness rendering branch exists; backend portal Cooking management contracts exist; browser UI and iOS simulator smoke remain open |
| Full local runtime evidence | 4/5 | Full backend local smoke archived; iOS simulator and portal browser smoke remain open |

Overall: 31.75/40, PASS WITH CONDITIONS for backend+iOS+portal-contract candidate foundation.
