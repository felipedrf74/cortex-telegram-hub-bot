-- 266: Index the Garmin connection status so per-user scheduled work can
-- enumerate connected users without scanning the table.
--
-- `garmin_keepalive` used to run once per tick with no request context, which
-- `resolveGarminUserId` resolved to the owner -- so only the owner's tokens
-- were ever refreshed and every other user's session decayed into
-- needs_reauth. It now fans out over `listGarminConnectedUserIds()`, whose
-- driving predicate is `WHERE status = 'active'`.
--
-- Migration 054 indexed only `user_id`, so that predicate is a full scan on
-- every tick (twice an hour, forever). This is additive and idempotent.
--
-- Deliberately NOT included: a `status` CHECK constraint and
-- `ON DELETE CASCADE` on `user_id`. SQLite cannot add either to an existing
-- table without a full table rebuild, which is not additive and is exactly
-- the irreversible shape the lean release path blocks without a rehearsal and
-- database-restore contract. Both belong in their own change with that
-- evidence. Note the code already writes a `status` value ('needs_reauth')
-- that migration 054's comment does not list, so the constraint would need
-- the real vocabulary from `integration-status.ts` rather than that comment.
--
-- Rollback: DROP INDEX IF EXISTS idx_garmin_tokens_status;

CREATE INDEX IF NOT EXISTS idx_garmin_tokens_status
  ON garmin_user_tokens(status);
