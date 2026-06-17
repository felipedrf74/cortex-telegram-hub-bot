# Training Engine — Test Matrix

Status: **DRAFT - populated as fixes land. 2026-06-16 quality-gate fixtures added; full test execution pending explicit authorization.**

---

## 2026-06-16 added coverage

| # | Behavior | Test file | Status |
|---|---|---|---|
| Q1 | A requested 5-day hypertrophy plan is repaired into exactly five ABCDE sessions in rolling Week 1 | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q2 | Generic user-facing strength titles are replaced with split-aware titles | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q3 | Repeated universal fallback exercises such as Goblet Squat are repaired before persistence | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q4 | Every repaired session has split metadata and structured prescription sections | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q5 | Week 1 strength allocation uses a rolling seven-day period from plan start | `__tests__/services/training-plan-volume-enforcement.test.ts` | Updated, not run |
| Q6 | Verified calendar ownership renders linked, while stale/mismatched ownership renders `repair_needed` instead of unscheduled | `__tests__/services/training-calendar-sync-state.test.ts`, `__tests__/api/training-read-models.test.ts` | Added/updated, not run |
| Q7 | 2/3/4/5/6-day split templates generate deterministic slots, spaced lower-body work, structured sections, and protected-endurance placement repair | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q8 | Limited equipment, excluded exercises, injury notes, and progression metadata are enforced by the quality gate | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q9 | iOS model helpers render verified calendar links as scheduled, stale links as repair-needed, and decode Plan Summary `whyThisPlan` copy | `Nexus HubTests/TrainingCalendarTruthTests.swift` | Added, not run |
| Q10 | iOS rich-fixture UI exposes Today prescription details and Plan Summary rationale card | `Nexus HubUITests/TrainingFixtureBypassUITests.swift` | Added/updated, not run |
| Q11 | Sparse claimed-duration strength sessions are repaired or resized truthfully and required split movement patterns are prescribed | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q12 | Weekly direct-set volume/frequency targets pass across seeded 2/3/4/5/6-day, equipment-limited, hybrid, and injury-constrained specs | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q13 | Spec-backed plans with `calendarPreference.provider = "none"` do not fall through to auto-provider calendar writes | `__tests__/api/training-plan-persistence.test.ts` | Added, not run |
| Q14 | Calendar ownership persists provider calendar ID, last verification time, and sync version metadata for read-model truth and stale-link repair | `__tests__/services/training-plan-lifecycle.test.ts` | Added/updated, not run |
| Q15 | Unsafe incomplete `TrainingPlanSpec` inputs return `needs_clarification` before cancellation/persistence instead of saving generic high-frequency strength plans | `__tests__/api/training-plan-generation.test.ts` | Added, not run |
| Q16 | Deterministic randomized invariant sweep covers mixed start days, goals, days/week, equipment, duration, blocked days, exclusions, injuries, endurance keys, and providers | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |
| Q17 | Negative control proves impossible exercise constraints fail closed instead of being silently repaired into generic filler | `__tests__/services/training-plan-quality-gate.test.ts` | Added, not run |

## Remaining target coverage

The next authorized test slice should expand the current split fixtures into deeper persona-specific assertions for 2-day beginner full body, 3-day full body, 4-day upper/lower, 5-day hybrid with protected long run, 6-day push/pull/legs repeat, limited-equipment dumbbell plans, and knee-friendly constrained plans. A seeded invariant sweep now covers start day, days per week, goal, equipment, session duration, preferred/blocked days, endurance key days, and calendar provider; broader randomized/fuzz-style coverage is still pending.

Calendar sync regression tests still need preferred-provider-only writes, idempotent retry, stale ownership repair, provider disconnected, external event deleted/moved, no duplicate Google/Outlook writes, and linked sessions never rendering unscheduled.

iOS execution still needs authorized simulator runs for Today full-prescription rendering, Plan Summary split/recovery copy, verified linked sessions avoiding `Needs slot`, and horizontal-only week-strip interaction.

---

## Mandatory regression tests (from prompt)

| # | Behavior | Test file (target) | Status |
|---|---|---|---|
| R1 | A gym strength session previously surfaced as ~48 min with only minimal content must either: rebuild into a coherent session, lower the truthful duration, OR be rejected before surfacing | `__tests__/services/training-plan-quality-gate.test.ts`; legacy `coach-kernel-session-coherence.test.ts` remains baseline coverage | Added/updated, not run |
| R2 | A multi-day strength plan must NOT generate near-identical consecutive sessions without explicit rationale | `__tests__/services/training-plan-quality-gate.test.ts` covers current split-slot uniqueness and repeated fallback repair; broader multi-week variant-rotation proof remains future coverage | Partially added, not run |
| R3 | Plan activation must create agenda events correctly | Existing lifecycle/calendar sync suites plus new sync-state tests | Pending authorized test execution and live-provider smoke |
| R4 | Plan cancellation or replacement must remove/update the correct prior agenda events | Existing lifecycle/calendar sync suites | Pending authorized test execution and live-provider smoke |

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
| C1 | Session time estimator | Accuracy within reasonable tolerances across modalities | Strength quality-gate fixture added, not run; endurance-specific estimator coverage remains future work |
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
