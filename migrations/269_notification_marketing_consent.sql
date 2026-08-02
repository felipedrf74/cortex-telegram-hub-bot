-- Notification marketing consent (migration 269).
-- Separate consent for promotional notifications.
--
-- App Store guideline 4.5.4 requires push to be optional AND requires a
-- separate opt-in for marketing. Lifecycle/retention notifications — activation
-- nudges, "resume onboarding", win-back — are promotional. Putting them behind
-- the same `push_enabled` toggle as a schedule conflict means a user who wants
-- to be told about a double-booking has implicitly consented to re-engagement
-- marketing, which is exactly what the guideline forbids.
--
-- Default OFF. Operational notifications are unaffected: a promotional intent
-- that lacks consent still creates its Notification Center item, it simply
-- never interrupts.
--
-- The column is added now, before any lifecycle producer exists, so the gate is
-- in place first and a promotional push cannot ship behind operational consent
-- by omission.

ALTER TABLE notification_profiles ADD COLUMN marketing_push_enabled INTEGER NOT NULL DEFAULT 0;

-- Marks an intent as promotional. Set explicitly by the producer; the delivery
-- ladder refuses to push it unless marketing consent is on.
ALTER TABLE notification_intents ADD COLUMN promotional INTEGER NOT NULL DEFAULT 0;
