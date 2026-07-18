-- Migration 240 is intentionally forward-only.
--
-- content_domain_objects is a shared canonical table. SQLite cannot remove
-- the additive workspace columns without rebuilding that table, which would
-- put legacy Content data and foreign-key references at risk. A partial down
-- migration would also make a later re-apply fail on duplicate columns.
--
-- Fail before mutating any data or schema. Rollback must use the application
-- compatibility flag/route exit and a separately reviewed forward migration.

SELECT rollback_blocked
  FROM content_workspace_240_forward_only_rollback_is_not_supported;
