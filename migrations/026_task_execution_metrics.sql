-- Migration 026: Per-task execution metrics for Software Factory observability
CREATE TABLE IF NOT EXISTS task_execution_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  notion_task_id  TEXT NOT NULL,
  task_title      TEXT NOT NULL,
  agent           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  start_time      TEXT NOT NULL,
  end_time        TEXT,
  duration_ms     INTEGER,
  api_calls       INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_task_exec_ts ON task_execution_metrics (ts);
CREATE INDEX IF NOT EXISTS idx_task_exec_notion ON task_execution_metrics (notion_task_id);
CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_execution_metrics (agent);
CREATE INDEX IF NOT EXISTS idx_task_exec_status ON task_execution_metrics (status);

-- Rollback: DROP TABLE IF EXISTS task_execution_metrics;
