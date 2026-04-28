# Training Catalog Depth Upgrade

Date: 2026-04-28  
Branch: `feature/training-engine-eval-harness`

## Executive Summary

This upgrade expands the Training engine's domain breadth across strength, running, cycling, and hybrid planning. The goal was not to add random variety. The new behavior is deterministic, profile-aware, and structured around session roles, progression slots, equipment compatibility, and hybrid interference constraints.

The work also fixed a build artifact problem: `npm run build` could leave stale coach-kernel knowledge in `dist/`, causing the evaluation harness to report false missing-template failures. The build now clears `dist/services/coach-kernel/knowledge` before copying source knowledge.

## What Changed

| Area | Change | Why |
| --- | --- | --- |
| Strength catalog | Added more push, hinge, single-leg, core, carry, and power-adjacent exercises. | Gives variants and substitutions enough depth to avoid repeated shallow sessions. |
| Strength variants | Split strength sessions into clearer roles: hypertrophy upper/lower, posterior-chain, quad-bias, max-strength, support, unilateral, trunk. | Makes 3-4 day plans feel coached instead of repeated full-body templates. |
| Strength prescription logic | Adjusted set/rep/rest logic by goal, experience, movement pattern, and power purpose. | A 45-60 minute session should contain credible work density and goal-specific intent. |
| Express strength windows | Added compact set/rest prescription handling for <30 minute windows. | Tight slots should stay truthful to the user's calendar instead of inflating a 20-minute slot into a 29-minute session. |
| Running archetypes | Added tempo progression, hill repeats, and easy + strides support work. | Running weeks can rotate quality roles without changing API session-type contracts. |
| Cycling archetypes | Added tempo/sweet spot, VO2 over-under, and cadence technique support work. | Cycling weeks no longer flatten everything into threshold/endurance/recovery. |
| Running engine | Added deterministic key-session rotation by block week and support-run rotation. | Creates structured novelty while preserving coaching intent. |
| Cycling engine | Added deterministic key-ride rotation and cadence support work. | Improves FTP/build variety without randomization. |
| Hybrid planner | Hybrid now supports gym + cycling directly, instead of silently routing all hybrid endurance through running. | Fixes a product ceiling where cycling hybrids received running sessions. |
| Build script | Clears stale dist knowledge before copy. | Prevents false eval failures and stale production artifacts. |
| Evaluation baseline | Regenerated Training eval baseline. | New baseline is `97/100` across 156 cases. |

## Strength Additions

New exercise metadata entries:

- `dumbbell_overhead_press`
- `dumbbell_floor_press`
- `dumbbell_reverse_lunge`
- `glute_bridge`
- `side_plank`
- `calf_raise`
- `kettlebell_swing`
- `inverted_row`

These include movement pattern, equipment, fatigue cost, substitution links, complexity, spinal loading, unilateral status, primary purpose, contraindication flags, and warm-up needs where relevant.

## Running Additions

New templates:

- `run_tempo_progression`
- `run_hill_repeats`
- `run_strides_aerobic`

These still use existing public `SessionType` values (`threshold_run`, `interval_run`, `easy_run`) so downstream clients do not need an immediate contract migration.

## Cycling Additions

New templates:

- `ride_tempo_sweet_spot`
- `ride_vo2_over_under`
- `ride_cadence_technique`

The engine now rotates key rides through threshold, tempo/sweet spot, and VO2 roles by block week.

## Hybrid Upgrade

Before this pass, `primaryFocus: "hybrid"` always built running + strength. A user with `priorityOrder: ["cycling", "strength"]` and `weeklySessionsTarget.cycling > 0` still received running sessions.

Now the hybrid resolver returns:

- adjusted running sessions
- adjusted cycling sessions
- adjusted strength sessions
- notes explaining the priority decision

The planner then builds only the modalities requested by the hybrid resolution.

## Why This Is Not Random Variety

Variation is deterministic:

- Running key role is selected by `currentBlock.weekIndex % 3`.
- Cycling key role is selected by `currentBlock.weekIndex % 3`.
- Strength variants already use deterministic week-index rotation and now have richer role pools.

This keeps future comparisons reproducible and lets the evaluation harness measure actual quality changes.
