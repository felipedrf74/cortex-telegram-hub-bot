-- 316_support_tickets.sql — operator support queue for the portal.
--
-- One row per ticket (feedback, bug, incident, access request, data request,
-- task). Sources: operator-created, iOS in-app feedback, promoted from an
-- Issue or Operator Alert, or a manual email intake. Bodies are sanitized on
-- the way in and never carry chat transcripts (portal-scope-policy §3).
CREATE TABLE IF NOT EXISTS support_tickets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT NOT NULL UNIQUE,          -- NH-T-0001
  kind             TEXT NOT NULL DEFAULT 'feedback'
                     CHECK (kind IN ('feedback', 'bug', 'question', 'incident', 'access_request', 'data_request', 'task')),
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'open', 'waiting_user', 'resolved', 'closed')),
  priority         TEXT NOT NULL DEFAULT 'p3' CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  source           TEXT NOT NULL
                     CHECK (source IN ('operator', 'ios_feedback', 'issue', 'alert', 'email', 'waitlist')),
  title            TEXT NOT NULL,                  -- <= 200 chars, sanitized
  body             TEXT,                           -- <= 8000 chars, sanitized, never chat content
  user_id          INTEGER,
  tenant_id        INTEGER,
  device_id        TEXT,
  app_version      TEXT,
  os_version       TEXT,
  screen           TEXT,
  issue_id         INTEGER,
  alert_id         INTEGER,
  req_id           TEXT,
  client_error_id  INTEGER,
  external_ref     TEXT,                           -- email message id / incident doc path
  created_by       TEXT NOT NULL,                  -- operator:<hint> | user:<id> | system
  assignee         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at      TEXT,
  closed_at        TEXT,
  due_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_priority ON support_tickets (status, priority, last_event_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_issue ON support_tickets (issue_id);

CREATE TABLE IF NOT EXISTS support_ticket_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL,                     -- no FK: tickets are never deleted; CD classifier requires expand-only
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT NOT NULL,                        -- operator:<hint> | user:<id> | system
  type       TEXT NOT NULL CHECK (type IN ('created', 'comment', 'status', 'priority', 'kind', 'assignee', 'link', 'user_reply', 'system')),
  body       TEXT,                                 -- <= 4000 chars, sanitized
  meta_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket ON support_ticket_events (ticket_id, ts);
-- Rollback: DROP TABLE IF EXISTS support_ticket_events; DROP TABLE IF EXISTS support_tickets;
