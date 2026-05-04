-- Apple Sign In nonce replay guard.
--
-- The client sends a raw nonce and Apple embeds SHA-256(rawNonce) in the
-- identity token. The backend records consumed nonce hashes so the same
-- identity token cannot be replayed inside Apple's token validity window.

CREATE TABLE IF NOT EXISTS apple_sign_in_nonces (
  nonce_hash TEXT PRIMARY KEY,
  apple_user_id TEXT NOT NULL,
  consumed_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apple_sign_in_nonces_consumed_at
  ON apple_sign_in_nonces(consumed_at_ms);
