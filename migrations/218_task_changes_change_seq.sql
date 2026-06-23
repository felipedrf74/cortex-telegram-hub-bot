-- Migration 218: Materialize a sargable task changes cursor key.
--
-- SQLite cannot use an index efficiently when the changes endpoint wraps
-- updated_at/deleted_at in julianday(COALESCE(...)). Store the effective
-- change timestamp in one canonical text column and keep it current with
-- triggers so every legacy write path benefits from the same cursor index.

ALTER TABLE unified_tasks
  ADD COLUMN change_seq TEXT;

UPDATE unified_tasks
SET change_seq = COALESCE(
  strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(deleted_at, updated_at, created_at)),
  COALESCE(deleted_at, updated_at, created_at),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
WHERE change_seq IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_unified_tasks_change_seq_insert
AFTER INSERT ON unified_tasks
WHEN NEW.change_seq IS NULL
BEGIN
  UPDATE unified_tasks
  SET change_seq = COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(NEW.deleted_at, NEW.updated_at, NEW.created_at)),
    COALESCE(NEW.deleted_at, NEW.updated_at, NEW.created_at),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_unified_tasks_change_seq_update
AFTER UPDATE OF deleted_at, updated_at, created_at ON unified_tasks
BEGIN
  UPDATE unified_tasks
  SET change_seq = COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(NEW.deleted_at, NEW.updated_at, NEW.created_at)),
    COALESCE(NEW.deleted_at, NEW.updated_at, NEW.created_at),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  WHERE rowid = NEW.rowid;
END;

CREATE INDEX IF NOT EXISTS idx_unified_tasks_changes_seq
  ON unified_tasks(tenant_id, user_id, change_seq, nexus_task_id);
