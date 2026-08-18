-- Test/rehearsal inverse for migration 287.
-- Production rollback does not execute this contract operation: the column is
-- additive with a safe default, so restoring the predecessor image against
-- the additive schema is sufficient. This inverse exists for isolated
-- migration verification only.

ALTER TABLE content_script_jobs DROP COLUMN delivery_mode;
