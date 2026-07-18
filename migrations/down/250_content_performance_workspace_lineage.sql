-- Migration 250 creates immutable outcome-to-revision evidence and freezes the
-- legacy pipeline alias. A code-only downgrade could silently restore the old
-- split-brain writer or erase lineage. Rollback therefore requires the exact
-- predecessor runtime and its archived pre-250 database snapshot.

CREATE TEMP TABLE content_performance_250_rollback_guard (blocked INTEGER);
CREATE TEMP TRIGGER content_performance_250_rollback_guard_trigger
BEFORE INSERT ON content_performance_250_rollback_guard
BEGIN
  SELECT RAISE(ABORT, 'content_performance_250_rollback_requires_exact_snapshot');
END;
INSERT INTO content_performance_250_rollback_guard(blocked) VALUES (1);
DROP TRIGGER content_performance_250_rollback_guard_trigger;
DROP TABLE content_performance_250_rollback_guard;

DROP TRIGGER IF EXISTS trg_content_performance_pipeline_alias_update_blocked;
DROP TRIGGER IF EXISTS trg_content_performance_pipeline_alias_insert_blocked;
DROP TRIGGER IF EXISTS trg_content_performance_workspace_links_immutable;
DROP TRIGGER IF EXISTS trg_content_performance_workspace_links_scope_insert;
DROP INDEX IF EXISTS idx_content_performance_workspace_links_revision;
DROP INDEX IF EXISTS idx_content_performance_workspace_links_item;
DROP TABLE IF EXISTS content_performance_workspace_links;
DROP INDEX IF EXISTS idx_content_revisions_scoped_artifact_identity;
DROP INDEX IF EXISTS idx_content_artifacts_scoped_item_identity;
DROP INDEX IF EXISTS idx_content_performance_scoped_identity;
