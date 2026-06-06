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
| iOS/portal readiness | 4/5 | iOS assessment/context/preference, pantry freshness, review prompt, and compact substitution rendering branch exists and simulator smoke passed; backend portal Cooking management contracts and preference/pantry browser UI exist and browser runtime smoke passed. Score remains 4 because deeper portal editors and stronger warning visual treatment remain open. |
| Full local runtime evidence | 4/5 | Full backend local smoke archived; rich iOS simulator smoke and portal browser runtime smoke archived. Score remains 4 because no real-provider quality sample was intentionally run. |

Overall: 32/40, PASS WITH CONDITIONS for backend+iOS+portal candidate foundation.
