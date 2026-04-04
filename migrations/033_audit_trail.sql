-- Audit trail for GDPR compliance — logs data access, export, and delete operations
CREATE TABLE IF NOT EXISTS audit_trail (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  user_id         INTEGER NOT NULL,
  actor_id        INTEGER NOT NULL,
  action          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  details         TEXT,
  ip_address      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_trail (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_trail (action, ts);
