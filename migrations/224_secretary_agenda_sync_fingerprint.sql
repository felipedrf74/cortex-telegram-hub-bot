-- 224: Provider-sync short-circuit fingerprint for secretary agenda items.
-- Before this, every non-terminal item — including long-'synced', unchanged
-- ones — cost THREE provider round-trips per 5-minute tick (duplicate-window
-- readback, direct readback, unconditional update PATCH), totalling ~59
-- hours/month of sync runtime in production (2026-07-03 audit). The sync now
-- records what it last pushed (source|shape-hash|slot|version) plus when it
-- last verified the provider event, and skips provider calls for unchanged
-- items until the re-verification window (default 6h) elapses so external
-- calendar drift still heals.
ALTER TABLE secretary_agenda_items ADD COLUMN last_synced_fingerprint TEXT;
ALTER TABLE secretary_agenda_items ADD COLUMN last_synced_verified_at TEXT;
