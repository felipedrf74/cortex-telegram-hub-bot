-- Add provider column to api_usage for multi-provider cost tracking
-- Existing rows default to 'anthropic' (pre-migration baseline)
ALTER TABLE api_usage ADD COLUMN provider TEXT DEFAULT 'anthropic';
CREATE INDEX IF NOT EXISTS idx_api_usage_provider ON api_usage(provider);
