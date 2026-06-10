-- Keep terminal Notification Center rows as immutable history while freeing
-- their dedupe keys for future active replacements.

DROP INDEX IF EXISTS idx_notification_center_items_dedupe_unique;

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
      AND status NOT IN ('expired','actioned','dismissed','superseded')
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_center_items_dedupe_unique
  ON notification_center_items(user_id, tenant_id, source_skill, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('expired','actioned','dismissed','superseded');
