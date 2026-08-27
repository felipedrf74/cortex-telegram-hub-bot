-- Durable production activation evidence must be bound to the serving source.
-- A later release cannot inherit active/100% from a prior artifact silently.
-- Production ACTIVE is stored only in this successor-owned column while the
-- legacy mode/rollout pair remains OFF/0. A rollback to a predecessor that
-- cannot enforce the source binding therefore reads OFF instead of silently
-- reopening local-primary admission.
ALTER TABLE local_inference_runtime_control
  ADD COLUMN release_bound_mode TEXT;

ALTER TABLE local_inference_runtime_control
  ADD COLUMN activation_evidence_reference TEXT;

ALTER TABLE local_inference_runtime_control
  ADD COLUMN activation_payload_sha256 TEXT;

ALTER TABLE local_inference_runtime_control
  ADD COLUMN activation_source_binding_sha256 TEXT;

ALTER TABLE local_inference_runtime_control
  ADD COLUMN activation_producer_source_sha TEXT;
