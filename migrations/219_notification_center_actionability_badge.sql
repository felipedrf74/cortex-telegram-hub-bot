-- Materialize notification actionability on center rows for badge reads.
--
-- The authoritative intent still owns requires_user_action, but badge/count
-- paths read notification_center_items directly. The migration runner skips
-- duplicate ADD COLUMN statements, so this is safe when runtime self-heal has
-- already added the column.

ALTER TABLE notification_center_items ADD COLUMN requires_user_action INTEGER NOT NULL DEFAULT 0;

UPDATE notification_center_items
   SET requires_user_action = COALESCE((
     SELECT intents.requires_user_action
       FROM notification_intents intents
      WHERE intents.intent_id = notification_center_items.intent_id
        AND intents.user_id = notification_center_items.user_id
        AND intents.tenant_id = notification_center_items.tenant_id
      LIMIT 1
   ), 0)
 WHERE EXISTS (
   SELECT 1
     FROM notification_intents intents
    WHERE intents.intent_id = notification_center_items.intent_id
      AND intents.user_id = notification_center_items.user_id
      AND intents.tenant_id = notification_center_items.tenant_id
      AND intents.requires_user_action != notification_center_items.requires_user_action
 );

CREATE INDEX IF NOT EXISTS idx_notification_center_badge_actionable
  ON notification_center_items(user_id, tenant_id, status, requires_user_action, expires_at);
