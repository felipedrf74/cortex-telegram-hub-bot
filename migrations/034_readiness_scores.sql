-- Readiness scores — daily Garmin-powered training readiness assessment
CREATE TABLE IF NOT EXISTS readiness_scores (
  user_id         INTEGER NOT NULL,
  date            TEXT NOT NULL,
  score           INTEGER NOT NULL,
  factors         TEXT,
  recommendation  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
