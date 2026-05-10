-- Phase P0 tenant+safety: support bounded api_cache expiry sweeps.
CREATE INDEX IF NOT EXISTS idx_api_cache_expires_key
  ON api_cache(expires_at, cache_key);

