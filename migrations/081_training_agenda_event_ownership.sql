-- Migration 081: Training agenda-event ownership audit table.
--
-- Slice 4.D (training-engine overhaul, 2026-04-27) — closes audit
-- regression #3 ("plans don't reliably create calendar entries;
-- cancelling/replacing doesn't reliably delete the old entries").
--
-- The pre-existing linkage between a training session and its external
-- calendar event was denormalized into two columns on `training_sessions`
-- (`calendar_event_id`, `calendar_source`). When the FK CASCADE on plan
-- deletion fired, those rows disappeared — and any external event whose
-- delete had failed transiently became impossible to reconcile (we
-- couldn't even know it had ever been ours).
--
-- This migration introduces:
--
--   1. `fitness_training_plans.plan_version` — bumps on regeneration so
--      a single plan can be superseded without losing audit identity.
--      Default 1 for backfill; new plans start at 1 and increment on
--      regenerate.
--
--   2. `training_agenda_event_ownership` — durable per-(plan_version,
--      event) record. NOT cascaded by plan deletion. Survives the FK
--      wipe so reconciliation jobs can find external events that we
--      created but couldn't delete cleanly (status='orphaned'), or
--      audit the full lifecycle (active → deleted with timestamp +
--      reason).
--
--      Status transitions:
--        active   — session row links to this event; both alive
--        deleted  — calendar delete confirmed; row remains for audit
--        orphaned — session row gone (FK cascade) but event delete
--                   failed; reconciliation queue picks this up
--
-- Rollback: DROP TABLE training_agenda_event_ownership;
--          ALTER TABLE fitness_training_plans DROP COLUMN plan_version;

ALTER TABLE fitness_training_plans
  ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS training_agenda_event_ownership (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  -- session_id is NULLABLE on purpose: when the FK cascade from plan
  -- deletion fires, the session row is gone, but the ownership row
  -- must remain so we can still audit the external event. The plan_id
  -- is also retained as a denormalized number even after the plan
  -- row itself is deleted; we never JOIN through it after deletion.
  session_id INTEGER,
  user_id INTEGER NOT NULL,
  calendar_event_id TEXT NOT NULL,
  calendar_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted', 'orphaned')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  delete_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_training_agenda_ownership_plan
  ON training_agenda_event_ownership(plan_id, plan_version);

CREATE INDEX IF NOT EXISTS idx_training_agenda_ownership_user_status
  ON training_agenda_event_ownership(user_id, status);

CREATE INDEX IF NOT EXISTS idx_training_agenda_ownership_event
  ON training_agenda_event_ownership(calendar_event_id, calendar_source);

-- Idempotency anchor: a single (plan_id, plan_version, event_id, source)
-- can never be recorded twice. Re-runs of the persistence loop become
-- a safe no-op via the application-level pre-check + this DB-level
-- backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_agenda_ownership_unique
  ON training_agenda_event_ownership(plan_id, plan_version, calendar_event_id, calendar_source);
