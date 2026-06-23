-- Migration 216: Offline-first canonical task identity and mutation ledger.
--
-- Nexus task identity is app-canonical. Provider task ids are links, not the
-- primary app identity, so local reads and local mutations can remain durable
-- while external providers are disconnected, stale, or retrying.

ALTER TABLE unified_tasks
  ADD COLUMN tenant_id INTEGER;

ALTER TABLE unified_tasks
  ADD COLUMN nexus_task_id TEXT;

ALTER TABLE unified_tasks
  ADD COLUMN local_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE unified_tasks
  ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced';

ALTER TABLE unified_tasks
  ADD COLUMN source_of_truth TEXT NOT NULL DEFAULT 'nexus';

ALTER TABLE unified_tasks
  ADD COLUMN deleted_at TEXT;

ALTER TABLE unified_projects
  ADD COLUMN tenant_id INTEGER;

UPDATE unified_tasks
SET
  tenant_id = COALESCE(tenant_id, user_id),
  nexus_task_id = COALESCE(nexus_task_id, 'task_legacy_' || id);

UPDATE unified_projects
SET tenant_id = COALESCE(tenant_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unified_tasks_nexus_identity
  ON unified_tasks(tenant_id, user_id, nexus_task_id)
  WHERE nexus_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_nexus_sync
  ON unified_tasks(tenant_id, user_id, sync_state, is_deleted);

CREATE INDEX IF NOT EXISTS idx_unified_projects_tenant_user
  ON unified_projects(tenant_id, user_id, provider, name);

CREATE TABLE IF NOT EXISTS task_provider_links (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL,
  tenant_id           INTEGER NOT NULL,
  user_id             INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_task_id    TEXT,
  provider_list_id    TEXT,
  provider_project_id TEXT,
  provider_version    TEXT,
  provider_updated_at TEXT,
  last_synced_at      TEXT,
  last_verified_at    TEXT,
  ownership           TEXT NOT NULL,
  link_state          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, provider, provider_account_id, provider_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_provider_links_task
  ON task_provider_links(tenant_id, user_id, task_id);

CREATE INDEX IF NOT EXISTS idx_task_provider_links_state
  ON task_provider_links(tenant_id, user_id, provider, link_state);

CREATE TABLE IF NOT EXISTS task_mutations (
  mutation_id        TEXT PRIMARY KEY,
  client_mutation_id TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  tenant_id          INTEGER NOT NULL,
  user_id            INTEGER NOT NULL,
  task_id            TEXT,
  operation          TEXT NOT NULL,
  base_local_version INTEGER,
  patch_json         TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at       TEXT,
  completed_at       TEXT,
  status             TEXT NOT NULL,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  next_retry_at      TEXT,
  locked_at          TEXT,
  worker_id          TEXT,
  provider_idempotency_key TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  UNIQUE(tenant_id, user_id, client_mutation_id, operation),
  UNIQUE(tenant_id, user_id, idempotency_key, operation)
);

CREATE INDEX IF NOT EXISTS idx_task_mutations_queue
  ON task_mutations(status, tenant_id, user_id, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_task_mutations_task
  ON task_mutations(tenant_id, user_id, task_id, created_at);

CREATE TABLE IF NOT EXISTS task_container_mappings (
  id                      TEXT PRIMARY KEY,
  tenant_id               INTEGER NOT NULL,
  user_id                 INTEGER NOT NULL,
  nexus_list_id           TEXT NOT NULL,
  provider                TEXT NOT NULL,
  provider_container_type TEXT NOT NULL,
  provider_container_id   TEXT NOT NULL,
  sync_direction          TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, nexus_list_id, provider)
);

CREATE TABLE IF NOT EXISTS task_sync_issues (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  tenant_id       INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  provider        TEXT,
  code            TEXT NOT NULL,
  message         TEXT,
  details_json    TEXT NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_sync_issues_task
  ON task_sync_issues(tenant_id, user_id, task_id, state);

CREATE TABLE IF NOT EXISTS task_sync_observability_events (
  id           TEXT PRIMARY KEY,
  tenant_id    INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  task_id      TEXT,
  provider     TEXT,
  event_type   TEXT NOT NULL,
  operation    TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_sync_observability_events_scope
  ON task_sync_observability_events(tenant_id, user_id, event_type, created_at);
