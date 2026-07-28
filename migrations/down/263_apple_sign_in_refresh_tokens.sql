-- Roll back only the Sign in with Apple refresh-token store introduced by
-- migration 263. Dropping it disables remote Apple token revocation on account
-- deletion; deletion itself still completes and records a local_only outcome.

DROP INDEX IF EXISTS idx_apple_sign_in_refresh_tokens_apple_user;
DROP TABLE IF EXISTS apple_sign_in_refresh_tokens;
