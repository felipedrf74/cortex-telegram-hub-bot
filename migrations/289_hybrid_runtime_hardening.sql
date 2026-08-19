-- 289: Hybrid runtime hardening (NH-0040 / NH-0041)
--
-- 1. DB-backed operator control for the four hybrid kill switches, with an
--    append-only event log. Env kill switches keep working; a DB row lets an
--    operator engage a switch with audited attribution and no host restart.
-- 2. Double-capture proof note: a new UNIQUE index on the pre-existing
--    ai_credit_captures table classifies as a contract migration and would
--    block continuous delivery, and a single-column reservation_id index is
--    impossible anyway (capture allocates one row per lot in debit order).
--    The proof therefore lives as a runtime capture-conflict guard inside
--    captureAiCreditReservation's immediate transaction.
-- 3. Plan §2 local policy rows for free/beta: 5 local operations/day matching
--    the Free daily credit cap, local-policy context, zero cloud budget.
--    Inert until the free-tier local-only binding flag activates: entitlement
--    still denies free-plan model access while the flag is off.

CREATE TABLE hybrid_commerce_runtime_control (
  control_key TEXT PRIMARY KEY CHECK (control_key IN (
    'hybrid_credits',
    'apple_pack_fulfillment',
    'stripe_pack_fulfillment',
    'cloud_reasoning_fallback'
  )),
  engaged INTEGER NOT NULL DEFAULT 0 CHECK (engaged IN (0, 1)),
  reason TEXT NOT NULL DEFAULT 'migration_default_disengaged',
  actor_user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO hybrid_commerce_runtime_control (control_key, engaged)
VALUES
  ('hybrid_credits', 0),
  ('apple_pack_fulfillment', 0),
  ('stripe_pack_fulfillment', 0),
  ('cloud_reasoning_fallback', 0);

CREATE TABLE hybrid_commerce_control_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  control_key TEXT NOT NULL CHECK (control_key IN (
    'hybrid_credits',
    'apple_pack_fulfillment',
    'stripe_pack_fulfillment',
    'cloud_reasoning_fallback'
  )),
  previous_engaged INTEGER NOT NULL CHECK (previous_engaged IN (0, 1)),
  engaged INTEGER NOT NULL CHECK (engaged IN (0, 1)),
  actor_user_id INTEGER NOT NULL CHECK (actor_user_id > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_hybrid_commerce_control_events_key
  ON hybrid_commerce_control_events(control_key, created_at DESC);

UPDATE plan_configs SET
  local_operations_hourly = 5,
  local_operations_daily = 5,
  ordinary_context_tokens = 4096,
  content_context_tokens = 4096,
  script_segment_output_tokens = 2048,
  local_queue_weight = 1,
  local_cloud_fallback_run_usd = 0,
  local_cloud_fallback_daily_usd = 0
WHERE plan_id IN ('free', 'beta');
