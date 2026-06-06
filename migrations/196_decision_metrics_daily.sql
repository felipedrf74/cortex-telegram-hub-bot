-- Decision Center daily metrics rollup. One row per (metric_date, tenant_id, source_skill) so
-- dashboards read pre-aggregated counters instead of scanning the unbounded event/outcome hot
-- tables. source_skill '*' = tenant total; the column lets per-skill breakdowns land later without
-- a migration. The rollup is INSERT-OR-REPLACE (idempotent re-run). Runtime self-heals the same
-- table via ensureDecisionCenterTables().

CREATE TABLE IF NOT EXISTS decision_metrics_daily (
  metric_date TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL DEFAULT '*',
  created_count INTEGER NOT NULL DEFAULT 0,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  viewed_count INTEGER NOT NULL DEFAULT 0,
  dismissed_count INTEGER NOT NULL DEFAULT 0,
  snoozed_count INTEGER NOT NULL DEFAULT 0,
  action_succeeded_count INTEGER NOT NULL DEFAULT 0,
  action_failed_count INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0,
  gate_blocked_count INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (metric_date, tenant_id, source_skill)
);

CREATE INDEX IF NOT EXISTS idx_decision_metrics_daily_tenant
  ON decision_metrics_daily(tenant_id, metric_date);
