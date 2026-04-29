# Chat Migration And Backfill Plan

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Migration

Migration: `migrations/084_chat_tenant_scope.sql`

The migration:

- adds `tenant_id`, `visibility_scope`, `scope_status`, and `created_by` to `messages`;
- adds the same fields to `conversations`;
- rebuilds `shared_memory` with `UNIQUE(tenant_id, user_id, key)`;
- rebuilds `daily_context_cache` with primary key `(tenant_id, user_id, date)`;
- adds `tenant_id` to `api_usage` and `audit_trail`;
- backfills safe rows as `tenant_id = user_id`;
- marks rows with missing or invalid user/tenant scope as `scope_status = 'quarantined'` and `visibility_scope = 'system_internal'`;
- adds tenant/user/scope indexes for runtime reads.

## Source Of Truth

Current canonical tenant identity is `users.id`. Existing Chat rows are safe to backfill as `tenant_id = user_id` when `user_id > 0`.

Rows with `user_id <= 0` or `tenant_id <= 0` after backfill are ambiguous. They are not deleted in the migration, but they are quarantined and excluded from Chat accessors.

## Rollback

SQLite cannot safely drop added columns in place. Rollback strategy:

1. restore the pre-migration DB snapshot;
2. redeploy previous code;
3. confirm no `084_chat_tenant_scope.sql` entry remains in `_migrations`;
4. rerun Chat history and shared-memory smoke on the restored DB.

## Validation Required

- Apply migration to a disposable copy first. Closed for staging-clone proof on 2026-04-29; see `docs/chat/chat-migration-084-085-rehearsal.md`.
- Verify `messages`, `conversations`, `shared_memory`, `daily_context_cache`, `api_usage`, and `audit_trail` contain expected scope columns.
- Insert active and quarantined rows; prove active accessors return only active rows in the matching tenant.
- Run focused Chat tenant-isolation tests.
- Run full typecheck.
- Run local full-product Chat smoke before staging.

## Production Caution

The migration is additive/rebuild-based but touches high-sensitivity Chat state. Do not apply directly to production without a fresh backup and restore rehearsal.
