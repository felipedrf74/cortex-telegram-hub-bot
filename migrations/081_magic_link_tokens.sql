-- Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
--
-- OI-NAV-203b — magic-link token machinery (2026-04-24).
--
-- Single-use, time-limited tokens for the cold-invitee signup flow
-- and any future passwordless email-auth use case. Keyed by a
-- random url-safe token_hash (we never store the raw secret — the
-- caller holds the raw token in their email; we hash it before
-- compare at consume time, so a DB snapshot does NOT let an attacker
-- forge sessions).
--
-- Schema invariants:
--   - token_hash is UNIQUE — collisions on a cryptographically
--     random source are astronomically unlikely, but a UNIQUE
--     constraint catches the day a bug reintroduces a deterministic
--     seed.
--   - intent is a CHECK-constrained string so the router can
--     switch on it safely. 'invite_signup' is the only consumer
--     in v1; future adds ('passwordless_login', 'email_verify')
--     must update the constraint with an ALTER.
--   - expires_at is NOT NULL — every token has a horizon. Consume
--     compares against datetime('now') SQLite-side to avoid JS
--     Date parsing quirks (same reasoning as tenant_invites).
--   - consumed_at lets us implement single-use via a WHERE clause
--     at consume time; we don't DELETE rows because the audit
--     trail benefits from being able to see "this token was used
--     at <ts> by user <x>" for forensics.
--   - tenant_id + invite_id are nullable because future intents
--     may not be invite-scoped.

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash      TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL,
  intent          TEXT NOT NULL
                    CHECK(intent IN ('invite_signup', 'passwordless_login', 'email_verify')),
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  invite_id       INTEGER REFERENCES tenant_invites(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}'
);

-- Lookup by hash is the hot path (consume).
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_hash ON magic_link_tokens(token_hash);

-- Admin-side "how many outstanding tokens for this email" queries.
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email ON magic_link_tokens(email, intent);

-- Garbage collection: expire-sweeper finds these.
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires ON magic_link_tokens(expires_at);
