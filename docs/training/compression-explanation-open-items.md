# Training Compression Explanation Open Items

Date: 2026-04-28  
Branch: `feature/training-schedule-compression-explanations`

## High Priority

1. Add route-level API regression coverage.

   The service/model layer now carries `decisionReasons`, but route/read-model tests should pin that plan retrieval surfaces them after persistence.

2. Add iOS rendering for structured decision reasons.

   iOS should render `decisionReasons` directly for capped, compressed, reflowed, unscheduled, recovery-downshifted, and weekly-cap states.

3. Validate calendar lifecycle with decision reasons.

   Staging calendar smoke should confirm `session_unscheduled` and deferred work never creates active calendar events, while `session_reflowed` updates the existing agenda mapping.

## Medium Priority

1. Add richer cross-skill source attribution.

   `sourceConstraint` currently identifies broad time/travel/recovery/capacity causes. Secretary-origin calendar conflicts should eventually include the specific conflict/event id when available.

2. Add localized copy.

   Reason text is currently backend English. iOS should either localize by reason code or request localized API text.

3. Add operator diagnostics.

   Portal/debug tooling should show before/after and evidence fields so schedule-compression bugs can be inspected without reading raw logs.

## Low Priority

1. Add reason-code analytics.

   Counting `session_compressed`, `weekly_frequency_capped`, and `session_unscheduled` by user segment would help tune profile/questionnaire quality.

## Residual Risk

The backend now explains capacity and recovery-driven compression, but the product loop is not finished until iOS renders these reasons clearly and route-level tests protect serialization.

