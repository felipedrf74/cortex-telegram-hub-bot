-- Migration 205: Chat action entitlement catalog aliases
--
-- The chat planner authorizes typed action steps against canonical
-- skill_tiers rows. Keep legacy/chat-facing aliases and platform helper
-- skills explicit in the tier catalog so entitlement gates have concrete
-- rows to evaluate. Installed skill enable/disable state remains canonical:
-- chat-facing `training` maps to the existing `triathlon` installed skill.

INSERT OR IGNORE INTO skill_tiers (skill_id, required_tier, description) VALUES
  ('training',        'pro',  'Legacy chat action alias for triathlon training planner'),
  ('connections',     'free', 'Provider connection status and reconnect guidance'),
  ('notifications',   'free', 'Notification preferences and delivery status'),
  ('decision_center', 'free', 'Decision Center choices, snoozes, and follow-ups');
