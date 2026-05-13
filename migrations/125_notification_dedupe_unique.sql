-- Enforce notification dedupe keys at the database layer.
--
-- Keep the newest non-expired row for each unresolved dedupe key before
-- creating partial unique indexes. Expired rows are historical and may retain
-- duplicate keys.

DELETE FROM notification_intents
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, tenant_id, source_skill, dedupe_key
        ORDER BY COALESCE(created_at, '') DESC, rowid DESC
      ) AS duplicate_rank
    FROM notification_intents
    WHERE dedupe_key IS NOT NULL
      AND status != 'expired'
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_intents_dedupe_unique
  ON notification_intents(user_id, tenant_id, source_skill, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status != 'expired';

DELETE FROM notification_center_items
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, tenant_id, source_skill, dedupe_key
        ORDER BY COALESCE(created_at, '') DESC, rowid DESC
      ) AS duplicate_rank
    FROM notification_center_items
    WHERE dedupe_key IS NOT NULL
      AND status != 'expired'
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_center_items_dedupe_unique
  ON notification_center_items(user_id, tenant_id, source_skill, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status != 'expired';
