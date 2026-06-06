ALTER TABLE chat_v2_completion_evidence ADD COLUMN evidence_source TEXT NOT NULL DEFAULT 'runtime_route' CHECK (evidence_source IN ('runtime_route', 'local_sandbox_seed'));

DROP INDEX IF EXISTS idx_chat_v2_completion_evidence_scope;

CREATE INDEX IF NOT EXISTS idx_chat_v2_completion_evidence_scope
  ON chat_v2_completion_evidence (tenant_id, user_id, evidence_kind, evidence_source, created_at);
