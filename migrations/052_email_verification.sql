-- 052_email_verification.sql — Email verification codes
--
-- Stores 6-digit codes with 15-minute TTL for email verification.
-- One active code per user (UPSERT on user_id).

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_verification_user ON email_verification_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_code ON email_verification_codes(code, email);
