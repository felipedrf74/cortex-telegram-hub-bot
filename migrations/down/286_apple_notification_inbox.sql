-- Test/rehearsal inverse for migration 286.
-- Production rollback does not execute this contract operation: the inbox is
-- additive and default-inert, so restoring the predecessor image against the
-- additive schema is sufficient. This inverse exists for isolated migration
-- verification only.

DROP TABLE IF EXISTS apple_notification_inbox;
