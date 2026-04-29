# Training Cross-Skill Test Matrix

Date: 2026-04-28

## Automated Coverage Added

| ID | Flow | Test | Expected behavior |
| --- | --- | --- | --- |
| TCS-001 | Secretary conflict → Training | `publishCalendarConflict is readable by the sport coaches via readTrainingContext` | Training flags the conflict and can reflow before claiming the schedule is final. |
| TCS-002 | Secretary stale schedule → Training | `schedule stale signals tell sport coaches to reflow before showing old sessions` | `training_schedule_stale` is urgent, visible to sport coaches, and prompt text requires rebuild/resync. |
| TCS-003 | Cooking fueling gap → Training | `cooking fueling gap risk is consumed as one deduped Training input` | Hard dates missing meals render once, with reflow/lower guidance and no repeated generic warning. |
| TCS-004 | Finance budget constraint → Training | `finance budget constraints steer Training away from paid gear/subscription asks` | Budget posture appears in Training prompt and blocks paid gear/subscription/supplement asks. |
| TCS-005 | Secretary schedule pressure → Training contracts | `Training contracts turn Secretary schedule pressure into reflow guidance` | Busy/fragmented calendars and critical meetings become Training non-negotiables and reflow fallback guidance. |
| TCS-006 | Cooking fueling contracts → Training | `Training contracts keep fueling gaps specific and non-noisy` | Hard fueling dates are named, and rationale is instructed not to repeat generic warnings. |
| TCS-007 | Content execution → Training | `Training sees actionable content execution as creator workload, not optional noise` | Training sees actionable content execution and avoids stacking hard doubles on that day. |

## Commands Run

```bash
npm test -- --run __tests__/services/training-signals.test.ts
npm test -- --run __tests__/services/shared-decision-context.test.ts
```

## Manual / Integration Scenarios Still Recommended

| ID | Scenario | Why it matters | Suggested validation |
| --- | --- | --- | --- |
| TCS-M001 | Calendar event moved over a planned hard session | Ensures Secretary can publish stale/conflict and Training reflows active plan. | Create active plan, add conflicting event, run Secretary refresh, confirm Training changes or flags session before agenda sync. |
| TCS-M002 | Plan cancelled after calendar sync | Ensures agenda ownership cleanup stays precise. | Cancel active plan, confirm old owned events are removed and no old sessions appear in Training. |
| TCS-M003 | Hard training day with missing meals | Ensures Cooking signal changes Training behavior. | Remove meals around a hard session, refresh Cooking mesh, confirm Training lowers/moves or asks for prep coverage once. |
| TCS-M004 | Tight budget month with equipment-limited plan | Ensures Finance constraints affect recommendations. | Mark budget tight, generate equipment-limited plan, confirm no paid gear/subscription upsell unless user asks. |
| TCS-M005 | Content execution day plus Training double | Ensures Content workload is treated as schedule friction. | Create content execution due date, generate hybrid week, confirm no hard double stacks onto content execution without Secretary capacity. |
| TCS-M006 | Two-account isolation | Cross-skill signals are user-scoped and must not leak. | Publish stale/fueling/budget signal for user A, verify user B Training context is clean. |

## Coverage Notes

- The tests cover the orchestration contract and signal plumbing, not full plan generation behavior.
- Full behavior should also be covered in plan-generation scenario tests once the Training engine consumes these prompt/context inputs inside the planner.
- Signal scope is enforced by the existing intelligence bus user-scope tests; this pass adds Training-specific read-path coverage.
