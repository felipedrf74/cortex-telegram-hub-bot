-- Migration 251 replaces permissive pointer/lineage guards with stronger
-- canonical invariants. Removing it in place would silently reopen cross-scope
-- lineage and unaudited erasure paths. Rollback therefore requires the exact
-- predecessor runtime and its archived pre-251 database snapshot.

CREATE TEMP TABLE content_workspace_251_rollback_guard (blocked INTEGER);
CREATE TEMP TRIGGER content_workspace_251_rollback_guard_trigger
BEFORE INSERT ON content_workspace_251_rollback_guard
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_rollback_requires_exact_snapshot');
END;
INSERT INTO content_workspace_251_rollback_guard(blocked) VALUES (1);
DROP TRIGGER content_workspace_251_rollback_guard_trigger;
DROP TABLE content_workspace_251_rollback_guard;

-- Unreachable by design. These statements document the migration-owned names
-- for snapshot tooling without pretending an in-place downgrade is safe.
DROP TRIGGER IF EXISTS trg_content_agent_proposals_artifact_pointer;
DROP TRIGGER IF EXISTS trg_content_agent_proposals_revision_pointer;
DROP TRIGGER IF EXISTS trg_content_agent_proposals_accepted_result_scope_update;
DROP TRIGGER IF EXISTS trg_content_agent_proposals_accepted_result_scope_insert;
DROP TRIGGER IF EXISTS trg_content_revisions_current_selection_delete;
DROP TRIGGER IF EXISTS trg_content_artifacts_current_revision_update;
DROP TRIGGER IF EXISTS trg_content_artifacts_current_revision_insert;
DROP TRIGGER IF EXISTS trg_content_artifacts_scoped_identity_immutable;
DROP TRIGGER IF EXISTS trg_content_artifacts_current_selection_delete;
DROP TRIGGER IF EXISTS trg_content_domain_objects_current_artifact_update;
DROP TRIGGER IF EXISTS trg_content_domain_objects_current_artifact_insert;
DROP TRIGGER IF EXISTS trg_content_revisions_immutable_lineage_update;
DROP TRIGGER IF EXISTS trg_content_revisions_lineage_scope_insert;
