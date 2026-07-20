-- Canonical idea items and immutable revisions may have been edited, tagged,
-- scheduled, or used by agents after import. Once any binding exists, inverse
-- SQL cannot reconstruct safe pre-cutover authority. Restore the exact
-- predecessor runtime and exact pre-253 database snapshot instead.

CREATE TEMP TABLE content_legacy_idea_note_253_rollback_guard (blocked INTEGER);
CREATE TEMP TRIGGER content_legacy_idea_note_253_rollback_guard_trigger
BEFORE INSERT ON content_legacy_idea_note_253_rollback_guard
WHEN EXISTS (SELECT 1 FROM content_legacy_idea_note_ingress_bindings LIMIT 1)
  OR EXISTS (SELECT 1 FROM content_legacy_saved_idea_ingress_bindings LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'content_legacy_idea_note_253_rollback_requires_exact_snapshot');
END;
INSERT INTO content_legacy_idea_note_253_rollback_guard(blocked) VALUES (1);
DROP TRIGGER content_legacy_idea_note_253_rollback_guard_trigger;
DROP TABLE content_legacy_idea_note_253_rollback_guard;

DROP VIEW IF EXISTS content_legacy_idea_note_workspace_readiness;
DROP VIEW IF EXISTS content_legacy_saved_idea_workspace_readiness;
DROP TRIGGER IF EXISTS trg_saved_ideas_bound_source_delete_blocked;
DROP TRIGGER IF EXISTS trg_saved_ideas_legacy_user_update_blocked;
DROP TRIGGER IF EXISTS trg_saved_ideas_legacy_user_insert_blocked;
DROP TRIGGER IF EXISTS trg_notes_content_idea_update_blocked;
DROP TRIGGER IF EXISTS trg_notes_content_idea_insert_blocked;
DROP TRIGGER IF EXISTS trg_notes_bound_content_idea_delete_blocked;
DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_quarantine_immutable;
DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_ingress_immutable_delete;
DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_ingress_immutable_update;
DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_ingress_scope_insert;
DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_quarantine_immutable;
DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_ingress_immutable_delete;
DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_ingress_immutable_update;
DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_ingress_scope_insert;
DROP INDEX IF EXISTS idx_content_legacy_idea_note_quarantine_owner;
DROP TABLE IF EXISTS content_legacy_idea_note_quarantine;
DROP INDEX IF EXISTS idx_content_legacy_idea_note_ingress_source;
DROP TABLE IF EXISTS content_legacy_idea_note_ingress_bindings;
DROP VIEW IF EXISTS content_legacy_saved_idea_source_state;
DROP INDEX IF EXISTS idx_content_legacy_saved_idea_quarantine_scope;
DROP TABLE IF EXISTS content_legacy_saved_idea_quarantine;
DROP INDEX IF EXISTS idx_content_legacy_saved_idea_ingress_source;
DROP TABLE IF EXISTS content_legacy_saved_idea_ingress_bindings;
