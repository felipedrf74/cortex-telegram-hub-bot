# Codex Training Gap Analysis

Date: 2026-04-27

## Baseline System Audit

Baseline anchor: `96c61fb` before Claude's overhaul.

| Area | Baseline condition | Risk |
|---|---|---|
| Plan generation flow | Questionnaire/profile data flowed into the coach kernel, but much of the plan shape came from templates and broad heuristics. | Users with nuanced hybrid needs could receive generic weeks. |
| Session generation | Strength sessions selected exercises and duration independently. | Volume x time mismatches, especially sparse long sessions. |
| Questionnaire/profile | Inputs existed but were not normalized into a complete training profile with confidence/completeness. | Missing data did not reliably trigger better follow-up questions. |
| Exercise catalog | Catalog existed but metadata was thin. | Weak substitution, biomechanics, fatigue, and progression reasoning. |
| Metrics feedback | History use was limited and partly synthetic. | Coach could not adapt deeply to adherence, fatigue, or plateau. |
| Calendar lifecycle | Sessions could create events, but no durable event ownership map existed. | Duplicate events, stale agenda items, and unreliable cancellation cleanup. |
| Variety | Role differentiation was limited. | Consecutive strength days could be too similar. |
| Decision trail | Guidance could repeat warnings and expose noisy details. | User trust and readability degraded. |

## Claude Implementation Audit

Claude improved the baseline in many places but still left several gaps:

| Layer | Claude improvement | Remaining gap |
|---|---|---|
| Session coherence | Added estimator and validator. | Did not truly rebuild sparse sessions before Codex patch. |
| Catalog/domain model | Added metadata and biomechanics helpers. | Catalog is still not broad enough for mature gym/running/cycling coaching. |
| Variation | Added support builder and multi-week rotation. | Rotation is still not a true split-periodization engine. |
| Metrics | Added real history reads. | Needs richer feedback interpretation and future-session adjustments. |
| Agenda lifecycle | Added ownership table and cancellation marking. | Sync/backfill ownership and orphan retry were incomplete before Codex patch. |
| Adaptability | Added availability-aware day selection. | Missed sessions, travel, low-time compression, soreness, and plateau adaptation still need stronger orchestration. |

## Root Causes For Known Failures

### 1. Low volume with high reported time

Root cause: Duration and content were validated after generation, but the first Claude fix let the engine satisfy coherence by reducing the duration claim. That prevents lying but does not produce a credible session when the user asked for a 45-50 minute workout.

Codex fix: `repairUnderfilledStrengthSession` in `src/services/coach-kernel/engines/strength-engine.ts` adds missing movement patterns and increases set volume within safety bounds before it accepts a duration shrink.

### 2. Weak repeated strength days

Root cause: Original variants were shallow. Claude's static variant rotation improved this but is still table-driven. The product still needs a role-aware split planner that understands full-body, upper/lower, push/pull/legs, hypertrophy, strength, endurance support, and recovery weeks.

Codex action: Keep Claude's improvement, document that deeper split intelligence remains open. No fake randomization was added.

### 3. Agenda/calendar lifecycle failure

Root cause: Claude's ownership table was correct but not used everywhere. Sync/backfill could create or link agenda events without ownership records, and orphaned rows did not have a retry path.

Codex fixes:

- `src/api/routes/training-plan-calendar-sync.ts` records ownership for verified, matched, and created events.
- It can relink sessions from active ownership without creating duplicates.
- `src/services/training-plan-lifecycle.ts` now supports orphaned -> deleted after successful retry.
- `src/services/training-agenda-reconciliation.ts` retries exact orphaned event deletes by `event_id` and `source`.
- `src/api/routes/training-plan-generation.ts` runs reconciliation during pre-persist cancellation saga.

## Remaining Architecture Gaps

| Gap | Why it still matters | Recommended next step |
|---|---|---|
| Typed training profile | Raw questionnaire answers are not enough. | Build a normalized `AthleteTrainingProfile` with completeness/confidence and follow-up triggers. |
| Full split planner | Static rotation is not professional-coach depth. | Add weekly role assignment by goal, experience, modality mix, available days, and fatigue. |
| Endurance session coherence | Strength coherence is strongest now; running/cycling still need richer density/interval validation. | Add modality-specific estimators and validators. |
| Adaptation engine | Missed sessions and travel/low-time weeks need robust reflow. | Extend adaptation rules using adherence and availability changes. |
| Explainability cleanup | Some duplicate warnings and generic rationale can still appear. | Add a decision-trail normalizer with source-aware dedupe and priority. |
| Gender/sex-aware planning policy | The engine should use explicit relevant data only. | Add product policy and typed fields before using this in prescriptions. |
| Production reconciliation job | Codex added a service and saga calls, but no background scheduler was added. | Add a safe periodic worker for orphaned agenda event retries. |

