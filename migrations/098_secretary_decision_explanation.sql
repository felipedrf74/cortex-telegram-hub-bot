-- Persist the human-readable Secretary decision explanation alongside
-- machine-readable reason codes for iOS/support read-back.

ALTER TABLE secretary_agenda_items ADD COLUMN decision_explanation TEXT;
