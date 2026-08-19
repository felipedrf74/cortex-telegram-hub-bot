-- Down for 289: drop the hybrid runtime control tables; restore the pre-289
-- free/beta plan_configs local policy (no local operations, zero
-- context/output, zero cloud budget).

DROP INDEX IF EXISTS idx_hybrid_commerce_control_events_key;
DROP TABLE IF EXISTS hybrid_commerce_control_events;
DROP TABLE IF EXISTS hybrid_commerce_runtime_control;

UPDATE plan_configs SET
  local_operations_hourly = 0,
  local_operations_daily = 0,
  ordinary_context_tokens = 0,
  content_context_tokens = 0,
  script_segment_output_tokens = 0,
  local_queue_weight = 0,
  local_cloud_fallback_run_usd = 0,
  local_cloud_fallback_daily_usd = 0
WHERE plan_id IN ('free', 'beta');
