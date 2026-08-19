-- QA3 P2-11: the deferred-pack retry exclusion must select on the actual
-- product, not on notification_type alone — a legacy points ONE_TIME_CHARGE
-- must never be parked behind the pack kill switch. Additive: existing rows
-- backfill NULL and are treated as unknown (not excluded).
ALTER TABLE apple_notification_inbox ADD COLUMN product_id TEXT;
