-- CONTENT-UI-O2 (2026-05-04): per-signal Radar feedback endpoint exposed to iOS.
--
-- Background: the iOS Reaction Radar surface (`ContentIntelligenceView`
-- with .discovery focus) renders signals from the intelligence-bus but
-- has NO accept/reject/save/create-brief affordance per card. Operators
-- on the portal can dismiss signals via `POST /api/signals/:id/dismiss`,
-- but iOS cannot use that route because it sits behind the portal token.
--
-- This migration creates a tenant-scoped feedback log table that the
-- new `POST /api/v1/content/radar/feedback` route writes to. The iOS
-- per-card actions emit one of four `action` values:
--
--   - 'accept'         → user wants this opportunity surfaced more
--   - 'reject'         → user wants this opportunity downranked
--   - 'save'           → user is saving for later (no immediate action)
--   - 'create_brief'   → user is converting the signal into a brief
--
-- The table is append-only (one row per feedback event). A signal can
-- accumulate multiple feedback rows from the same user — useful for
-- temporal weighting (recent feedback dominates).
--
-- Tenant scoping: standard content scope columns. `signal_id` is TEXT
-- because intelligence-bus signal IDs are not always integers.

CREATE TABLE IF NOT EXISTS content_radar_feedback (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL,
  tenant_id            INTEGER NOT NULL,
  owner_user_id        INTEGER NOT NULL,
  visibility_scope     TEXT NOT NULL DEFAULT 'user_private',
  lifecycle_state      TEXT NOT NULL DEFAULT 'active',
  scope_status         TEXT NOT NULL DEFAULT 'active',
  created_by           INTEGER NOT NULL,
  updated_by           INTEGER NOT NULL,
  audit_metadata_json  TEXT NOT NULL DEFAULT '{}',

  signal_id            TEXT NOT NULL,
  action               TEXT NOT NULL CHECK (action IN ('accept','reject','save','create_brief')),
  reason               TEXT,
  signal_topic         TEXT,    -- snapshot at the moment of feedback (for offline analysis)
  signal_summary       TEXT,    -- snapshot at the moment of feedback

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_radar_feedback_tenant_signal
  ON content_radar_feedback(tenant_id, owner_user_id, signal_id);
CREATE INDEX IF NOT EXISTS idx_content_radar_feedback_action
  ON content_radar_feedback(tenant_id, owner_user_id, action, created_at DESC);
