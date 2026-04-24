-- Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
--
-- OI-DATA-005c — saved filter presets on audit viewers (2026-04-24).
--
-- Admins and tenant members hit the audit viewer's 5 filter inputs
-- (actor / action / from / to / q) repeatedly with the same
-- combinations: "all invite.* events this week," "platform-admin
-- grants ever," "my own deletes from last 7 days." Retyping them
-- is friction that amounts to a per-use cost on every audit review.
--
-- This migration adds a lightweight per-user table so the UI can
-- surface a "Saved filters" dropdown. Presets are PERSONAL (owner
-- only sees their own) — matching how presets work in every other
-- audit tool.
--
-- Schema invariants:
--   - owner_user_id is NOT NULL; orphaning a preset is pointless
--     (no one would see it).
--   - scope is CHECK-constrained to 'workspace' | 'owner' so a
--     preset saved on one surface doesn't pollute the other's
--     dropdown. The Admin Console audit viewer uses scope='owner';
--     the User Console Activity feed uses scope='workspace'.
--     Sharing the table lets a future feature merge them without
--     another migration.
--   - name is limited to 64 chars at the app layer (no CHECK here —
--     SQLite doesn't enforce length cleanly). Two presets with the
--     same name under the same owner+scope are allowed: users
--     sometimes iterate on a filter ("Invite bursts v1",
--     "Invite bursts v2") and we shouldn't gate that behind
--     uniqueness.
--   - filters_json is a free-form TEXT blob parsed at the app
--     layer. It holds the same keys the URL params carry: actor,
--     action, from, to, q. Fresh fields (e.g. a future tenant
--     filter on /owner/audit) need no schema change.
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_filter_presets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id   INTEGER NOT NULL,
  scope           TEXT NOT NULL CHECK(scope IN ('workspace', 'owner')),
  name            TEXT NOT NULL,
  filters_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Most lookups are "list MY presets for THIS scope." The composite
-- index covers that path; the trailing updated_at lets the app
-- sort by most-recently-used without a separate order-by scan.
CREATE INDEX IF NOT EXISTS idx_audit_filter_presets_owner_scope
  ON audit_filter_presets(owner_user_id, scope, updated_at DESC);
