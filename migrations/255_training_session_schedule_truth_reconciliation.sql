-- 255: Reconcile Training session schedule truth across deployed lineages.
--
-- One production lineage applied this schema as
-- 136_training_session_schedule_truth.sql before the migration catalog was
-- merged and renumbered. The historical ledger entry is retained as evidence,
-- while this uniquely numbered migration makes the same additive schema part
-- of the canonical catalog for fresh databases. The migration runner skips
-- ADD COLUMN statements whose columns already exist, and every remaining
-- object is created idempotently.

ALTER TABLE training_sessions
  ADD COLUMN scheduled_start_at TEXT;

ALTER TABLE training_sessions
  ADD COLUMN scheduled_end_at TEXT;

ALTER TABLE training_sessions
  ADD COLUMN schedule_status TEXT;

ALTER TABLE training_sessions
  ADD COLUMN schedule_reason_code TEXT;

CREATE INDEX IF NOT EXISTS idx_training_sessions_schedule_truth
  ON training_sessions(plan_id, scheduled_start_at, schedule_status);

CREATE TRIGGER IF NOT EXISTS trg_training_sessions_schedule_status_insert
BEFORE INSERT ON training_sessions
WHEN NEW.schedule_status IS NOT NULL
  AND NEW.schedule_status NOT IN (
    'pending',
    'scheduled',
    'reflowed',
    'compressed',
    'capped',
    'conflict',
    'unscheduled',
    'deferred',
    'dropped'
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid training_sessions.schedule_status');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_sessions_schedule_status_update
BEFORE UPDATE OF schedule_status ON training_sessions
WHEN NEW.schedule_status IS NOT NULL
  AND NEW.schedule_status NOT IN (
    'pending',
    'scheduled',
    'reflowed',
    'compressed',
    'capped',
    'conflict',
    'unscheduled',
    'deferred',
    'dropped'
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid training_sessions.schedule_status');
END;

-- Rollback requires the exact pre-migration snapshot for deployed databases
-- whose SQLite version cannot drop these columns without rebuilding the table.
