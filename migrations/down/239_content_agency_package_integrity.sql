-- Migration 239 is intentionally FORWARD-ONLY.
--
-- Removing the hash column requires a reviewed SQLite table rebuild from a
-- verified backup. Dropping the uniqueness invariant alone would reopen the
-- package-substitution and duplicate-handoff risks this migration closes.
-- Fail before mutating schema or data; recovery must use a reviewed forward
-- migration and compatibility rollout.

SELECT content_agency_package_integrity_239_is_forward_only__cannot_reverse_added_column();
