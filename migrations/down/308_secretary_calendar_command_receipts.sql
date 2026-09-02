-- Down 308: remove Secretary calendar command receipts and payloads.
DROP INDEX IF EXISTS idx_secretary_calendar_command_payload_scope;
DROP TABLE IF EXISTS secretary_calendar_command_payloads;
DROP INDEX IF EXISTS idx_secretary_calendar_command_expiry;
DROP INDEX IF EXISTS idx_secretary_calendar_command_agenda;
DROP INDEX IF EXISTS idx_secretary_calendar_command_instance;
DROP TABLE IF EXISTS secretary_calendar_command_receipts;
