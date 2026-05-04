-- AUTH-O4 + AUTH-O7 (closed-beta-auth-hardening, 2026-05-04):
--   AUTH-O4: hash refresh tokens at rest + theft-detection on rotation.
--   AUTH-O7: per-account lockout after a small number of failed logins.
--
-- ─────────────────────────────────────────────────────────────────
-- Section 1 — refresh-token hash at rest (AUTH-O4)
-- ─────────────────────────────────────────────────────────────────
--
-- Today the iOS device row stores the refresh token in plaintext at
-- `ios_devices.refresh_token`. A DB read leak (or an operator with
-- direct SQLite access) can resurrect any user session by replaying
-- the plaintext via /auth/refresh.
--
-- This migration adds:
--   - `refresh_token_hash`           — SHA-256 of the active refresh
--                                      token, looked up at /refresh.
--   - `previous_refresh_token_hash`  — SHA-256 of the PREVIOUS active
--                                      refresh token. Theft detection:
--                                      if a refresh attempt arrives
--                                      with a token that matches a
--                                      previous-only hash (i.e. the
--                                      already-rotated old token), the
--                                      backend revokes the entire
--                                      session — the only way the old
--                                      token would be in flight is if
--                                      it was stolen (the legitimate
--                                      client already holds the new
--                                      one).
--
-- We must relax the existing `refresh_token NOT NULL` constraint so
-- new rows can omit the plaintext column. SQLite has no
-- ALTER COLUMN; the canonical fix is the table-rebuild pattern.
--
-- Existing rows keep the plaintext column populated until the next
-- /refresh rotation (or until a future migration nulls them). The
-- backend code (ios-auth-session.ts) writes ONLY the hash from now on;
-- it never reads the plaintext column for auth lookups. Existing
-- sessions whose hash is NULL must re-login — closed-beta scope makes
-- this acceptable.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS ios_devices_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                     INTEGER NOT NULL,
  device_id                   TEXT NOT NULL UNIQUE,
  device_name                 TEXT,
  push_token                  TEXT,
  refresh_token               TEXT,            -- legacy; no longer authoritative
  refresh_token_hash          TEXT,            -- AUTH-O4: active token hash
  previous_refresh_token_hash TEXT,            -- AUTH-O4: theft-detection hash
  last_active_at              TEXT DEFAULT (datetime('now')),
  created_at                  TEXT DEFAULT (datetime('now'))
);

INSERT INTO ios_devices_new
  (id, user_id, device_id, device_name, push_token, refresh_token,
   refresh_token_hash, previous_refresh_token_hash, last_active_at, created_at)
SELECT
  id, user_id, device_id, device_name, push_token, refresh_token,
  NULL, NULL, last_active_at, created_at
FROM ios_devices;

DROP TABLE ios_devices;
ALTER TABLE ios_devices_new RENAME TO ios_devices;

CREATE INDEX IF NOT EXISTS idx_ios_devices_user ON ios_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_ios_devices_refresh_token_hash
  ON ios_devices(refresh_token_hash);
-- Keep the legacy plaintext index — there should be no lookups by it
-- after this migration, but the index does not hurt and dropping it is
-- a separate cleanup.
CREATE INDEX IF NOT EXISTS idx_ios_devices_refresh
  ON ios_devices(refresh_token);

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────
-- Section 2 — per-account login lockout (AUTH-O7)
-- ─────────────────────────────────────────────────────────────────
--
-- The auth router has IP-bucket rate limiting (rate-limiter.ts), but
-- distributed credential-stuffing across many IPs is unbounded against
-- a single account. We add a per-user counter that locks the account
-- after a small fixed budget of failed /login/email attempts.
--
-- Schema choice: ONE row per user (UPSERT on user_id). Counter resets
-- to zero on successful login. Lockout window is enforced via
-- `locked_until` (nullable timestamp). `last_failed_at` lets us detect
-- a stale row eligible for natural decay (e.g. if the user just gave
-- up for the day).
--
-- Lockout policy (codified in src/services/account-lockout.ts):
--   - 10 failed attempts within a sliding 15-minute window → locked
--     for the next 15 minutes from the 10th failure.
--   - Successful login clears the row.
--   - The route MUST emit an audit row on every lockout transition
--     (lock + unlock) so operators can dashboard credential-stuffing
--     attempts.

CREATE TABLE IF NOT EXISTS failed_login_attempts (
  user_id        INTEGER NOT NULL PRIMARY KEY,
  email_at_first TEXT,                          -- snapshot for operator inspection
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT,                         -- ISO8601 — start of the current window
  last_failed_at  TEXT,                         -- ISO8601 — most recent failure
  locked_until    TEXT,                         -- ISO8601 — null if not locked
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_locked_until
  ON failed_login_attempts(locked_until);
