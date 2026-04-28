# Training Decision Reason Model

Date: 2026-04-28  
Branch: `feature/training-schedule-compression-explanations`

## Purpose

`TrainingDecisionReason` is the structured explanation contract for coach decisions that materially change a plan.

It is intentionally more precise than a generic note:

- it has a stable reason code
- it identifies the affected session or week
- it names the source constraint
- it carries before/after values
- it states the preserved coaching intent
- it carries evidence strings for debugging and QA

## Shape

```ts
interface TrainingDecisionReason {
  code: TrainingDecisionReasonCode;
  text: string;
  severity: 'info' | 'notice' | 'warning' | 'block';
  affectedEntity: {
    type: 'week' | 'session';
    id?: string;
    title?: string;
    dayOfWeek?: DayOfWeek;
  };
  sourceConstraint?: {
    type: 'capacity' | 'time' | 'travel' | 'calendar' | 'recovery' | 'fatigue' | 'interference' | 'volume' | 'equipment';
    id?: string;
    label?: string;
  };
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  preservedIntent?: string;
  evidence?: string[];
}
```

## Codes Added

| Code | Meaning |
| --- | --- |
| `session_compressed` | Duration was reduced to fit a real availability window. |
| `session_capped` | Duration was capped to stay inside a window. |
| `session_reflowed` | Session moved to a different day/window. |
| `session_unscheduled` | Session could not be placed safely. |
| `weekly_frequency_capped` | Fewer active sessions fit than originally planned. |
| `low_priority_deferred` | Lower-priority work was deferred because no safe density slot remained. |
| `recovery_volume_reduced` | Recovery/deload constraints lowered weekly stress. |
| `recovery_intensity_reduced` | Readiness reduced intensity or high-stress work. |
| `volume_growth_trimmed` | Weekly volume exceeded safe growth caps and was trimmed. |
| `schedule_density_trimmed` | Schedule density exceeded available session slots. |
| `interference_reflowed` | A session moved or softened to protect key endurance spacing. |

## Where Reasons Live

| Surface | Field |
| --- | --- |
| Session | `Session.decisionReasons` |
| Guardrail | `GuardrailResult.decisionReasons` |
| Weekly plan | `WeeklyPlan.decisionReasons` |
| Coordinated API session | `CoordinatedTrainingSession.decisionReasons` |
| Coordinated API week | `CoordinatedTrainingWeek.decisionReasons` |
| Coordinated API plan | `CoordinatedTrainingPlan.decisionReasons` |

## Deduplication

Reasons dedupe by:

- code
- affected entity type
- affected entity id
- normalized explanation text

Weekly decision notes also remove stale auto-generated `Plan adjustment:` lines before rebuilding the latest explanation set.

## UI Guidance

iOS should prefer this structured field over parsing `scheduleReason` or guardrail text.

Recommended rendering:

- `block`: prominent warning or unavailable/unscheduled state
- `warning`: visible coach adjustment note
- `notice`: inline "why this moved/changed" detail
- `info`: lower-priority debug or expanded detail

