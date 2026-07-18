-- A rollback must not erase live schedule evidence or strand Secretary/provider
-- work. Operators must first drive every binding through the canonical cleanup
-- flow and remove/migrate the terminal audit rows explicitly.
DROP TABLE IF EXISTS temp.content_schedule_rollback_guard;
CREATE TEMP TABLE content_schedule_rollback_guard (
  binding_count INTEGER NOT NULL CHECK (binding_count = 0),
  preview_count INTEGER NOT NULL CHECK (preview_count = 0)
);
INSERT INTO content_schedule_rollback_guard (binding_count, preview_count)
SELECT
  (SELECT COUNT(*) FROM content_schedule_bindings),
  (SELECT COUNT(*) FROM content_schedule_previews);
DROP TABLE content_schedule_rollback_guard;

DROP TRIGGER IF EXISTS trg_content_schedule_previews_confirmed_binding;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_legal_state;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_immutable_cancellation;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_immutable_input;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_preview_state;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_secretary_scope;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_current_pin;
DROP TRIGGER IF EXISTS trg_content_schedule_bindings_initial_state;
DROP INDEX IF EXISTS idx_content_schedule_bindings_item;
DROP INDEX IF EXISTS uniq_content_schedule_bindings_active_item;
DROP TABLE IF EXISTS content_schedule_bindings;
DROP TRIGGER IF EXISTS trg_content_schedule_previews_submit_identity;
DROP TRIGGER IF EXISTS trg_content_schedule_previews_legal_status;
DROP TRIGGER IF EXISTS trg_content_schedule_previews_immutable_confirmation;
DROP TRIGGER IF EXISTS trg_content_schedule_previews_immutable_input;
DROP TRIGGER IF EXISTS trg_content_schedule_previews_current_pin;
DROP TRIGGER IF EXISTS trg_content_schedule_previews_initial_status;
DROP INDEX IF EXISTS idx_content_schedule_previews_item;
DROP INDEX IF EXISTS idx_content_schedule_previews_binding_scope;
DROP TABLE IF EXISTS content_schedule_previews;
DROP INDEX IF EXISTS idx_content_revisions_schedule_scope;
DROP INDEX IF EXISTS idx_content_artifacts_schedule_scope;
