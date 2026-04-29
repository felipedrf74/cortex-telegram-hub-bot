# Chat Migration 084/085 Staging Clone Rehearsal

Date: 2026-04-29  
Environment: staging clone only  
Result: **PASS**

## Summary

The Chat migration deployment gate for `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` has been rehearsed against a disposable clone of the staging database. The live staging database was opened read-only and copied with the SQLite online backup API; migrations were applied only to the clone.

No production database, production service, production user data, or production calendar/provider state was touched.

## Rehearsal Artifact

Remote rehearsal directory:

```text
/home/dominguez/telegram-hub-bot-staging/data/release-rehearsal/chat-084-085/20260429T081648Z
```

Key artifacts:

| Artifact | Purpose |
| --- | --- |
| `clone.db` | Restored post-rehearsal clone, returned to pre-migration state. |
| `pre-chat-084-085-snapshot.db` | Immutable pre-migration snapshot for rollback proof. |
| `migrated-proof.db` | Preserved migrated clone after applying both Chat migrations and scoped fixture checks. |
| `manifest.json` | Machine-readable proof of backup, apply, verify, and restore. |
| `083_secretary_agenda_ledger.sql` | Recovered Secretary ledger migration file included in the release package. Already applied in the source staging clone. |
| `084_chat_tenant_scope.sql` | Bundled migration SQL used in the rehearsal. |
| `085_chat_message_lifecycle.sql` | Bundled migration SQL used in the rehearsal. |
| `rehearse-chat-migrations.js` | Remote one-off rehearsal script. |

## Source Database Safety

Live staging DB:

```text
/home/dominguez/telegram-hub-bot-staging/data/bot.db
```

Observed source state:

| Check | Value |
| --- | --- |
| Source opened | read-only |
| Backup method | `better-sqlite3` online backup |
| Source size before | `9,990,144` bytes |
| Source size after | `9,990,144` bytes |
| Source mtime before | `2026-04-29T07:59:47.269Z` |
| Source mtime after | `2026-04-29T07:59:47.269Z` |
| Source mutation observed | none |

## Pre-Migration State

The clone was verified before applying Chat migrations:

- `PRAGMA integrity_check`: `ok`
- `messages.tenant_id`: absent
- `messages.scope_status`: absent
- `messages.lifecycle_state`: absent
- `conversations.tenant_id`: absent
- `conversations.scope_status`: absent
- `conversations.conversation_state`: absent

Latest staging migration filenames before the rehearsal included:

- `083_secretary_agenda_ledger.sql`
- `082_training_session_identity_shape_hash.sql`
- `081_training_agenda_event_ownership.sql`

Important note: staging already has `083_secretary_agenda_ledger.sql` recorded in `_migrations`. The release branch now includes the recovered `083_secretary_agenda_ledger.sql` file, and Chat migrations have been renumbered to `084` and `085`, so the release package is prefix-clean.

## Apply Results

Applied to clone only:

| File | Result |
| --- | --- |
| `083_secretary_agenda_ledger.sql` | already applied in the source staging clone |
| `084_chat_tenant_scope.sql` | applied |
| `085_chat_message_lifecycle.sql` | applied |

Post-apply checks:

- `PRAGMA integrity_check`: `ok`
- `_migrations` contains `083_secretary_agenda_ledger.sql`
- `_migrations` contains `084_chat_tenant_scope.sql`
- `_migrations` contains `085_chat_message_lifecycle.sql`

Expected columns verified:

- `messages`: `tenant_id`, `visibility_scope`, `scope_status`, `created_by`, `lifecycle_state`, `client_message_id`, `request_id`, `retry_of_message_uuid`, `completed_at`, `failed_at`, `canceled_at`, `error_code`, `error_message`
- `conversations`: `tenant_id`, `visibility_scope`, `scope_status`, `created_by`, `conversation_state`, `archived_at`, `deleted_at`, `errored_at`
- `shared_memory`: `tenant_id`, `visibility_scope`, `scope_status`, `created_by`
- `daily_context_cache`: `tenant_id`, `scope_status`
- `api_usage`: `tenant_id`
- `audit_trail`: `tenant_id`

Expected indexes verified:

- `idx_messages_tenant_user_created_at`
- `idx_messages_tenant_user_uuid`
- `idx_messages_tenant_user_scope`
- `idx_messages_lifecycle_scope`
- `idx_messages_client_id_scope`
- `idx_messages_request_scope`
- `idx_conversations_tenant_user_domain`
- `idx_conversations_tenant_user_scope`
- `idx_conversations_lifecycle_scope`
- `idx_shared_memory_tenant_user`
- `idx_shared_memory_tenant_user_scope`
- `idx_daily_context_tenant_user`
- `idx_api_usage_tenant_user_ts`
- `idx_audit_trail_tenant_user_ts`

## Backfill Verification

The rehearsal verified that rows with `user_id > 0` were backfilled to `tenant_id = user_id`:

| Table | Mismatched positive-user rows |
| --- | ---: |
| `messages` | 0 |
| `conversations` | 0 |
| `shared_memory` | 0 |
| `daily_context_cache` | 0 |
| `api_usage` | 0 |
| `audit_trail` | 0 |

Secretary ledger verification:

- `secretary_agenda_items` table exists in the staging source clone.
- `idx_secretary_agenda_identity` exists after rehearsal.
- The release branch includes `migrations/083_secretary_agenda_ledger.sql`, so deploy packaging no longer drops the staged Secretary ledger migration file.

## Scoped Access Fixture

A clone-only active message and clone-only quarantined message were inserted to prove scoped active reads do not expose quarantined rows.

| Check | Result |
| --- | --- |
| Fixture user | `1` |
| Active scoped query visible rows | 1 |
| Quarantined row visible in active scoped query | 0 |

No fixture data was inserted into live staging.

## Restore Proof

After preserving `migrated-proof.db`, `clone.db` was restored from `pre-chat-084-085-snapshot.db`.

Restore verification:

- `PRAGMA integrity_check`: `ok`
- pre-migration column absence restored on `clone.db`
- `clone.db-wal` / `clone.db-shm` were cleared before restore copy

## Result

Migration rehearsal gate: **closed for staging-clone proof**.

Remaining deployment caution:

- A fresh production DB snapshot is still required immediately before any production deployment.
