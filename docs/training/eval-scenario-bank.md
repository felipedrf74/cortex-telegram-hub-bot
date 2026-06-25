# Training Evaluation Scenario Bank

The scenario bank applies stressors to every canonical persona so the coach is scored on adaptation and lifecycle behavior, not just happy-path plan generation.

Source of truth: `src/services/coach-kernel/evaluation/scenarios.ts`.

## Scenarios

| ID | Category | Stressor | Expected Coach Behavior |
| --- | --- | --- | --- |
| `baseline-current-profile` | baseline | No added stressor. | Produce a coherent control plan for the persona. |
| `missed-key-session` | adaptation | User missed a recent key session. | Avoid aggressive catch-up stacking, keep load realistic. |
| `reduced-available-time` | schedule | All windows shrink to 35 minutes. | Compress sessions and respect declared availability. |
| `plan-cancel-regenerate` | calendar_lifecycle | Simulated regenerate after cancellation/version change. | Session identities should be duplicate-safe and lifecycle-aware. |
| `plateau-signals` | adaptation | Flat trailing history and moderate fatigue. | Avoid reckless progression and surface guardrail rationale. |
| `poor-recovery` | adaptation | Red readiness, low sleep, high soreness. | Downshift toward deload/recovery behavior. |
| `travel-hotel-gym` | travel | Hotel gym only, no barbell/rack, short windows. | Use travel-safe substitutions and short sessions. |
| `schedule-change-one-session-per-day` | schedule | User cannot do two-a-days this week. | Respect max one session/day. |
| `feedback-too-hard-easy-long` | feedback | User reported calibration problems. | Reduce risk and explain calibration/adaptation. |
| `missing-fueling-coverage` | feedback | Fueling context missing for key endurance work. | Surface fueling/cross-skill guidance where relevant. |
| `weak-profile-completeness` | profile_completeness | Thresholds/equipment confidence missing. | Conservative output plus profile-gap surfacing. |
| `stale-wearable-readiness` | profile_completeness | Wearable readiness exists but is stale. | Surface confidence/freshness limits and avoid aggressive progression. |
| `no-wearable-readiness` | profile_completeness | No wearable or manual readiness data is available. | Use conservative defaults without pretending precise readiness. |
| `calendar-conflicted-week` | schedule | Calendar pressure leaves only a few short windows. | Produce a schedule-compatible minimum effective week without duplicate/impossible sessions. |
| `discomfort-substitution` | safety | Knee and low-back flags added. | Avoid painful movement conflicts and preserve intent. |

## Expectations Model

Scenario expectations intentionally stay high-level:

- `shouldReduceLoad`
- `shouldRespectShortWindows`
- `requiredPhase`
- `shouldUseHotelGym`
- `shouldShowFuelingGuidance`
- `shouldSurfaceProfileGap`
- `shouldAvoidPainAreas`
- `compareWithNextVersion`
- `maxSessionsPerDay`
- `maxTotalSessions`

These expectations are consumed by the rubric, not by the planner. The benchmark must never make the engine look better by passing hidden knobs into production planning logic.

## Extension Rules

- Add scenarios for repeatable coaching risks.
- Prefer transforms that mutate `AthleteState` the same way real product signals would.
- Avoid expected exact titles, exact exercises, or exact day placements unless the product requirement is absolute.
- For lifecycle scenarios, compare stable identity and duplicate safety rather than deleting by broad date ranges.
