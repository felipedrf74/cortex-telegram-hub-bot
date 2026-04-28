# Training Evaluation Scoring Rubric

Source of truth: `src/services/coach-kernel/evaluation/rubric.ts`.

Each benchmark case receives one score per dimension from 0 to 100. Scores are weighted into a per-case score, then averaged across the full persona x scenario matrix.

## Dimensions

| Dimension | Weight | What It Measures |
| --- | ---: | --- |
| `profile_fit` | 1.2 | Whether sports, session counts, and broad plan shape fit the persona. |
| `plan_coherence` | 1.3 | Whether the plan has sessions, valid core fields, positive load, and reasonable total count. |
| `weekly_structure_quality` | 1.0 | Day spacing, max sessions/day, and key-session placement. |
| `session_role_differentiation` | 1.0 | Whether sessions have distinct roles, types, titles, and tags. |
| `variety_quality` | 1.0 | Whether repeated session signatures are avoided. |
| `time_volume_coherence` | 1.4 | Whether claimed duration matches actual content density, especially strength work. |
| `modality_quality` | 1.1 | Running, cycling, strength, and hybrid modality-specific quality checks. |
| `progression_quality` | 0.9 | Volume progression relative to recent history and phase context. |
| `adaptability_quality` | 1.2 | Response to poor recovery, low time, missed sessions, and scenario stressors. |
| `substitution_quality` | 1.0 | Equipment-safe substitutions and catalog coverage. |
| `biomechanics_quality` | 1.0 | Pain-flag avoidance, exercise complexity matching, and ordering quality. |
| `adherence_realism` | 1.0 | Whether low-adherence users receive realistic prescriptions. |
| `explainability` | 1.0 | Whether the plan exposes enough useful rationale and profile-gap information. |
| `agenda_lifecycle_correctness` | 1.2 | Duplicate-safe session IDs, start/end times, and regeneration identity safety. |
| `warning_quality_deduplication` | 0.8 | Duplicate/noisy warning and decision-trail quality. |

## Rubric Philosophy

- The harness penalizes classes of failure, not a single exact expected plan.
- Dimension scores include observations and penalties so reviewers can inspect why a branch changed.
- Dimensions below 50 are copied into the case's `criticalFailures`.
- A branch can improve with different exercises, days, or titles if the rubric quality rises.

## Known Blind Spots

The first version does not yet include:

- Full calendar provider round-trip verification.
- Human coach review labels.
- Real user satisfaction or completion data.
- Direct LLM grading of explanation quality.
- Longitudinal multi-week adherence simulation beyond regeneration comparison.

These can be layered in later without replacing the current deterministic benchmark.

