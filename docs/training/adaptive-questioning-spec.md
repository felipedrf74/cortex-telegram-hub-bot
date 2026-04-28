# Training Adaptive Questioning Spec

## Purpose

Adaptive questioning gives the Training engine a way to recognize weak coaching context and ask the smallest useful next question. It is not a generic onboarding checklist.

## Question Trigger Rules

| Trigger | Severity | Follow-Up ID | Prompt Intent |
| --- | --- | --- | --- |
| Missing primary objective | Critical | `primary_goal_clarification` fallback shape | Ask what the user is training for. |
| Missing available session duration | Critical | `session_duration_clarification` | Stop using broad default windows when actual time is unknown. |
| Strength work with unknown equipment | Critical | `equipment_clarification` | Choose credible exercises and substitutions. |
| No explicit injury/limitation answer | Critical | `injury_limitation_clarification` | Make "none" an explicit answer instead of an assumption. |
| Hybrid plan without clear modality priority | Critical | `modality_priority_clarification` | Decide which modality wins under time/fatigue conflicts. |
| Missing or fallback-inferred experience | Important | `experience_level_clarification` | Keep exercise complexity and progression conservative until level is explicit. |
| High-frequency plan without protected schedule windows | Important | `schedule_priority_clarification` | Improve placement of key sessions. |
| Running plan without current mileage/pace | Important | `running_baseline_clarification` | Calibrate load and intensity. |
| Cycling plan without FTP/hours | Important | `cycling_baseline_clarification` | Calibrate load and intensity. |
| Short generic duration with strength work | Important | `strength_duration_clarification` | Confirm whether gym sessions can run longer or must stay compressed. |
| Missing recovery baseline | Optional | `recovery_feedback_clarification` | Improve readiness and adaptation. |
| Missing preferences/dislikes | Optional | `preferences_dislikes_clarification` | Avoid overconfident exercise selection and repeated unwanted work. |
| No outcome feedback loop | Optional | `training_feedback_loop` | Capture too easy/hard/long feedback for future planning. |

## Priority Semantics

- `high`: should be surfaced before or during plan generation because it changes plan safety or modality structure.
- `medium`: useful before the next regeneration or adaptation.
- `low`: improves future personalization but should not block initial plan creation.

## Runtime Behavior

The engine still produces a plan when data is missing. Missing data is surfaced as:

- `AthleteState.profileQuality.missingCriticalData`
- `AthleteState.profileQuality.followUpQuestions`
- `CoordinatedTrainingPlan.profileQuality`
- high-priority `Profile follow-up:` notes in weekly plans

This keeps the product usable while telling the user and operators what information would materially improve planning.

Repeated prompts can be suppressed with `recentlyAskedFollowUpIds` and `resolvedFollowUpIds`, while the missing-data risk remains visible until the actual profile data is present.

## Non-Stereotyping Rule

Sex/gender context is captured only if the user provides it. The planner does not use male/female labels to alter volume, intensity, or exercise selection. Future changes may use explicit relevant context such as pregnancy, postpartum return, or menstrual-cycle data only when the user provides that context and the logic is test-backed.
