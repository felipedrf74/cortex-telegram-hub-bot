-- Migration 242: canonical Content workspace agent jobs and proposals.
--
-- Jobs are scoped execution ledgers over an immutable Content Agency package
-- and one canonical artifact revision. Agent output remains a proposal until
-- the owner explicitly accepts it through the workspace revision CAS path.

-- Composite parent keys keep every relationship tenant-, owner-, and
-- artifact-scoped at the database boundary instead of relying on service
-- joins to detect a mismatched integer id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_artifacts_agent_job_scope
  ON content_artifacts(id, tenant_id, owner_user_id, item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_revisions_agent_job_scope
  ON content_revisions(id, tenant_id, owner_user_id, artifact_id);

CREATE TABLE IF NOT EXISTS content_agent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private'
    CHECK (visibility_scope = 'user_private'),
  scope_status TEXT NOT NULL DEFAULT 'active'
    CHECK (scope_status IN ('active', 'deleted')),
  item_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  source_package_id TEXT NOT NULL,
  source_package_hash TEXT NOT NULL CHECK (length(source_package_hash) = 64),
  base_revision_id INTEGER NOT NULL,
  base_revision_number INTEGER NOT NULL CHECK (base_revision_number >= 1),
  base_content_hash TEXT NOT NULL CHECK (length(base_content_hash) = 64),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  current_group INTEGER NOT NULL DEFAULT 0 CHECK (current_group BETWEEN 0 AND 4),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  engine_version TEXT NOT NULL DEFAULT 'content-agent-workflow-v1',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id, item_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id, item_id)
    ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, tenant_id, owner_user_id, artifact_id)
    REFERENCES content_revisions(id, tenant_id, owner_user_id, artifact_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_agent_jobs_scoped_identity
  ON content_agent_jobs(id, tenant_id, owner_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_agent_jobs_proposal_scope
  ON content_agent_jobs(id, tenant_id, owner_user_id, artifact_id, base_revision_id);

CREATE INDEX IF NOT EXISTS idx_content_agent_jobs_library
  ON content_agent_jobs(tenant_id, owner_user_id, scope_status, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_content_agent_jobs_artifact
  ON content_agent_jobs(tenant_id, owner_user_id, artifact_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_agent_jobs_active_input
  ON content_agent_jobs(
    tenant_id, owner_user_id, artifact_id, base_revision_id,
    source_package_id, source_package_hash
  )
  WHERE scope_status = 'active' AND status IN ('queued', 'running');

CREATE TRIGGER IF NOT EXISTS trg_content_agent_jobs_immutable_inputs
BEFORE UPDATE OF
  job_key, tenant_id, owner_user_id, visibility_scope, item_id, artifact_id,
  source_package_id, source_package_hash, base_revision_id,
  base_revision_number, base_content_hash, engine_version, created_by, created_at
ON content_agent_jobs
BEGIN
  SELECT RAISE(ABORT, 'content agent job inputs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_jobs_legal_status
BEFORE UPDATE OF status ON content_agent_jobs
WHEN OLD.status <> NEW.status
 AND NOT (
   (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
   OR (OLD.status = 'running' AND NEW.status IN ('queued', 'completed', 'failed', 'cancelled'))
   OR (OLD.status = 'failed' AND NEW.status = 'queued')
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid content agent job status transition');
END;

CREATE TABLE IF NOT EXISTS content_agent_job_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'strategy', 'research', 'writer', 'structural_editor',
    'factuality', 'platform_adapter', 'quality_reviewer'
  )),
  dependency_group INTEGER NOT NULL CHECK (dependency_group BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  output_summary_json TEXT NOT NULL DEFAULT '{}',
  proposal_count INTEGER NOT NULL DEFAULT 0 CHECK (proposal_count >= 0),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, role),
  FOREIGN KEY (job_id, tenant_id, owner_user_id)
    REFERENCES content_agent_jobs(id, tenant_id, owner_user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_agent_job_steps_job
  ON content_agent_job_steps(tenant_id, owner_user_id, job_id, dependency_group, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_agent_job_steps_scoped_identity
  ON content_agent_job_steps(id, tenant_id, owner_user_id, job_id);

CREATE TRIGGER IF NOT EXISTS trg_content_agent_job_steps_immutable_identity
BEFORE UPDATE OF tenant_id, owner_user_id, job_id, role, dependency_group
ON content_agent_job_steps
BEGIN
  SELECT RAISE(ABORT, 'content agent job step identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_job_steps_legal_status
BEFORE UPDATE OF status ON content_agent_job_steps
WHEN OLD.status <> NEW.status
 AND NOT (
   (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
   OR (OLD.status = 'running' AND NEW.status IN ('queued', 'completed', 'failed', 'cancelled'))
   OR (OLD.status = 'failed' AND NEW.status = 'queued')
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid content agent step status transition');
END;

CREATE TABLE IF NOT EXISTS content_agent_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_key TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private'
    CHECK (visibility_scope = 'user_private'),
  job_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL,
  proposal_role TEXT NOT NULL CHECK (proposal_role IN ('writer', 'editor', 'platform_adapter')),
  artifact_id INTEGER NOT NULL,
  base_revision_id INTEGER NOT NULL,
  base_revision_number INTEGER NOT NULL CHECK (base_revision_number >= 1),
  base_content_hash TEXT NOT NULL CHECK (length(base_content_hash) = 64),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'rejected', 'stale')),
  content_format TEXT NOT NULL CHECK (content_format IN ('plain_text', 'markdown', 'structured_json')),
  suggested_content_text TEXT,
  suggested_content_json TEXT,
  suggested_content_hash TEXT NOT NULL CHECK (length(suggested_content_hash) = 64),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  acceptance_kind TEXT CHECK (acceptance_kind IN ('source_revision', 'platform_variant')),
  accepted_artifact_id INTEGER,
  accepted_revision_id INTEGER,
  decided_by INTEGER,
  decided_at TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (content_format IN ('plain_text', 'markdown') AND suggested_content_text IS NOT NULL AND suggested_content_json IS NULL)
    OR
    (content_format = 'structured_json' AND suggested_content_text IS NULL AND suggested_content_json IS NOT NULL)
  ),
  FOREIGN KEY (job_id, tenant_id, owner_user_id, artifact_id, base_revision_id)
    REFERENCES content_agent_jobs(id, tenant_id, owner_user_id, artifact_id, base_revision_id)
    ON DELETE CASCADE,
  FOREIGN KEY (step_id, tenant_id, owner_user_id, job_id)
    REFERENCES content_agent_job_steps(id, tenant_id, owner_user_id, job_id)
    ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, tenant_id, owner_user_id, artifact_id)
    REFERENCES content_revisions(id, tenant_id, owner_user_id, artifact_id)
    ON DELETE CASCADE,
  -- Kept single-column so account erasure can SET NULL only the optional
  -- result pointers. Triggers below enforce tenant/owner/item scope.
  FOREIGN KEY (accepted_artifact_id) REFERENCES content_artifacts(id) ON DELETE SET NULL,
  FOREIGN KEY (accepted_revision_id) REFERENCES content_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_agent_proposals_job
  ON content_agent_proposals(tenant_id, owner_user_id, job_id, status, id);

CREATE INDEX IF NOT EXISTS idx_content_agent_proposals_artifact
  ON content_agent_proposals(tenant_id, owner_user_id, artifact_id, status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_accepted_revision_scope_insert
BEFORE INSERT ON content_agent_proposals
WHEN NEW.accepted_revision_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM content_revisions r
     JOIN content_artifacts accepted ON accepted.id = NEW.accepted_artifact_id
     JOIN content_artifacts source ON source.id = NEW.artifact_id
    WHERE r.id = NEW.accepted_revision_id
      AND r.tenant_id = NEW.tenant_id
      AND r.owner_user_id = NEW.owner_user_id
      AND r.artifact_id = accepted.id
      AND accepted.tenant_id = NEW.tenant_id
      AND accepted.owner_user_id = NEW.owner_user_id
      AND source.tenant_id = NEW.tenant_id
      AND source.owner_user_id = NEW.owner_user_id
      AND accepted.item_id = source.item_id
 )
BEGIN
  SELECT RAISE(ABORT, 'content agent accepted revision scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_accepted_revision_scope_update
BEFORE UPDATE OF accepted_revision_id ON content_agent_proposals
WHEN NEW.accepted_revision_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM content_revisions r
     JOIN content_artifacts accepted ON accepted.id = NEW.accepted_artifact_id
     JOIN content_artifacts source ON source.id = NEW.artifact_id
    WHERE r.id = NEW.accepted_revision_id
      AND r.tenant_id = NEW.tenant_id
      AND r.owner_user_id = NEW.owner_user_id
      AND r.artifact_id = accepted.id
      AND accepted.tenant_id = NEW.tenant_id
      AND accepted.owner_user_id = NEW.owner_user_id
      AND source.tenant_id = NEW.tenant_id
      AND source.owner_user_id = NEW.owner_user_id
      AND accepted.item_id = source.item_id
 )
BEGIN
  SELECT RAISE(ABORT, 'content agent accepted revision scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_insert_state
BEFORE INSERT ON content_agent_proposals
WHEN NEW.status <> 'proposed'
  OR NEW.acceptance_kind IS NOT NULL
  OR NEW.accepted_artifact_id IS NOT NULL
  OR NEW.accepted_revision_id IS NOT NULL
  OR NEW.decided_by IS NOT NULL
  OR NEW.decided_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'content agent proposals must begin undecided');
END;

-- Suggested bytes and their base are immutable. Decision fields remain the
-- only normal update surface; FK erasure can still delete the whole graph.
CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_immutable_payload
BEFORE UPDATE OF
  proposal_key, tenant_id, owner_user_id, visibility_scope, job_id, step_id,
  proposal_role, artifact_id, base_revision_id, base_revision_number,
  base_content_hash, content_format, suggested_content_text,
  suggested_content_json, suggested_content_hash, title, summary, reason,
  created_by, created_at
ON content_agent_proposals
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal payload is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_terminal_decision
BEFORE UPDATE OF status ON content_agent_proposals
WHEN OLD.status <> NEW.status
 AND NOT (
   OLD.status = 'proposed'
   AND (
     (NEW.status = 'accepted' AND NEW.acceptance_kind IS NOT NULL
       AND NEW.accepted_artifact_id IS NOT NULL AND NEW.accepted_revision_id IS NOT NULL
       AND NEW.decided_by IS NOT NULL AND NEW.decided_at IS NOT NULL)
     OR (NEW.status = 'rejected' AND NEW.acceptance_kind IS NULL
       AND NEW.accepted_artifact_id IS NULL AND NEW.accepted_revision_id IS NULL
       AND NEW.decided_by IS NOT NULL AND NEW.decided_at IS NOT NULL)
     OR (NEW.status = 'stale' AND NEW.acceptance_kind IS NULL
       AND NEW.accepted_artifact_id IS NULL AND NEW.accepted_revision_id IS NULL
       AND NEW.decided_at IS NOT NULL)
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal decision is terminal');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_terminal_metadata
BEFORE UPDATE OF decided_by, decided_at ON content_agent_proposals
WHEN OLD.status <> 'proposed'
 AND (NEW.decided_by IS NOT OLD.decided_by OR NEW.decided_at IS NOT OLD.decided_at)
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal decision metadata is immutable');
END;

-- A proposal may acquire one accepted revision pointer exactly once. SQLite
-- may later clear it through ON DELETE SET NULL during account erasure.
CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_revision_pointer
BEFORE UPDATE OF accepted_revision_id ON content_agent_proposals
WHEN NOT (
  (OLD.accepted_revision_id IS NULL AND NEW.accepted_revision_id IS NOT NULL AND NEW.status = 'accepted')
  OR
  (OLD.accepted_revision_id IS NOT NULL AND NEW.accepted_revision_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal revision pointer is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_artifact_pointer
BEFORE UPDATE OF accepted_artifact_id ON content_agent_proposals
WHEN NOT (
  (OLD.accepted_artifact_id IS NULL AND NEW.accepted_artifact_id IS NOT NULL AND NEW.status = 'accepted')
  OR
  (OLD.accepted_artifact_id IS NOT NULL AND NEW.accepted_artifact_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal artifact pointer is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_agent_proposals_acceptance_kind
BEFORE UPDATE OF acceptance_kind ON content_agent_proposals
WHEN NOT (OLD.acceptance_kind IS NULL AND NEW.acceptance_kind IS NOT NULL AND NEW.status = 'accepted')
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal acceptance kind is immutable');
END;
