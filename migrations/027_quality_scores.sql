-- Migration 027: Quality scoring per task execution
CREATE TABLE IF NOT EXISTS quality_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  execution_id    INTEGER REFERENCES task_execution_metrics(id),
  notion_task_id  TEXT NOT NULL,
  agent           TEXT NOT NULL,
  tests_passing   INTEGER NOT NULL DEFAULT 0,
  types_clean     INTEGER NOT NULL DEFAULT 0,
  lint_clean      INTEGER NOT NULL DEFAULT 0,
  files_changed   INTEGER NOT NULL DEFAULT 0,
  test_coverage   REAL,
  overall_score   REAL NOT NULL DEFAULT 0,
  details         TEXT
);

CREATE INDEX IF NOT EXISTS idx_quality_ts ON quality_scores (ts);
CREATE INDEX IF NOT EXISTS idx_quality_agent ON quality_scores (agent);
CREATE INDEX IF NOT EXISTS idx_quality_notion ON quality_scores (notion_task_id);

-- Rollback: DROP TABLE IF EXISTS quality_scores;
