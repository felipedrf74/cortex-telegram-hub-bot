CREATE TABLE IF NOT EXISTS chat_v2_completion_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('shadow', 'answer_canary')),
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  message_hmac TEXT NOT NULL,
  message_identifier_kind TEXT NOT NULL CHECK (message_identifier_kind = 'hmac'),
  locale TEXT NOT NULL,
  candidate_capabilities_json TEXT NOT NULL,
  final_capability_id TEXT,
  schema_valid_after_repair INTEGER NOT NULL CHECK (schema_valid_after_repair IN (0, 1)),
  candidate_evidence_hash TEXT NOT NULL,
  route_owner TEXT NOT NULL,
  route_method TEXT,
  response_contract_valid INTEGER NOT NULL CHECK (response_contract_valid IN (0, 1)),
  answer_accepted INTEGER CHECK (answer_accepted IN (0, 1)),
  unsupported_claim_caught INTEGER CHECK (unsupported_claim_caught IN (0, 1)),
  first_progress_ms INTEGER,
  leaked_raw_private_field INTEGER NOT NULL DEFAULT 0 CHECK (leaked_raw_private_field IN (0, 1)),
  composition_mode TEXT,
  raw_field_audit_count INTEGER NOT NULL DEFAULT 0,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_completion_evidence_scope
  ON chat_v2_completion_evidence (tenant_id, user_id, evidence_kind, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_v2_completion_evidence_request
  ON chat_v2_completion_evidence (request_id, evidence_kind);
