-- Operator alert delivery lifecycle.
--
-- Migration 076 created the durable alert queue. This extends that queue with
-- an explicit on-call delivery state so created alerts can be retried,
-- dead-lettered, and audited separately from human acknowledgement/resolution.

ALTER TABLE operator_alerts
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'dead_letter', 'not_configured'));

ALTER TABLE operator_alerts
  ADD COLUMN delivered_at TEXT;

ALTER TABLE operator_alerts
  ADD COLUMN last_delivery_attempt_at TEXT;

ALTER TABLE operator_alerts
  ADD COLUMN next_delivery_attempt_at TEXT;

ALTER TABLE operator_alerts
  ADD COLUMN delivery_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE operator_alerts
  ADD COLUMN last_delivery_error TEXT;

ALTER TABLE operator_alerts
  ADD COLUMN dead_lettered_at TEXT;

ALTER TABLE operator_alerts
  ADD COLUMN owner TEXT NOT NULL DEFAULT 'ops';

ALTER TABLE operator_alerts
  ADD COLUMN suspected_area TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE operator_alerts
  ADD COLUMN user_impact TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE operator_alerts
  ADD COLUMN runbook_url TEXT NOT NULL DEFAULT 'docs/OBSERVABILITY-ONCALL.md';

CREATE INDEX IF NOT EXISTS idx_operator_alerts_delivery_due
  ON operator_alerts (delivery_status, next_delivery_attempt_at, created_at DESC)
  WHERE delivery_status IN ('pending', 'failed');
