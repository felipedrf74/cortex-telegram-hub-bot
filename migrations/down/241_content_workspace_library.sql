-- Migration 241 is intentionally forward-only.
--
-- Once used, content_tags and content_item_tags contain user-authored library
-- organization. Dropping them would silently destroy that organization while
-- leaving the canonical items intact, which is not a truthful rollback.
--
-- Fail before mutating any data or schema. Roll back the application route via
-- compatibility controls and use a separately reviewed forward migration for
-- any schema replacement.

SELECT rollback_blocked
  FROM content_workspace_241_forward_only_rollback_is_not_supported;
