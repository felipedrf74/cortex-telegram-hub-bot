# Training Engine Production Release Notes

Date: 2026-04-28  
Backend RC: `release/training-engine-production-candidate`  
Current RC head before deploy version bump: `cef5888`

## Summary

This release hardens the Nexus Training engine for production trust: constrained-week scheduling, plan/session identity, calendar sync, cross-skill orchestration, profile/follow-up handling, recovery variation, catalog depth, and explainability have all been strengthened and tested.

Training plan generation in this release is deterministic/rule-based. Do **not** claim GPT-5.5 runtime execution for Training plan generation.

## User Impact

- Travel, constrained, and low-capacity weeks are less likely to show impossible schedules.
- Sessions can now preserve explicit schedule/lifecycle states such as capped, reflowed, unscheduled, canceled, and superseded.
- Calendar events are safer across regenerate, replace, retry, and cancellation flows.
- Weak profiles can surface targeted follow-up needs instead of silently relying on risky assumptions.
- Training guidance and decision reasons are more structured and less repetitive.
- Cross-skill signals from Secretary, Cooking, Finance, and Content are considered without duplicating warnings.

## Admin / Support Impact

- Calendar lifecycle can be inspected by plan ID, plan version, session identity key, provider event ID, and session shape hash.
- Training operational switches exist for plan generation, calendar writes/sync, and cross-skill signal publishing.
- Staging Google/Outlook lifecycle smokes passed with exact-event cleanup.
- Seeded cross-skill staging smoke passed and fixture cleanup was verified.

## Calendar Behavior Changes

- Same-shape regenerated sessions update existing event ownership.
- Changed-shape regenerated sessions can be replaced precisely.
- Canceled, deferred, dropped, superseded, and unscheduled sessions do not create active calendar events.
- Cleanup must use ownership metadata/provider event IDs. Broad date/title deletion is not allowed.

## iOS Behavior Changes

- Backend payloads remain additive and backward-compatible where practical.
- iOS local-engine smoke and rich Training fixture smoke passed before release.
- Production-safe iOS/API compatibility checks are still required after deploy.

## Known Limitations

- Production post-deploy provider validation is still required.
- Rich feedback end-to-end adaptation proof remains a follow-up product-quality item.
- Signed TestFlight/device validation for real provider state remains separate from backend production release.
- Release copy must not imply GPT-5.5 runtime execution for Training plan generation.

## Rollback

Primary rollback baseline: `a3f1b78` (`docs: record 4.14.99 Training engine overhaul release`).  
Use the documented rollback process in `docs/training/release-candidate-rollback-plan.md`.

Before deploy, take or verify the production-predeploy DB snapshot. Calendar rollback must use ownership metadata and provider event IDs only.
