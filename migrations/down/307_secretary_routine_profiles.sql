-- Down 307: remove Secretary routine profile storage.
DROP TABLE IF EXISTS secretary_routine_idempotency_receipts;
DROP TABLE IF EXISTS secretary_routine_profiles;
