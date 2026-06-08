-- Encrypt Apple Health payloads at rest while retaining a redacted legacy
-- data_json column for old rows and schema compatibility.
ALTER TABLE apple_health_data ADD COLUMN encrypted_data_json TEXT;
