-- 136: Persist Training session schedule truth.
--
-- The Training read models and reflow flow used to reconstruct the calendar
-- window from (plan.start_date + week_number + day_of_week). That loses the
-- actual placement chosen by the scheduler/Secretary and caused Week 1 to show
-- as "0 sessions" or for reflow to jump into a later week. These nullable
-- fields preserve the scheduler's real result while keeping legacy rows valid.

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

-- Rollback note: SQLite versions before 3.35 require rebuilding
-- training_sessions without these four columns/triggers/index rather than
-- relying on ALTER TABLE DROP COLUMN. The deployment runner applies migrations
-- forward only; rollback should restore from the pre-migration backup or run a
-- rebuild-table script that preserves legacy columns.
