-- 276: Durable, monotonic Training consumption of Secretary agenda feedback.
--
-- Secretary agenda rows are versioned by (owner, tenant, source intent). The
-- pre-276 Training sink keyed state by the version-specific agenda_item_id and
-- ordered it by delivery time. A delayed v1 delivery could therefore appear
-- newer than an already-consumed v2 decision after a worker restart.
--
-- Legacy rows do not carry their agenda version, so recover it from the
-- authoritative Secretary ledger before collapsing duplicates. Rows whose
-- source agenda no longer exists retain the safe default version 1. New
-- durable events always carry and re-read the authoritative agenda version.

ALTER TABLE training_feedback_decisions
  ADD COLUMN agenda_version INTEGER NOT NULL DEFAULT 1
    CHECK (agenda_version > 0);

UPDATE training_feedback_decisions
SET agenda_version = COALESCE((
  SELECT agenda.version
  FROM secretary_agenda_items AS agenda
  WHERE agenda.agenda_item_id = training_feedback_decisions.agenda_item_id
    AND agenda.owner_user_id = training_feedback_decisions.user_id
    AND agenda.tenant_id = training_feedback_decisions.tenant_id
    AND agenda.source_intent_id = training_feedback_decisions.source_intent_id
    AND agenda.source_skill = 'training'
), 1);

-- This table is a compact current-state projection, not the Secretary agenda
-- history (secretary_agenda_items remains authoritative). Collapse any legacy
-- duplicates deterministically before enforcing one row per scoped intent.
DELETE FROM training_feedback_decisions
WHERE EXISTS (
  SELECT 1
  FROM training_feedback_decisions AS newer
  WHERE newer.user_id = training_feedback_decisions.user_id
    AND newer.tenant_id = training_feedback_decisions.tenant_id
    AND newer.source_intent_id = training_feedback_decisions.source_intent_id
    AND (
      newer.agenda_version > training_feedback_decisions.agenda_version
      OR (
        newer.agenda_version = training_feedback_decisions.agenda_version
        AND (
          COALESCE(julianday(newer.updated_at), 0) > COALESCE(julianday(training_feedback_decisions.updated_at), 0)
          OR (
            COALESCE(julianday(newer.updated_at), 0) = COALESCE(julianday(training_feedback_decisions.updated_at), 0)
            AND newer.id > training_feedback_decisions.id
          )
        )
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_feedback_decisions_current_intent
  ON training_feedback_decisions(user_id, tenant_id, source_intent_id);

CREATE INDEX IF NOT EXISTS idx_training_feedback_decisions_scope_version
  ON training_feedback_decisions(user_id, tenant_id, agenda_version DESC, updated_at DESC);
