-- Canonical artifacts and immutable revisions may have become the basis of
-- edits, approvals, schedules, or proposals. A code-only down migration would
-- destroy that lineage, so rollback requires the exact pre-252 DB snapshot.

CREATE TEMP TABLE content_legacy_script_252_rollback_guard (blocked INTEGER);
CREATE TEMP TRIGGER content_legacy_script_252_rollback_guard_trigger
BEFORE INSERT ON content_legacy_script_252_rollback_guard
WHEN EXISTS (SELECT 1 FROM content_legacy_script_ingress_bindings LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'content_legacy_script_252_rollback_requires_exact_snapshot');
END;
INSERT INTO content_legacy_script_252_rollback_guard(blocked) VALUES (1);
DROP TRIGGER content_legacy_script_252_rollback_guard_trigger;
DROP TABLE content_legacy_script_252_rollback_guard;

DROP TRIGGER IF EXISTS trg_content_scripts_legacy_user_update_blocked;
DROP TRIGGER IF EXISTS trg_content_scripts_legacy_user_insert_blocked;
DROP TRIGGER IF EXISTS trg_content_legacy_script_ingress_immutable;
DROP TRIGGER IF EXISTS trg_content_legacy_script_ingress_scope_insert;
DROP INDEX IF EXISTS idx_content_legacy_script_ingress_item;
DROP TABLE IF EXISTS content_legacy_script_ingress_bindings;
