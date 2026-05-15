# Training Engine — Test Matrix

Status: **DRAFT — populated as fixes land**

---

## Mandatory regression tests (from prompt)

| # | Behavior | Test file (target) | Status |
|---|---|---|---|
| R1 | A gym strength session previously surfaced as ~48 min with only minimal content must either: rebuild into a coherent session, lower the truthful duration, OR be rejected before surfacing | `coach-kernel-session-coherence.test.ts` | TODO |
| R2 | A multi-day strength plan must NOT generate near-identical consecutive sessions without explicit rationale | `coach-kernel-week-role-assignment.test.ts` | TODO |
| R3 | Plan activation must create agenda events correctly | `training-plan-lifecycle.test.ts` | TODO |
| R4 | Plan cancellation or replacement must remove/update the correct prior agenda events | `training-plan-lifecycle.test.ts` | TODO |

## Broader scenario tests (from prompt)

| # | Scenario | Status |
|---|---|---|
| S1 | Beginner gym user, 3 days/week, dumbbells only, short sessions | TODO |
| S2 | Intermediate full-gym hypertrophy user | TODO |
| S3 | Hybrid user (gym + running) | TODO |
| S4 | User combining cycling + gym | TODO |
| S5 | Travel week with hotel gym | TODO |
| S6 | Limited-time week requiring compression | TODO |
| S7 | Discomfort/injury-flag scenario requiring substitutions | TODO |
| S8 | Poor adherence requiring simpler prescriptions | TODO |
| S9 | Metrics indicating fatigue or plateau | TODO |
| S10 | Questionnaire data that materially changes the plan | TODO |
| S11 | Sex/gender-aware constraints (only when explicit and relevant) | TODO |

## Engine-component tests (from prompt)

| # | Component | Test focus | Status |
|---|---|---|---|
| C1 | Session time estimator | Accuracy within reasonable tolerances across modalities | TODO |
| C2 | Decision trail | Deduplication, no repeated warnings | TODO |
| C3 | Plan versioning | Version bumps on regeneration; old versions queryable | TODO |
| C4 | Idempotent agenda sync | Re-running sync doesn't duplicate events | TODO |
| C5 | Stale-event cleanup | Cancelled plan's agenda items are removed; not collateral damage | TODO |
| C6 | No cross-plan calendar pollution | User A's cancelled plan never affects user B | TODO |

## Existing test surface (baseline at `4.14.97`)

(To be enumerated in Phase 0 — count of existing training-related tests, what they cover, what's already green.)

---

## Tolerance + acceptance thresholds

| Test | Threshold |
|---|---|
| Time estimator | ±10% of actual computed work-minutes for a known-shape session |
| Coherence rejection | A session with <60% time utilization at the claimed duration MUST be flagged |
| Variety | 2 consecutive strength days share <50% of primary movement IDs |
| Lifecycle | Agenda event count = plan session count after activation; = 0 for that plan_id after cancellation |
