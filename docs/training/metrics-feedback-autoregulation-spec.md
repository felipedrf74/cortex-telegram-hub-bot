# Metrics, Feedback, and Autoregulation Spec

## Purpose

The Training engine must adapt from evidence, not simply regenerate a static plan. This slice introduces a typed feedback analysis layer that reads recent performance, adherence, recovery, and user feedback before weekly sessions are built.

## Inputs

The feedback layer currently consumes:

- Completion status: completed, partial, skipped.
- Planned vs actual duration.
- RPE and RIR when logged.
- Soreness and energy level when logged.
- Running/cycling distance when available in `actual_exercises_json`.
- Readiness score and readiness level.
- Trailing adherence, missed key sessions, and consecutive misses.
- Training-history weekly volume by sport.
- Explicit feedback tags inferred from logs: too hard, too easy, too long, substitution, pain, travel, time loss.
- Time/injury/fatigue constraints from the profile.

## Normalization

`src/services/training-history.ts` now converts recent `training_completions` rows into `RecentSession` samples. It normalizes:

- Raw session types into coach-kernel sport and session-type enums.
- Actual duration and planned duration.
- RPE, soreness, energy, distance, and feedback tags.
- Partial completions when actual duration is materially below planned duration.

The planner does not depend on free-form notes directly. Notes are only used to infer narrow, typed tags such as substitution or travel.

## Analysis Layer

`src/services/coach-kernel/feedback-analysis.ts` produces `TrainingFeedbackAnalysis`.

It classifies:

- Adherence: strong, steady, fragile, broken.
- Recovery: ready, watch, strained, critical.
- Difficulty bias: too easy, balanced, too hard, too long, mixed.
- Progression state: build, hold, deload, reentry, variation.

It emits decisions such as:

- `low_recovery_deload`
- `high_soreness_downshift`
- `poor_adherence_reentry`
- `missed_key_session_rebuild`
- `duration_compression`
- `too_long_duration_cap`
- `too_hard_intensity_downshift`
- `too_easy_progression`
- `positive_progression`
- `plateau_variation`
- `repeated_substitution_review`

## Planner Integration

The weekly planner now runs:

1. Analyze feedback from `AthleteState`.
2. Adjust the athlete state before session generation.
3. Build candidate sessions through the existing modality engines.
4. Apply feedback-derived session adjustments.
5. Apply existing guardrails.

This keeps the coach deterministic and testable while preserving existing engine boundaries.

## Product Behavior

Examples:

- Low readiness plus high soreness shifts the week toward deload behavior.
- Poor adherence or repeated misses lowers session targets and caps max sessions per day for re-entry.
- Easy feedback with strong adherence and recovery progresses strength sets or endurance duration conservatively.
- Sessions that routinely run long get capped shorter.
- Flat training-history trends trigger variation tags instead of blindly repeating the same stimulus.

## Non-Goals

- This slice does not introduce medical diagnosis.
- This slice does not replace the exercise catalog or sport-specific engines.
- This slice does not add a new API contract. It hardens backend engine state and plan output.
