CREATE TABLE IF NOT EXISTS chat_v2_deterministic_read_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('deterministic_read', 'token_zero_surface')),
  evidence_source TEXT NOT NULL DEFAULT 'runtime_route' CHECK (evidence_source IN ('runtime_route', 'local_sandbox_seed')),
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  sample_hmac TEXT NOT NULL,
  sample_identifier_kind TEXT NOT NULL CHECK (sample_identifier_kind = 'hmac'),
  read_kind TEXT NOT NULL,
  token_zero_surface TEXT CHECK (token_zero_surface IN ('slash', 'button', 'api')),
  response_contract_valid INTEGER NOT NULL CHECK (response_contract_valid IN (0, 1)),
  tenant_user_isolation_passed INTEGER NOT NULL CHECK (tenant_user_isolation_passed IN (0, 1)),
  token_zero_preserved INTEGER CHECK (token_zero_preserved IN (0, 1)),
  raw_field_audit_count INTEGER NOT NULL DEFAULT 0,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_deterministic_read_evidence_scope
  ON chat_v2_deterministic_read_evidence (tenant_id, user_id, evidence_kind, evidence_source, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_v2_deterministic_read_evidence_request
  ON chat_v2_deterministic_read_evidence (request_id, evidence_kind);
