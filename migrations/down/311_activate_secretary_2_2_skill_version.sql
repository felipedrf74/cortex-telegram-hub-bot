-- Test/rehearsal inverse for migration 311.
-- Retain version history while restoring the exact predecessor global state.

UPDATE skill_version_rollouts
SET status = 'rolled_back',
    deprecated_at = COALESCE(deprecated_at, datetime('now'))
WHERE scope_type = 'global'
  AND created_by = 'migration_311'
  AND id NOT IN (
    SELECT entity_id
    FROM secretary_skill_version_release_journal
    WHERE release_version = '2.2.0'
      AND entity_kind = 'global_rollout'
  )
  AND skill_version_id IN (
    SELECT id
    FROM skill_versions
    WHERE skill_id = 'secretary'
      AND version = '2.2.0'
  );

UPDATE skill_versions
SET status = 'rolled_back',
    deprecated_at = COALESCE(deprecated_at, datetime('now'))
WHERE skill_id = 'secretary'
  AND version = '2.2.0'
  AND created_by = 'migration_311'
  AND id NOT IN (
    SELECT entity_id
    FROM secretary_skill_version_release_journal
    WHERE release_version = '2.2.0'
      AND entity_kind = 'version'
  );

UPDATE skill_versions
SET status = (
      SELECT prior_status
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'version'
        AND journal.entity_id = skill_versions.id
    ),
    rollout_scope = (
      SELECT prior_rollout_scope
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'version'
        AND journal.entity_id = skill_versions.id
    ),
    activated_at = (
      SELECT prior_activated_at
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'version'
        AND journal.entity_id = skill_versions.id
    ),
    deprecated_at = (
      SELECT prior_deprecated_at
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'version'
        AND journal.entity_id = skill_versions.id
    )
WHERE id IN (
  SELECT entity_id
  FROM secretary_skill_version_release_journal
  WHERE release_version = '2.2.0'
    AND entity_kind = 'version'
);

UPDATE skill_version_rollouts
SET status = (
      SELECT prior_status
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'global_rollout'
        AND journal.entity_id = skill_version_rollouts.id
    ),
    activated_at = (
      SELECT prior_activated_at
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'global_rollout'
        AND journal.entity_id = skill_version_rollouts.id
    ),
    deprecated_at = (
      SELECT prior_deprecated_at
      FROM secretary_skill_version_release_journal journal
      WHERE journal.release_version = '2.2.0'
        AND journal.entity_kind = 'global_rollout'
        AND journal.entity_id = skill_version_rollouts.id
    )
WHERE id IN (
  SELECT entity_id
  FROM secretary_skill_version_release_journal
  WHERE release_version = '2.2.0'
    AND entity_kind = 'global_rollout'
);

DROP TABLE secretary_skill_version_release_journal;
