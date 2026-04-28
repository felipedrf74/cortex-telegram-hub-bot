# Migration 082 Rollback Rehearsal

Date: 2026-04-28

## Summary

Migration `082_training_session_identity_shape_hash.sql` has now been rehearsed in two layers:

1. a safe local clone; and
2. a disposable true staging database clone created from the staging VPS with SQLite's online backup API.

Result: **local clone rehearsal passed and true staging clone apply/restore proof passed**.

Production was not touched.

## Source And Safety

| Item | Value |
| --- | --- |
| Local source database | `data/bot.db` copied before mutation |
| Local rehearsal directory | `.local/release-rehearsal/training-082/20260428-161547` |
| Local report artifact | `.local/release-rehearsal/training-082/20260428-161547/migration-082-rehearsal-report.json` |
| True staging clone source | `/home/dominguez/telegram-hub-bot-staging/data/bot.db` |
| True staging clone directory | `/home/dominguez/telegram-hub-bot-staging/data/release-rehearsal/training-082/20260428T162206/` |
| True staging clone DB | `/home/dominguez/telegram-hub-bot-staging/data/release-rehearsal/training-082/20260428T162206/clone.db` |
| True staging snapshot | `/home/dominguez/telegram-hub-bot-staging/data/release-rehearsal/training-082/20260428T162206/pre-082-snapshot.db` |
| Production touched | No |
| Live staging DB mutated by clone rehearsal | No |
| Active local smoke DB touched | No |

The source local DB had migrations through `070_mesh_priority.sql` recorded. The local rehearsal copied it, applied pending migrations through 081 to create a pre-082 staging-like clone, snapshotted that clone, applied migration 082, then restored from the pre-082 snapshot.

The true staging rehearsal used an online snapshot of the live staging database. The live staging database mtime/size were checked before and after clone creation during the prep step, and the clone was manipulated independently from the live staging runtime database.

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

## True Staging Clone Evidence

| Check | Result |
| --- | --- |
| Clone created from live staging DB with SQLite online backup API | Pass |
| Clone integrity before 082 | Pass, `integrity_check=ok` |
| Pre-082 clone latest migration | Pass, `081_training_agenda_event_ownership.sql` |
| Pre-082 clone did not have 082 columns | Pass |
| Bundled `apply-082.sh` applied migration 082 to clone | Pass |
| `training_sessions.session_identity_key` exists after 082 | Pass |
| `training_sessions.session_shape_hash` exists after 082 | Pass |
| `training_agenda_event_ownership.session_identity_key` exists after 082 | Pass |
| `training_agenda_event_ownership.session_shape_hash` exists after 082 | Pass |
| Old-style Training session insert without new fields works | Pass, identity/hash read back as `NULL` |
| New-style Training session insert preserves identity/hash | Pass, `plan-1:w1:wed:run:1` and `sha256:stage-clone-proof` |
| Ownership row with identity/hash fields preserves values | Pass |
| Clone integrity after insert proof | Pass, `integrity_check=ok` |
| `restore-from-snapshot.sh` restores clone back to pre-082 | Pass |
| Restored clone has no 082 migration row/columns | Pass |

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

The local and true staging clone rehearsals proved legacy-style SQL can still insert/read Training sessions without specifying the new columns. They did not boot commit `a3f1b78` against a migrated database, so old-code boot compatibility remains a lower-risk rollback check rather than a fully proven runtime boot test.

## Remaining Production Gate

Before production migration:

1. Take a production-predeploy snapshot immediately before production migration.
2. Keep the snapshot restore path available during rollout.
3. If old code rollback is a realistic path, boot or test the rollback commit against a migrated clone and confirm it ignores the additive columns.

Until that happens, migration rollback status is:

**Local rehearsal passed; true staging clone apply/restore proof passed; production-predeploy snapshot remains required at deployment time.**
