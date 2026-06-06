CREATE TABLE IF NOT EXISTS chat_v2_write_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_source TEXT NOT NULL DEFAULT 'runtime_route' CHECK (evidence_source IN ('runtime_route', 'local_sandbox_seed')),
  phase TEXT NOT NULL CHECK (phase IN ('write_preview', 'confirmed_writes')),
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  sample_hmac TEXT NOT NULL,
  sample_identifier_kind TEXT NOT NULL CHECK (sample_identifier_kind = 'hmac'),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('A', 'B', 'C')),
  preview_valid INTEGER NOT NULL CHECK (preview_valid IN (0, 1)),
  diff_required INTEGER NOT NULL CHECK (diff_required IN (0, 1)),
  visible_diff_present INTEGER NOT NULL CHECK (visible_diff_present IN (0, 1)),
  executed INTEGER NOT NULL CHECK (executed IN (0, 1)),
  validated_before_execution INTEGER NOT NULL CHECK (validated_before_execution IN (0, 1)),
  success_claimed INTEGER NOT NULL CHECK (success_claimed IN (0, 1)),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified', 'partial', 'failed', 'indeterminate', 'not_required')),
  escalated_per_policy INTEGER NOT NULL CHECK (escalated_per_policy IN (0, 1)),
  idempotency_passed INTEGER NOT NULL CHECK (idempotency_passed IN (0, 1)),
  retry_cancel_passed INTEGER NOT NULL CHECK (retry_cancel_passed IN (0, 1)),
  raw_field_audit_count INTEGER NOT NULL DEFAULT 0,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_write_evidence_scope
  ON chat_v2_write_evidence (tenant_id, user_id, phase, evidence_source, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_v2_write_evidence_request
  ON chat_v2_write_evidence (request_id, phase);
