-- 050_subscriptions.sql — Subscription state for Stripe + Apple IAP
--
-- Single source of truth: both Stripe (web checkout) and Apple (StoreKit 2)
-- write to this table. The iOS app reads subscription status via
-- GET /api/v1/billing/status (token-zero, no AI pipeline).
--
-- One row per user (UNIQUE constraint). UPSERT on every webhook event.

CREATE TABLE IF NOT EXISTS subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  plan            TEXT    NOT NULL DEFAULT 'free',       -- 'free', 'pro', 'max'
  period          TEXT    NOT NULL DEFAULT 'monthly',    -- 'monthly', 'yearly'
  status          TEXT    NOT NULL DEFAULT 'inactive',   -- 'active', 'trialing', 'past_due', 'canceled', 'expired', 'inactive'
  provider        TEXT    NOT NULL DEFAULT 'none',       -- 'stripe', 'apple', 'none'

  -- Provider-specific IDs for lookup/reconciliation
  provider_subscription_id TEXT,   -- Stripe sub_xxx or Apple originalTransactionId
  provider_customer_id     TEXT,   -- Stripe cus_xxx or Apple appAccountToken

  -- Billing period (ISO 8601 UTC)
  current_period_start TEXT,
  current_period_end   TEXT,

  cancel_at_period_end INTEGER DEFAULT 0,  -- 1 = will cancel at period end

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub
  ON subscriptions(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions(user_id);
