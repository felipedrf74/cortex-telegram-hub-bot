-- 261: Durable aggregate-only M14 routing-clarify budget telemetry.
--
-- One UTC row per day. Deliberately excludes tenant/user ids, prompts,
-- candidate labels, and response text; the dashboard needs only the
-- clarified/evaluated ratio and the approved 10% ceiling.

CREATE TABLE IF NOT EXISTS chat_routing_clarify_metrics_daily (
  metric_date TEXT PRIMARY KEY,
  evaluated_turns INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_turns >= 0),
  clarified_turns INTEGER NOT NULL DEFAULT 0 CHECK (
    clarified_turns >= 0 AND clarified_turns <= evaluated_turns
  ),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(metric_date) = 10)
);
