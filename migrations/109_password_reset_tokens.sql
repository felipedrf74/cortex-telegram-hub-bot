-- AUTH-O2 (closed-beta-auth-hardening, 2026-05-04): Password reset flow.
--
-- Tokens are opaque random bytes (256-bit) hashed at rest with SHA-256.
-- We store ONLY the hash; the token itself is delivered exactly once via
-- email and is never retrievable from the DB. This protects against:
--   - DB read leak (an attacker reading password_reset_tokens cannot
--     reset accounts; they would need the original token bytes from the
--     email transport).
--   - Server-log accidental hash leak (the hash alone is not the token).
--
-- Lifecycle:
--   1. /auth/password-reset/request inserts a row with hashed_token,
--      expires_at = now+1h, used_at = NULL.
--   2. /auth/password-reset/confirm verifies hash match + not expired
--      + not used + attempt cap not hit, then sets new password_hash and
--      stamps used_at. Single-use enforced by `used_at IS NULL` predicate.
--   3. Successful confirm revokes ALL active iOS device sessions for
--      the user (refresh tokens) so a stolen reset link cannot keep a
--      pre-reset session alive.
--
-- The `attempt_count` cap (5) is the same brute-force guard we use on
-- email verification (migration 108). Unlike a 6-digit numeric code,
-- the 256-bit token is brute-force-infeasible by entropy alone, but the
-- cap defends against:
--   - Timing oracles in equality compares (we use crypto.timingSafeEqual,
--     but defence in depth).
--   - Bot floods that consume CPU at the bcrypt step in /confirm.
--
-- A user may have AT MOST one active reset token at a time. Issuing a
-- new token via /request voids the previous active token (UPSERT on
-- user_id collapses the row). This prevents a stale email from one of
-- the user's old devices from racing a new email.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  user_id        INTEGER NOT NULL PRIMARY KEY,
  token_hash     TEXT    NOT NULL,
  email_at_issue TEXT    NOT NULL,
  expires_at     TEXT    NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  used_at        TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
  ON password_reset_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON password_reset_tokens(expires_at);
