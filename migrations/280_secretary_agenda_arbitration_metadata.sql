-- Migration 280: additive Secretary arbitration-rank metadata prerequisite.
--
-- This does not enable cross-skill preemption. It records the deterministic
-- rank inputs used for newly persisted agenda rows so a later, separately
-- fenced arbitration planner can compare like-for-like policy versions.
-- Existing rows intentionally remain NULL and therefore protected from
-- priority preemption until an authoritative source intent creates a new row.

ALTER TABLE secretary_agenda_items ADD COLUMN arbitration_score INTEGER;
ALTER TABLE secretary_agenda_items ADD COLUMN arbitration_deadline_at TEXT;
ALTER TABLE secretary_agenda_items ADD COLUMN arbitration_flexibility TEXT
  CHECK (
    arbitration_flexibility IS NULL
    OR arbitration_flexibility IN ('fixed', 'flexible', 'compressible', 'splittable')
  );
ALTER TABLE secretary_agenda_items ADD COLUMN arbitration_policy_version TEXT;

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_arbitration_scope
  ON secretary_agenda_items(
    owner_user_id,
    tenant_id,
    lifecycle_state,
    start_at,
    end_at,
    arbitration_score
  );
