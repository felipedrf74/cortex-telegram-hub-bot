-- Migration 122: tenant-aware learned pattern uniqueness
--
-- Migration 059 originally keyed learned patterns by (category, pattern_text, user_id).
-- That is not sufficient for future tenant boundaries where the same numeric user_id
-- can exist in more than one tenant. Scope uniqueness by effective tenant + owner.

DROP INDEX IF EXISTS idx_learned_patterns_unique;

-- Existing rows can collide once legacy user-scoped uniqueness is widened to
-- tenant + owner. Keep the strongest/latest row before creating the unique
-- index so replay/staging databases do not fail during migration.
DELETE FROM content_learned_patterns
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY
          COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
          COALESCE(owner_user_id, user_id, 0),
          category,
          pattern_text
        ORDER BY
          COALESCE(frequency, 0) DESC,
          COALESCE(last_seen_at, first_detected_at, '') DESC,
          COALESCE(first_detected_at, '') DESC,
          rowid DESC
      ) AS duplicate_rank
    FROM content_learned_patterns
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_patterns_tenant_owner_unique
  ON content_learned_patterns(
    COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
    COALESCE(owner_user_id, user_id, 0),
    category,
    pattern_text
  );
