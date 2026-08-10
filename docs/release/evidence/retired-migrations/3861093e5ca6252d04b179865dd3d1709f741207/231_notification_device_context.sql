-- Device-reported context on push tokens.
--
-- Two gaps this closes, both of which make existing behaviour wrong rather than
-- merely incomplete:
--
-- 1. TIMEZONE. `notification_profiles.timezone` is seeded once at row creation
--    and never updated; `users.timezone` has no write path at all. Every
--    lead-time producer (session reminders, commitment reminders, tax
--    deadlines) and every scheduled slot (morning brief, quiet hours) is
--    computed in that stale zone. A user who moves gets their 08:30 brief at
--    03:30 and quiet hours that end at 02:00.
--
--    Stored ADVISORY, not authoritative. Auto-shifting the profile would break
--    the user who commutes across a border twice a day, and would silently
--    move every scheduled notification without them asking. The drift is
--    surfaced so the client can offer the change in context.
--
-- 2. AUTHORIZATION TIER. The backend cannot currently tell "denied" from
--    "never asked" from "token expired" — the only proxy is whether any device
--    token exists. That makes every reachability number a guess, and it makes
--    provisional authorization unusable: under `.provisional` iOS delivers
--    quietly and IGNORES interruption-level, so a time-sensitive MFA push that
--    the server believes will ring simply does not.

ALTER TABLE notification_device_tokens ADD COLUMN device_timezone TEXT;
ALTER TABLE notification_device_tokens ADD COLUMN device_timezone_reported_at TEXT;

-- provisional | authorized | ephemeral | denied
-- Defaults to 'authorized' because every token that exists today was minted by
-- a full authorization request; only new registrations report otherwise.
ALTER TABLE notification_device_tokens ADD COLUMN authorization_tier TEXT NOT NULL DEFAULT 'authorized';

CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_scope_tier
  ON notification_device_tokens(user_id, tenant_id, authorization_tier, revoked_at);
