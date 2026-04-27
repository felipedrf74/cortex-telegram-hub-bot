# Codex Training Open Items

Date: 2026-04-27

## Release-Critical Before Public Beta

| Item | Why | Recommendation |
|---|---|---|
| Live provider smoke for agenda lifecycle | Unit tests prove exact event ownership logic; Google/Outlook behavior still needs live confirmation. | Create plan, sync, cancel, regenerate with Felipe and Jaqueline accounts on staging/TestFlight. |
| Background orphan reconciliation | Codex added precise retry service, but it currently runs through generation saga only. | Add scheduled worker or maintenance route to call `reconcileOrphanedTrainingAgendaEvents(userId)`. |
| iOS stale-state refresh after cancellation | Backend cleanup can be correct while iOS still shows old cached plan. | Ensure iOS invalidates Training/Home/Calendar surfaces after cancel/regenerate. |
| Decision-trail dedupe | Known repeated warnings still possible outside this pass. | Add source-aware guidance normalizer and tests. |

## High Priority Coach Intelligence

| Item | Current state | Next fix |
|---|---|---|
| Normalized athlete profile | Raw profile/questionnaire data is read, but no central profile confidence/completeness model exists. | Add `AthleteTrainingProfile` with normalized goals, constraints, equipment, experience, pain flags, history, and confidence. |
| True split planner | Claude rotation reduces repetition; it is not full role assignment. | Build weekly role planner: full-body, upper/lower, push/pull, endurance support, recovery, deload. |
| Endurance coherence | Strength has the strongest coherence gate. | Add running/cycling interval-density and time-estimation validators. |
| Adaptation and autoregulation | Existing adaptation is useful but not deep. | Use missed sessions, soreness, low time, travel, poor adherence, and plateau signals to reflow future sessions. |
| Progression and periodization | Progression exists in pieces. | Make block-level progression explicit by goal/experience/modality. |
| Exercise catalog depth | Metadata foundation exists. | Expand exercise catalog and modality catalog with loading, stress, substitutions, progression/regression. |

## Medium Priority Product Quality

| Item | Recommendation |
|---|---|
| Explanation quality | Explain why days differ, why volume changed, why substitution happened, and why calendar changes were made. |
| Fueling orchestration | Deduplicate repeated fueling warnings and tie advice to actual session demands. |
| Minimum-effective-dose fallback | When time is low, generate a useful compressed session rather than a generic light day. |
| Session naming | Improve names so roles are distinct and not repetitive. |
| Observability | Add structured generation IDs, plan version, session ID, and agenda ownership IDs in logs. |

## Explicitly Deferred

- Medical diagnostics.
- Sex/gender-aware prescriptions without explicit user input and policy.
- Large AI-prompt rewrite without typed contracts and deterministic validators.
- UI-only fixes for backend planning failures.

