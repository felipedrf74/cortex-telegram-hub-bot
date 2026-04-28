# Feedback Loop Open Items

## High Priority

1. iOS should send richer structured feedback.
   - Current backend can consume RPE, duration, soreness, actual exercises, and inferred tags.
   - The app should expose explicit fields for partial completion, too hard, too easy, too long, pain/discomfort, substitutions used, and time lost.

2. Persist explicit skipped-session reasons.
   - The engine can reason from compliance and `RecentSession` skip samples.
   - Current completion history primarily stores completed rows; skipped status is still less detailed than completed feedback.

3. Integrate per-lift progression reports into plan generation.
   - `progression-analytics.ts` already extracts lift trajectories.
   - The next slice should feed those trajectories into strength exercise selection and loading guidance.

4. Integrate running/cycling progression reports into plan generation.
   - Cardio progression extraction exists.
   - The next slice should translate pace/distance/volume trends into session role and duration changes.

## Medium Priority

1. Make substitution feedback structured.
   - Current tag inference can detect substitution text in `actual_exercises_json`.
   - Better: store a typed list of substitutions used and why.

2. Add feedback confidence.
   - The current layer uses sample size and bounded decisions, but it does not expose a separate confidence score.

3. Add sport-specific decision weighting.
   - RPE 9 after a race-specific interval day should mean something different from RPE 9 after a casual support lift.

4. Add block-transition policy.
   - The new layer can shift build/hold/deload/reentry/variation.
   - It should eventually write durable phase memory when a transition is triggered repeatedly.

## Low Priority

1. Add richer observability dashboards for feedback decisions.
2. Show feedback-loop decisions in admin/product QA views.
3. Add longitudinal tests across multiple generated weeks, not just single-week decisions.

## Not Done In This Slice

- No production deploy.
- No iOS UI changes.
- No database migration.
- No new dependencies.
