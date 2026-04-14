-- Rebalance stored daily AI quota fields to match the current plan economics.
-- Runtime enforcement already resolves caps from subscription state, but the
-- users table should stay aligned for admin views, audits, and legacy readers.

UPDATE users
SET daily_cost_limit_usd = 0
WHERE tier = 'free';

UPDATE users
SET daily_cost_limit_usd = 0.2
WHERE tier = 'pro';

UPDATE users
SET daily_cost_limit_usd = 0.6
WHERE tier = 'max';

UPDATE users
SET daily_cost_limit_usd = 0
WHERE tier = 'owner';
