# Training Cross-Skill Orchestration Pass

Date: 2026-04-28

## Executive Summary

Training now has a clearer cross-skill contract with Secretary, Cooking, Finance, and Content. The pass keeps Training as the owner of plan/session decisions, while peer skills publish or expose constraints that Training must respect before it locks, reflows, or explains a plan.

The most important change is that cross-skill inputs are no longer only prose in a prompt. Training can now consume explicit signals for stale schedules, calendar conflicts, fueling gaps, and budget constraints, and the shared decision contracts tell the coach when to reflow, lower, or defer work instead of repeating stale or generic guidance.

## Ownership Model

| Area | Owner | Training responsibility | Peer-skill responsibility |
| --- | --- | --- | --- |
| Training plan/session prescription | Training | Generate, validate, adapt, explain, and version the active plan. | Provide constraints and readiness signals. |
| Calendar/agenda truth | Secretary | Treat conflicts/stale schedules as a reflow trigger, then resync owned agenda events. | Detect user availability changes, conflicts, fragmentation, travel, and critical meetings. |
| Fueling readiness | Cooking | Lower, move, or request fueling coverage for unsupported hard work. | Surface meal coverage, prep pressure, shopping readiness, and hard-session fueling gaps. |
| Training cost realism | Finance | Avoid paid gear, supplement, and subscription asks when constrained. | Surface budget posture and recurring/subscription pressure. |
| Milestones and content moments | Content | Emit useful coaching story opportunities and respect creator workload. | Surface publish/execution commitments that affect schedule friction. |

## Implemented Signal Bridges

| Signal | Source | Consumer | Purpose |
| --- | --- | --- | --- |
| `training_schedule_stale` | Secretary / agenda lifecycle | Training | Active plan calendar truth changed; do not show old sessions as final. |
| `calendar_conflict` | Secretary | Training | User calendar event overlaps planned training. |
| `fueling_gap_risk` | Cooking | Training | Hard or training-day meal coverage is missing. |
| `budget_remaining` | Finance | Training | Budget posture affects equipment, subscription, supplement, or paid training asks. |
| `publishing_commitment` | Content | Training | Publishing workload should be treated as schedule friction. |

New helper publishers live in `src/services/training-signals.ts`:

- `publishTrainingScheduleStale`
- `publishFuelingGapRisk`
- `publishTrainingBudgetConstraint`

## Prompt and Contract Behavior

Training prompt context now renders:

- calendar conflicts with the conflicting event title
- stale schedule reasons with explicit reflow/resync guidance
- one deduped fueling-gap line with named hard-session dates
- finance constraints with budget/training spend mode
- content commitments as workload friction

Shared decision contracts now add:

- Secretary-driven Training reflow guidance when busy/travel/fragmentation changes availability
- critical meeting protection as a Training non-negotiable
- Cooking fueling gaps as specific date-based constraints, not repeated generic warnings
- Finance budget constraints that defer gear/supplement/equipment asks
- Content next-execution context so hard doubles do not collide with creator workload

## Cross-Skill Flow Examples

### Secretary → Training

1. Secretary detects a calendar event overlaps a planned session.
2. Secretary publishes `calendar_conflict` or `training_schedule_stale`.
3. Training reads the signal before generating or explaining the next prescription.
4. Training reflows/resyncs agenda ownership before presenting the schedule as final.

### Cooking → Training

1. Cooking detects hard-session meal coverage is missing.
2. Cooking publishes or exposes `fueling_gap_risk`.
3. Training lowers, shortens, moves, or requests prep coverage.
4. The coach rationale names the concrete date once and avoids repeated generic fuel warnings.

### Finance → Training

1. Finance marks the month as tight or paid training spend as constrained.
2. Training receives budget posture through `budget_remaining`.
3. Training avoids paid gear, subscription, supplement, or equipment upgrade recommendations unless the user explicitly asks.

### Training → Content

Training already emits `content_capture_opportunity` through the mesh when adherence, recovery, or block focus creates a useful story moment. This pass keeps that behavior and makes the reverse Content → Training workload visible through `nextExecution` and publishing commitments.

## Files Changed

| File | Change |
| --- | --- |
| `src/services/intelligence-bus.ts` | Added `training_schedule_stale` signal type and expiry. |
| `src/services/training-signals.ts` | Added cross-skill source constants, publishers, reader flags, and prompt formatting. |
| `src/services/cross-agent-learning.ts` | Updated empty Training flags to include the new orchestration fields. |
| `src/services/shared-decision-context.ts` | Strengthened Training-facing Secretary, Cooking, Finance, and Content summaries/contracts. |
| `__tests__/services/training-signals.test.ts` | Added regression coverage for stale schedule, fueling gap, budget constraint, and conflict readability. |
| `__tests__/services/shared-decision-context.test.ts` | Added contract tests for schedule reflow, fueling dedupe, and content workload. |

## Validation

- `npm test -- --run __tests__/services/training-signals.test.ts`
- `npm test -- --run __tests__/services/shared-decision-context.test.ts`

## Product Impact

Training should behave less like an isolated plan generator:

- schedule changes become plan reflow inputs
- hard sessions without food support produce concrete adaptation, not repeated warnings
- tight budget posture reduces unrealistic paid recommendations
- creator workload becomes real schedule friction
- stale plan/agenda state is called out before the coach presents a final schedule
