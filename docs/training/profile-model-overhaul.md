# Training Profile Model Overhaul

Date: 2026-04-28  
Branch: `feature/training-engine-eval-harness`

## Executive Summary

The Training engine now has a normalized coaching profile layer. Questionnaire data is no longer consumed only as scattered raw JSON fields inside the plan generator. The generator now builds a `NormalizedTrainingProfile`, attaches profile quality to `AthleteState`, and uses that profile to shape availability windows, planning notes, and follow-up prompts.

The goal is not to ask more questions. The goal is to convert answers into planning-relevant structure and know when the engine is planning from weak assumptions.

## What Changed

| Area | Change | Why |
| --- | --- | --- |
| Structured extraction | Added `src/services/training-profile-model.ts`. | Centralizes profile normalization instead of spreading raw questionnaire reads across the generator. |
| Athlete state | Added optional `normalizedTrainingProfile` and `profileQuality` to `AthleteState`. | Lets the coach kernel carry profile quality and follow-up needs through planning without changing the public plan API. |
| Profile quality | Added completeness score, confidence score, missing critical data, source summary, and follow-up questions. | Makes weak profile truth explicit and testable. |
| Session duration | Profile-provided duration now shapes availability windows. | A user with 30-minute sessions gets short windows; a user with 60-minute gym time gets fuller sessions. |
| Follow-up notes | Weekly plans include high-priority profile follow-up notes. | The engine can ask targeted questions while still producing a plan. |
| Sex/gender handling | Captures explicit sex/gender context only if provided, but does not alter training unless explicitly relevant context is present. | Avoids hidden stereotypes while preserving future support for relevant explicit context. |

## Normalized Profile Fields

The normalized model includes:

- goals and strength goal
- experience level and source
- available days by modality
- available session durations
- modality priorities and requested sessions
- equipment and environment
- schedule constraints
- discomfort and limitation flags
- recovery baseline
- consistency/adherence tendencies
- current markers such as mileage, pace, FTP, bodyweight, and lift estimates
- optional explicit sex/gender context
- quality scores and follow-up questions

## Planning Impact

Current direct planning impact:

- Availability windows now respect explicit duration fields such as `session_duration_minutes`, `strength_session_duration_minutes`, and similar profile fields.
- Missing critical profile data surfaces as plan notes through high-priority follow-ups.
- Profile quality is attached to `AthleteState` for downstream orchestration and future UI/API surfacing.

Existing behavior preserved:

- Public plan contract remains stable.
- Existing callers without duration/profile quality fields still use legacy fallback windows.
- Sex/gender values do not change plan shape unless explicit relevant context is provided and future logic chooses to use it.

## Key Files

- `src/services/training-profile-model.ts`
- `src/services/coach-kernel/types.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/coach-kernel/planner-engine.ts`
- `__tests__/services/training-profile-model.test.ts`

