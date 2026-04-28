# Migration 082 Rollback Rehearsal

Date: 2026-04-28

## Summary

Migration `082_training_session_identity_shape_hash.sql` was rehearsed against a safe local clone only. No production, staging, or active local runtime database was mutated.

Result: **local clone rehearsal passed**.

This closes the local structural proof for migration shape, additive behavior, and snapshot restore. It does **not** replace a true staging database rehearsal before production deployment.

## Source And Safety

| Item | Value |
| --- | --- |
| Source database | `data/bot.db` copied before mutation |
| Rehearsal directory | `.local/release-rehearsal/training-082/20260428-161547` |
| Report artifact | `.local/release-rehearsal/training-082/20260428-161547/migration-082-rehearsal-report.json` |
| Production touched | No |
| Staging touched | No |
| Active local smoke DB touched | No |

The source local DB had migrations through `070_mesh_priority.sql` recorded. The rehearsal copied it, applied pending migrations through 081 to create a pre-082 staging-like clone, snapshotted that clone, applied migration 082, then restored from the pre-082 snapshot.

## Commands

The rehearsal was run with a one-off Node script using `better-sqlite3` from the repository root. The script:

1. Copied `data/bot.db`.
2. Applied pending migrations `071` through `081` on the copy.
3. Verified migration 081 prerequisites.
4. Copied the pre-082 DB as the rollback snapshot.
5. Applied `082_training_session_identity_shape_hash.sql`.
6. Verified columns and indexes.
7. Exercised old-style and new-style Training inserts.
8. Restored from the pre-082 snapshot and verified 082 columns/indexes were absent.

## Evidence

| Check | Result |
| --- | --- |
| Pending migrations through 081 applied on clone | Pass, 11 migrations applied |
| Pre-082 clone had `fitness_training_plans.plan_version` | Pass |
| Pre-082 clone had `training_agenda_event_ownership` | Pass |
| Pre-082 clone did not have 082 identity columns | Pass |
| Migration 082 applied | Pass, 2 ms on local clone |
| `training_sessions.session_identity_key` exists after 082 | Pass |
| `training_sessions.session_shape_hash` exists after 082 | Pass |
| `training_agenda_event_ownership.session_identity_key` exists after 082 | Pass |
| `training_agenda_event_ownership.session_shape_hash` exists after 082 | Pass |
| `idx_training_sessions_identity` exists after 082 | Pass |
| `idx_training_agenda_ownership_session_identity` exists after 082 | Pass |
| Old-style `training_sessions` insert without 082 fields still works | Pass, nullable identity fields remain `NULL` |
| New-style insert with identity/hash fields preserves values | Pass |
| Ownership row with identity/hash fields preserves values | Pass |
| Snapshot restore removes 082 columns/indexes | Pass |

## Local Timing And Size

| Metric | Value |
| --- | --- |
| Pre-082 clone size | 4,239,360 bytes |
| Post-082 clone size | 4,247,552 bytes |
| Local migration 082 elapsed time | 2 ms |

These numbers are local-only and must not be used as production timing guarantees. Production/staging timing depends on real database size and indexes.

## Compatibility Notes

Migration 082 is additive:

- added nullable columns to `training_sessions`;
- added nullable columns to `training_agenda_event_ownership`;
- added two indexes.

The local rehearsal proved legacy-style SQL can still insert/read Training sessions without specifying the new columns. It did not boot commit `a3f1b78` against a migrated database, so old-code compatibility remains a deployment-readiness check rather than fully proven staging evidence.

## Remaining Production Gate

Before production migration:

1. Take a real staging or production-predeploy snapshot.
2. Apply migration 082 on a true staging database clone.
3. Run lifecycle/calendar smoke against that migrated staging clone.
4. Restore the clone from snapshot and verify the rollback path.
5. If old code rollback is a realistic path, boot or test the rollback commit against a migrated clone and confirm it ignores the additive columns.

Until that happens, migration rollback status is:

**Local rehearsal passed; real staging clone rehearsal still pending.**
