-- Migration 044: audit_trail retention — trim decrypt rows + add index
--
-- Context: before April 2026, every getTokens() call in oauth-store.ts
-- wrote an audit_trail row with action='decrypt' and resource='oauth.*'.
-- Every Google/Outlook API call triggered a fresh decrypt because the
-- google-auth/microsoft-auth bridges call getTokens() on the hot path
-- without their own caching layer. Result: ~11,000 rows per day per
-- active user, with Outlook decrypts dominating (~10,670/day) because
-- the Microsoft Graph client's authProvider callback fires per-request.
--
-- Fix in code: src/services/oauth-store.ts now caches decrypted tokens
-- in an LRU with a 10-minute TTL, and only writes an audit row on the
-- actual decrypt (cache miss). Target: ~1 row per 10-minute window per
-- active provider ≈ 144 rows/day worst case.
--
-- Fix in data (this migration): drop old decrypt rows that accumulated
-- pre-fix. Keep the last 30 days for forensic continuity. Everything
-- else goes. This is safe because the audit_trail rows that carry
-- user-facing meaning (action != 'decrypt') are unaffected by this
-- retention rule — only the noisy machine-generated decrypt rows are
-- trimmed.
--
-- The user_id=0 rows referenced below are system rows (e.g. portal
-- admin actions) — those also don't need long retention for decrypt
-- actions but DO need it for other actions, hence the action-scoped
-- WHERE clause.

DELETE FROM audit_trail
WHERE action = 'decrypt'
  AND resource LIKE 'oauth.%'
  AND ts < datetime('now', '-30 days');

-- Partial index on decrypt rows for future retention sweeps. The full
-- index on (action, ts) would cover all actions but only decrypt is
-- hot enough to need its own index. Partial indexes in SQLite are
-- smaller and faster to maintain than full ones.
CREATE INDEX IF NOT EXISTS idx_audit_decrypt_ts
  ON audit_trail (ts)
  WHERE action = 'decrypt';

-- Rollback: DROP INDEX idx_audit_decrypt_ts;
-- (the DELETE is not reversible — data was already noise)
