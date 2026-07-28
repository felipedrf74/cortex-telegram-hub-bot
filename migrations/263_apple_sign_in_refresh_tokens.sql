-- 263: Persist the Sign in with Apple refresh token so account deletion can
-- call POST https://appleid.apple.com/auth/revoke before the local erase.
--
-- App Store Review Guideline 5.1.1(v) requires an app that offers Sign in with
-- Apple to revoke the user's Apple token when the account is deleted. Revoking
-- needs a refresh token, which only exists if the authorization code returned
-- at sign-in is exchanged at Apple's token endpoint. This table is where the
-- resulting refresh token lands.
--
-- The refresh token is encrypted at rest with the same per-user AES-256-GCM
-- scheme used for user_oauth_tokens (see src/services/oauth-store.ts) because
-- the SQLite file ships inside the weekly backup tarball. Only the ciphertext
-- and non-secret metadata are stored — never the authorization code, the
-- identity token, or the access token.
--
-- user_id is present so the account-deletion cascade in
-- src/services/user-data-export.ts discovers and erases this table
-- automatically instead of depending on a hand-maintained list.

CREATE TABLE IF NOT EXISTS apple_sign_in_refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  apple_user_id TEXT NOT NULL,
  -- The OAuth client_id the code was exchanged with: the native App ID for
  -- /auth/register/apple, an Apple Services ID for the browser flow. Revoke
  -- MUST reuse the same client_id, so it is stored per row.
  client_id TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_apple_sign_in_refresh_tokens_apple_user
  ON apple_sign_in_refresh_tokens(apple_user_id);
