# Constrained-Week Test Matrix

Date: 2026-04-28

| Scenario | Coverage | Test |
|---|---|---|
| Travel week with 3 planned gym sessions but only 2 short windows | Active sessions are capped to 2; leftover session is explicit `unscheduled`; active sessions fit windows. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` |
| Hybrid gym + running week with reduced availability | Active sessions do not exceed slot/day capacity; sessions are capped/reflowed/compressed as needed. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` |
| Cycling + gym week with insufficient recovery/slot pressure | Active sessions are limited to feasible slots and fit declared windows. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` |
| 5 planned sessions but only 3 feasible slots | Calendar payload includes only active valid sessions; leftovers do not create events. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` |
| No valid slots | No active sessions are emitted; sessions are marked `unscheduled` and have no times. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` |
| Session exceeds available duration | Session is capped/compressed and remains inside the slot. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`, existing planner short-window test |
| Agenda events only for scheduled sessions | `syncCalendar` and persistence skip deferred/unscheduled/dropped sessions. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`, `__tests__/api/training-plan-persistence.test.ts` |
| Reflowed sessions retain calendar validity | Reflowed sessions carry `originalDayOfWeek`, valid start/end, and schedule reason. | `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` |
| Frontend payload state | `scheduleState`, `scheduleAdjustments`, and `scheduleReason` are exposed in engine and legacy plan output. | Type coverage plus persistence/engine tests |
| Regression: triathlon brick pairing | Brick remains on the key ride day when the cycling slot has remaining capacity. | Existing `coach-kernel-planner` test |

## Validation Commands

```bash
npm test -- --run __tests__/services/coach-kernel-constrained-week-capacity.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-evaluation.test.ts
npm run typecheck
npm run eval:training -- --week-start 2026-04-27 --fail-under 95 --out-dir reports/training-eval/constrained-week-capacity
```

