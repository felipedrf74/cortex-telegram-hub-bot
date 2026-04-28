# Final Open Items Merge Plan

Date: 2026-04-28

## Merge Recommendation

Do not merge the old priority branches by branch pointer alone. Most historical backend priority branches still point at `d0d0c41`, but the actual work has now been packaged into the clean local backend candidate `b8f9be7` and iOS companion candidate `537abf6`. The safest path is:

1. Use `b8f9be7` as the backend review candidate and `537abf6` as the iOS companion review candidate.
2. Do not cherry-pick from the stale marker branches unless a reviewer intentionally wants to inspect history.
3. Run staging calendar and cross-skill gates.
4. Coordinate iOS compatibility/feedback release from the companion candidate after backend contract names are frozen.

## Recommended Backend Commit Order

| Order | Slice | Why This Order |
|---:|---|---|
| 1 | Catalog expansion and catalog metadata tests | Low-risk domain data foundation used by planner/recovery logic. |
| 2 | Poor-recovery variation | Uses catalog/domain metadata but does not depend on calendar identity. |
| 3 | Weak-profile follow-up prompts | Adds planning inputs and payload fields before explanation/UI contract work. |
| 4 | Constrained-week capacity reconciliation | Changes session schedule states and calendar eligibility; should land before explanations. |
| 5 | Schedule-compression explanations | Depends on capacity decisions and emits structured reasons for them. |
| 6 | Session identity with plan version + shape hash | Touches persistence, sync, cancellation, and migration; should be reviewed as one coherent lifecycle slice. |
| 7 | Calendar staging smoke harness | Harness should validate the final identity/calendar semantics. |
| 8 | Cross-skill staging smoke harness | Can land after cross-skill contracts are stable. |
| 9 | Evaluation baseline refresh and final docs | Should reflect the final integrated behavior. |

## Recommended iOS Commit Order

| Order | Slice | Why This Order |
|---:|---|---|
| 1 | Rich Training payload decoding/presentation | Must match final backend identity/lifecycle/state field names. |
| 2 | Rich feedback UI payload mapping | Additive endpoint behavior can merge after backend confirms accepted fields. |
| 3 | UI fixture injection for rich payload smoke | Needed for screenshot-level proof, but should use the final DTOs. |
| 4 | Profile follow-up and decision-reason rendering | Depends on backend contract serialization. |

## Required Local Gates Before Staging

Backend:

```bash
npm run typecheck
npm test
npm run eval:training -- --week-start 2026-04-27 --fail-under 95 --out-dir reports/training-eval/final-open-items
```

iOS:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:"Nexus HubTests/TrainingPresentationTests" -only-testing:"Nexus HubTests/TrainingHomeViewStateContractDecodingTests" -only-testing:"Nexus HubTests/TrainingFeedbackPayloadTests"
```

## Required Staging Gates Before Production

### Calendar Lifecycle

Run:

```bash
TRAINING_CALENDAR_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CALENDAR_STAGING_SMOKE=1 \
TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 \
TRAINING_CALENDAR_STAGING_USER_ID=<staging-user-id> \
TRAINING_CALENDAR_STAGING_PROVIDERS=google,outlook \
scripts/training-calendar-staging-smoke.sh
```

Required pass conditions:

- Google create/read-back/update/regenerate/cancel/cleanup pass.
- Outlook create/read-back/update/regenerate/cancel/cleanup pass.
- Retry does not duplicate events.
- Changed-shape regeneration replaces stale events.
- Same-shape regeneration reuses or updates correctly.
- Cleanup failures: none.

### Cross-Skill Runtime

Run:

```bash
TRAINING_CROSS_SKILL_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging-user-id> \
scripts/training-cross-skill-staging-smoke.sh
```

Required pass conditions:

- Secretary conflict flow passes.
- Cooking fueling gap flow passes.
- Finance budget constraint flow passes.
- Content workload or milestone flow passes, or blocked fixture gaps are explicitly documented.
- No duplicated warnings.
- No stale/wrong-tenant context.

### iOS Rich Payload Smoke

Required pass conditions:

- Live app opens Home and Training on iPhone 17 Pro simulator.
- Rich fixture injection renders capped, reflowed, unscheduled, canceled, superseded, gym, running, cycling, and hybrid payloads.
- Session detail shows full arrays/blocks, not first-exercise-only content.
- No clipping in long rich sessions.
- Feedback sheet can submit completed, partial, and skipped flows against staging or a controlled mock backend.

## Rollout Plan

1. **Integration branch only**
   - Split and commit the backend work.
   - Split and commit the iOS work.
   - Update API specs for final field names.

2. **Local verification**
   - Run backend typecheck/test/eval.
   - Run iOS focused tests.
   - Fix regressions before staging.

3. **Staging verification**
   - Deploy backend to staging.
   - Run Google/Outlook calendar lifecycle smoke.
   - Run cross-skill staging smoke.
   - Run iOS simulator against staging.

4. **Limited TestFlight**
   - Enable for founder/test accounts only.
   - Monitor calendar create/update/delete, feedback submissions, stale-plan state, and warning duplication.

5. **Production promotion**
   - Promote only after staging smoke results are attached to the release packet.
   - Keep rollback notes for migration `082_training_session_identity_shape_hash.sql`.
   - Keep Training calendar sync feature flag or rollback path ready.

## Recommended Rollback Notes

- Backend rollback must account for migration `082_training_session_identity_shape_hash.sql`.
- Calendar smoke events are marked with `[NEXUS TRAINING STAGING]` and `NEXUS_TRAINING_IDENTITY`; cleanup must be marker/event-ID based, never broad date/title deletion.
- If iOS rich feedback causes backend compatibility issues, older server versions should ignore additive fields, but complete/skip route behavior must be verified before rollout.
- If capacity reconciliation creates unexpected inactive sessions, disable calendar sync for inactive states before reverting the whole planner.

## Recommended Next Priorities

1. Close Google/Outlook staging smoke.
2. Close cross-skill staging smoke.
3. Add backend rich-feedback persistence/adaptation tests.
4. Add iOS rich Training fixture injection and screenshot smoke.
5. Wire Secretary busy windows directly into the engine capacity model.
6. Add API/iOS rendering tests for `profileQuality` and `decisionReasons`.
7. Decide product treatment for deferred/unscheduled sessions after reload.
