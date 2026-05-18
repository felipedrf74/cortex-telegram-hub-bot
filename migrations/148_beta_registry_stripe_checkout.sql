-- 148_beta_registry_stripe_checkout.sql
-- Public beta double opt-in, expiring invite delivery, website Stripe checkout,
-- and Stripe webhook idempotency.

ALTER TABLE waitlist ADD COLUMN email_hash TEXT;
ALTER TABLE waitlist ADD COLUMN email_confirmed_at TEXT;
ALTER TABLE waitlist ADD COLUMN confirmation_token_hash TEXT;
ALTER TABLE waitlist ADD COLUMN confirmation_expires_at TEXT;
ALTER TABLE waitlist ADD COLUMN invite_expires_at TEXT;
ALTER TABLE waitlist ADD COLUMN invite_email_sent_at TEXT;
ALTER TABLE waitlist ADD COLUMN email_delivery_status TEXT;
ALTER TABLE waitlist ADD COLUMN last_email_error TEXT;

CREATE INDEX IF NOT EXISTS idx_waitlist_email_hash
  ON waitlist(email_hash);

CREATE INDEX IF NOT EXISTS idx_waitlist_confirmation_token
  ON waitlist(confirmation_token_hash)
  WHERE confirmation_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_web_checkouts (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  email                      TEXT NOT NULL,
  email_hash                 TEXT NOT NULL,
  plan                       TEXT NOT NULL,
  currency                   TEXT NOT NULL,
  price_id                   TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'created',
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_customer_id         TEXT,
  stripe_subscription_id     TEXT,
  user_id                    INTEGER,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_web_checkouts_email_hash
  ON stripe_web_checkouts(email_hash);

CREATE INDEX IF NOT EXISTS idx_stripe_web_checkouts_subscription
  ON stripe_web_checkouts(stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_stripe_web_checkouts_user
  ON stripe_web_checkouts(user_id);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
