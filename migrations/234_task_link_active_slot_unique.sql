-- 234: enforce one ACTIVE provider link per (tenant, user, task, provider,
-- account) slot. provider_task_id is NULLable and SQLite treats NULLs as
-- distinct under the existing UNIQUE, so a task could hold both a
-- pending-create link (NULL provider id) and an imported link for the same
-- provider — the push worker ranks pending_create first and would re-create
-- the task at the provider (duplicate class R1-b).
--
-- Cleanup first: orphan the worse duplicate in each slot, preferring to keep
-- links that know their provider_task_id, then the most recently updated,
-- then the highest id (deterministic tie-break).

UPDATE task_provider_links SET
  link_state = 'orphaned',
  updated_at = datetime('now')
WHERE link_state NOT IN ('orphaned')
  AND EXISTS (
    SELECT 1 FROM task_provider_links b
    WHERE b.link_state NOT IN ('orphaned')
      AND b.tenant_id = task_provider_links.tenant_id
      AND b.user_id = task_provider_links.user_id
      AND b.task_id = task_provider_links.task_id
      AND b.provider = task_provider_links.provider
      AND b.provider_account_id = task_provider_links.provider_account_id
      AND b.id != task_provider_links.id
      AND (
        (b.provider_task_id IS NOT NULL AND task_provider_links.provider_task_id IS NULL)
        OR (
          (b.provider_task_id IS NULL) = (task_provider_links.provider_task_id IS NULL)
          AND (
            b.updated_at > task_provider_links.updated_at
            OR (b.updated_at = task_provider_links.updated_at AND b.id > task_provider_links.id)
          )
        )
      )
  );

-- Orphaned links are terminal history and must not keep occupying the legacy
-- UNIQUE(tenant, user, provider, account, provider_task_id) slot — a retained
-- provider id on an orphan blocks re-linking that provider task to its live
-- canonical row (link revival and marker adoption would both throw). No code
-- path reads an orphaned link's provider_task_id.
UPDATE task_provider_links SET
  provider_task_id = NULL,
  updated_at = datetime('now')
WHERE link_state = 'orphaned' AND provider_task_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_provider_links_active_slot
  ON task_provider_links(tenant_id, user_id, task_id, provider, provider_account_id)
  WHERE link_state NOT IN ('orphaned');
