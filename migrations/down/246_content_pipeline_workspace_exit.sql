-- Migration 246 cannot be reversed once ingress evidence exists: the
-- canonical item may already have revisions, approvals, schedules, or agent
-- proposals. Refuse before mutating schema rather than deleting that history.

CREATE TEMP TABLE content_pipeline_246_rollback_guard (blocked INTEGER);
CREATE TEMP TRIGGER content_pipeline_246_rollback_guard_trigger
BEFORE INSERT ON content_pipeline_246_rollback_guard
WHEN EXISTS (SELECT 1 FROM content_workspace_ingress_bindings LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'content_pipeline_246_rollback_requires_zero_ingress_bindings');
END;
INSERT INTO content_pipeline_246_rollback_guard(blocked) VALUES (1);
DROP TRIGGER content_pipeline_246_rollback_guard_trigger;
DROP TABLE content_pipeline_246_rollback_guard;

DROP TRIGGER IF EXISTS trg_content_workspace_ingress_hash_immutable;
DROP TRIGGER IF EXISTS trg_content_workspace_ingress_parity_update;
DROP TRIGGER IF EXISTS trg_content_workspace_ingress_scope_update;
DROP TRIGGER IF EXISTS trg_content_workspace_ingress_scope_insert;
DROP TRIGGER IF EXISTS trg_content_pipeline_legacy_update_blocked;
DROP TRIGGER IF EXISTS trg_content_pipeline_legacy_insert_blocked;
DROP INDEX IF EXISTS idx_content_workspace_ingress_item;
DROP TABLE IF EXISTS content_workspace_ingress_bindings;
