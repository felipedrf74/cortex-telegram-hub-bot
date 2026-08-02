-- Durable per-user OAuth connection health (migration 272).
--
-- Token presence alone cannot distinguish a healthy Google/Outlook connection
-- from a refresh token that the provider has deterministically rejected. The
-- global `integration_health` probe is not a substitute: it exercises owner
-- credentials and must never make another tenant look revoked.
--
-- This table stores current, actionable state only. It deliberately excludes
-- tokens, provider payloads, free-form error text, account identifiers, and
-- probe output. A successful re-auth or authenticated refresh deletes the row.

CREATE TABLE IF NOT EXISTS user_oauth_connection_health (
  user_id           INTEGER NOT NULL,
  tenant_id         INTEGER NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
  state             TEXT NOT NULL CHECK (state = 'auth_rejected'),
  reason_code       TEXT NOT NULL CHECK (reason_code IN (
    'invalid_grant',
    'invalid_token',
    'interaction_required',
    'token_expired',
    'token_revoked'
  )),
  first_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id, provider),
  CHECK (user_id > 0 AND tenant_id = user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_oauth_connection_health_scope_state
  ON user_oauth_connection_health (user_id, tenant_id, state);

-- Rollback: DROP TABLE IF EXISTS user_oauth_connection_health;
