-- Phase A webhook owner/encryption boundary.
--
-- This migration is deliberately additive and predecessor-compatible: it adds
-- only ordinary lookup indexes. Ownership validation and retry deduplication
-- are enforced by the new runtime inside BEGIN IMMEDIATE transactions. Do not
-- add triggers, unique indexes, or partial indexes here; an older binary used
-- as the Release A rollback target must remain able to write its legacy rows.

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_owner_provider_status_v2
  ON webhook_subscriptions(user_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_webhook_events_owner_subscription_idemp_lookup_v2
  ON webhook_events(user_id, provider, subscription_id, idempotency_key, status);
