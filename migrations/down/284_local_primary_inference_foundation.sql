-- Test/rehearsal inverse for migration 284.
-- Production rollback does not execute this contract operation: it sets both
-- runtime rows OFF and restores the predecessor image against the additive
-- schema. This inverse exists for isolated migration verification only.

DROP TABLE IF EXISTS content_script_job_checkpoints;
DROP TABLE IF EXISTS content_script_jobs;
DROP TABLE IF EXISTS skill_inference_attempts;
DROP TABLE IF EXISTS internal_inference_request_nonces;
DROP TABLE IF EXISTS local_inference_account_deletion_fences;
DROP TABLE IF EXISTS skill_inference_runs;
DROP TABLE IF EXISTS local_inference_safety_incidents;
DROP TABLE IF EXISTS local_inference_control_events;
DROP TABLE IF EXISTS local_inference_runtime_control;

ALTER TABLE plan_configs DROP COLUMN local_queue_weight;
ALTER TABLE plan_configs DROP COLUMN local_cloud_fallback_daily_usd;
ALTER TABLE plan_configs DROP COLUMN local_cloud_fallback_run_usd;
ALTER TABLE plan_configs DROP COLUMN script_segment_output_tokens;
ALTER TABLE plan_configs DROP COLUMN content_context_tokens;
ALTER TABLE plan_configs DROP COLUMN ordinary_context_tokens;
ALTER TABLE plan_configs DROP COLUMN active_content_jobs;
ALTER TABLE plan_configs DROP COLUMN longform_scripts_daily;
ALTER TABLE plan_configs DROP COLUMN local_operations_daily;
ALTER TABLE plan_configs DROP COLUMN local_operations_hourly;
