# Feedback Loop Test Matrix

## Automated Coverage Added

| Area | Test File | Scenario | Expected Behavior |
|---|---|---|---|
| Hard feedback + soreness | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | Recent RPE 9 sessions, soreness 7-8, orange readiness | Emits downshift decisions, plan phase becomes deload, total minutes decrease |
| Poor adherence | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | Broken adherence, consecutive misses, skipped/partial sessions | Emits re-entry decision, reduces weekly targets, caps max sessions/day |
| Easy work progression | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | RPE 5, RIR 4-5, strong adherence, green readiness | Emits progression decision, strength prescription adds work |
| Too-long sessions | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | Actual duration materially exceeds planned duration | Emits duration-cap decision, next plan minutes decrease |
| Plateau variation | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | Flat four-week strength history with decent adherence | Emits variation decision and tags affected sessions |
| Metrics ingestion | `__tests__/services/training-history.test.ts` | Completion row with RPE, soreness, energy, distance, travel/substitution notes | Builds recent feedback sample with typed fields and feedback tags |

## Existing Coverage Preserved

Focused validation also runs:

- `__tests__/services/coach-kernel-planner.test.ts`
- `__tests__/services/training-coach-kernel-plan-generator.test.ts`
- `__tests__/services/training-history.test.ts`

These protect planner integration, registry side effects, readiness behavior, and real completion-history reads.

## Manual Validation Scenarios

Use these in local QA once connected to realistic user data:

1. Complete two workouts as too hard with high soreness, then generate next week.
2. Skip two sessions and complete one partial session, then regenerate.
3. Complete three easy gym sessions with RIR 4+, then regenerate.
4. Complete sessions that run 25% longer than planned, then regenerate.
5. Keep four weeks of flat strength volume with good adherence, then verify variation.

## Acceptance Criteria

- The next plan changes in structure or prescription, not just explanation copy.
- Notes identify the feedback-loop reason.
- The engine never increases load when recovery or adherence signals are bad.
- The engine never performs broad, random variation without a typed plateau or substitution reason.
