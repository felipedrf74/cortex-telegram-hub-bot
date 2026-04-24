-- Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
--
-- OI-SEC-001a — admin-session magic-link intent (2026-04-24).
--
-- Before this migration, `magic_link_tokens.intent` was
-- CHECK-constrained to the 3 user-facing intents that landed with
-- migration 081:
--   'invite_signup' | 'passwordless_login' | 'email_verify'
--
-- OI-SEC-001 shipped signed admin session JWTs but left the only
-- way to mint them as a CLI (`scripts/mint-admin-token.ts`). That
-- works for Felipe over SSH but blocks any other future platform
-- admin who doesn't have shell access. OI-SEC-001a closes that
-- gap by wiring a magic-link flow: admin enters email → server
-- issues a token → email link resolves to a fresh admin session
-- JWT, no shell access required.
--
-- We use a NEW intent 'admin_session' rather than overloading
-- 'passwordless_login' because the two flows have different
-- security postures and different handler logic:
--
--   passwordless_login → mints a user session JWT (via
--       IOS_API_JWT_SECRET), scopes the caller to their OWN
--       workspace, fire-and-forget on welcome email.
--   admin_session      → mints an ADMIN session JWT (via
--       PORTAL_ADMIN_JWT_SECRET), gives /owner/* cross-tenant
--       access, and requires the target userId to be in
--       `platform_admins` at consume time.
--
-- Mixing them would mean the consume handler has to demux based on
-- metadata — a footgun where a bug in the metadata check could
-- silently upgrade a user to admin. Distinct intents keep the
-- routing trivially unambiguous.
--
-- SQLite doesn't support altering a CHECK constraint in place, so
-- this migration rebuilds the table. The rebuild preserves every
-- existing row (INSERT INTO magic_link_tokens SELECT ... FROM
-- _old), every index is recreated after, and the foreign-key
-- references remain valid because we only touch this table.
-- ───────────────────────────────────────────────────────────────

BEGIN;

-- Park existing rows + drop the constrained version.
ALTER TABLE magic_link_tokens RENAME TO _old_magic_link_tokens_084;

-- Rebuild with the expanded CHECK. Everything else matches the
-- original 081 schema verbatim — we only change the intent
-- allowlist to include 'admin_session'.
CREATE TABLE magic_link_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash      TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL,
  intent          TEXT NOT NULL
                    CHECK(intent IN (
                      'invite_signup',
                      'passwordless_login',
                      'email_verify',
                      'admin_session'
                    )),
  tenant_id       INTEGER,
  invite_id       INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_by     INTEGER,
  metadata_json   TEXT
);

-- Port forward every existing token. Order matches the CREATE.
INSERT INTO magic_link_tokens (
  id, token_hash, email, intent, tenant_id, invite_id,
  created_at, expires_at, consumed_at, consumed_by, metadata_json
)
SELECT
  id, token_hash, email, intent, tenant_id, invite_id,
  created_at, expires_at, consumed_at, consumed_by, metadata_json
FROM _old_magic_link_tokens_084;

-- Retire the old table.
DROP TABLE _old_magic_link_tokens_084;

-- Recreate every index from migration 081 (SQLite drops indexes
-- when the underlying table is dropped). This list must match
-- 081 byte-for-byte — diverging adds silent performance
-- regressions on the consume hot path.
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_hash
  ON magic_link_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email
  ON magic_link_tokens(email, intent);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires
  ON magic_link_tokens(expires_at);

COMMIT;
