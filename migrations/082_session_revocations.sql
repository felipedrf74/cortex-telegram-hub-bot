-- Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
--
-- OI-ADM-302c — session revocation ledger (2026-04-24).
--
-- Append-only ledger of "invalidate any JWT issued before this
-- timestamp for this user." The auth-middleware checks the current
-- token's `iat` against the user's LATEST revoked_at; tokens issued
-- before it return 401 SESSION_REVOKED instead of proceeding.
--
-- Why a ledger and not a simple `users.sessions_revoked_at` column:
--   - Audit: we want to know when + why + by whom each revocation
--     happened (suspend cascade vs explicit user ban vs password
--     reset vs future reasons).
--   - Append-only semantics: no risk of a concurrent UPDATE clobbering
--     an in-flight revocation. INSERTs are idempotent from the
--     auth-middleware's perspective — it always reads the max(id).
--   - Future-proof: the "reason" + "actor" columns let us build per-
--     reason revocation UIs + per-actor audit trails without
--     schema churn.

CREATE TABLE IF NOT EXISTS session_revocations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Free-form reason. Conventions:
  --   'tenant.suspend'            — OI-ADM-302c cascade from tenant.status → 'suspended'.
  --   'user.ban'                  — explicit owner-action user ban.
  --   'password.reset'            — optional future use.
  --   'security.incident'         — operator-initiated blast-radius trim.
  reason        TEXT NOT NULL DEFAULT 'unspecified',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Optional metadata payload (JSON string). Kept narrow — the
  -- auth-middleware does NOT read this; it's for audit UIs.
  details_json  TEXT NOT NULL DEFAULT '{}'
);

-- Hot-path query — auth-middleware reads "latest revocation per user":
--   SELECT revoked_at FROM session_revocations
--   WHERE user_id = ?
--   ORDER BY id DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_session_revocations_user_latest
  ON session_revocations(user_id, id DESC);

-- Admin-side "list all revocations across time" query.
CREATE INDEX IF NOT EXISTS idx_session_revocations_revoked_at
  ON session_revocations(revoked_at);
