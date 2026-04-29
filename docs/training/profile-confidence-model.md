# Training Profile Confidence Model

Date: 2026-04-28  
Branch: `feature/training-weak-profile-followup-prompts`

## Purpose

The Training engine now treats profile confidence as a coaching safety signal. The model separates "how much profile data exists" from "how risky it is to plan from the remaining gaps."

This prevents the coach from silently making advanced or over-specific assumptions when critical inputs are missing.

## App-Facing Fields

`CoordinatedTrainingPlan.profileQuality` exposes:

| Field | Meaning |
| --- | --- |
| `completenessScore` | Broad profile coverage score from 0 to 100. |
| `confidenceScore` | Planning confidence score from 0 to 100 after weighting missing critical and important fields. |
| `confidenceBand` | `high`, `medium`, or `low`. |
| `planQualityLimited` | True when missing data materially limits planning quality. |
| `planningRiskFlags` | Stable machine-readable reasons for conservative planning. |
| `missingCriticalData` | Missing data items with severity, category, and planning impact. |
| `followUpPrompts` | Targeted questions that can resolve the highest-value gaps. |

These fields are additive and preserve backward compatibility for older clients.

## Scoring Inputs

Completeness is scored across these profile dimensions:

| Dimension | Examples |
| --- | --- |
| Goal clarity | Primary goal, strength goal, endurance objective. |
| Available days | Total training days and modality-specific frequency. |
| Available duration | General session duration, strength duration, endurance duration. |
| Equipment and environment | Full gym, dumbbells, bodyweight, hotel gym, outdoor route, bike/trainer. |
| Modality priority | Strength vs running vs cycling priority in hybrid plans. |
| Experience level | Beginner, intermediate, advanced, inferred vs explicit. |
| Injury and discomfort constraints | Explicit limitations or explicit "none". |
| Schedule constraints | Protected windows, long-session day, morning/lunch/evening preference. |
| Recovery baseline | Sleep/recovery readiness source or subjective baseline. |
| Preferences and dislikes | Preferred/disliked movements, modalities, constraints, notes. |
| Performance baseline | Running mileage/pace, cycling FTP/hours, lift or bodyweight markers when relevant. |

## Confidence Bands

| Band | Score | Behavior |
| --- | --- | --- |
| High | `>= 75` | Plan can use normal prescription specificity. |
| Medium | `>= 50` and `< 75` | Plan remains usable but avoids brittle assumptions. |
| Low | `< 50` | Plan becomes conservative and follow-up prompts should be surfaced prominently. |

`planQualityLimited` is true when confidence is low or critical missing data exists.

## Planning Risk Flags

The engine emits risk flags for missing data that can materially affect plan safety or quality.

| Risk Flag | Trigger | Planning Effect |
| --- | --- | --- |
| `goal_unclear` | Primary goal is missing or inferred weakly. | Avoids over-specific progression blocks. |
| `duration_unknown` | Session duration is missing. | Uses conservative fallback windows. |
| `equipment_unknown` | Strength equipment is unknown. | Avoids assuming full gym availability. |
| `limitations_unknown` | Injury/discomfort status is not explicit. | Keeps movement complexity conservative. |
| `hybrid_priority_unknown` | Hybrid goal lacks priority. | Avoids overloaded modality competition. |
| `experience_unknown` | Experience level is missing or fallback-inferred. | Uses safer complexity and progression. |
| `running_baseline_unknown` | Running plan lacks mileage/pace baseline. | Avoids aggressive intensity/load. |
| `cycling_baseline_unknown` | Cycling plan lacks FTP/hours baseline. | Avoids aggressive intensity/load. |
| `schedule_priority_unknown` | Schedule preference is unclear. | Keeps placement less specialized. |
| `recovery_baseline_unknown` | Recovery baseline is missing. | Keeps readiness assumptions conservative. |
| `preferences_unknown` | Dislikes/preferences are missing. | Avoids overconfident exercise selection. |

## Conservative Planning Behavior

When `planQualityLimited` is true, missing duration uses safe fallback windows:

| Modality | Conservative Fallback |
| --- | --- |
| Strength / gym | 35 minutes |
| Cardio / endurance | 45 minutes |

The coach still generates a plan. It does not block the user unless future product policy explicitly requires that. It marks the plan as lower-confidence and asks targeted questions.

## Follow-Up Deduplication

The profile model accepts:

- `recentlyAskedFollowUpIds`
- `resolvedFollowUpIds`

Prompts in either set are not emitted again. Missing-data risk remains visible until the underlying profile data exists, so prompt dedupe does not hide the planning limitation.

## Non-Stereotyping Rule

Sex/gender context is only used when user-provided and explicitly relevant. The confidence model does not infer physiology, capacity, or exercise selection from a generic gender label.
