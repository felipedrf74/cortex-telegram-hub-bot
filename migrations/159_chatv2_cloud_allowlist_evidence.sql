CREATE TABLE IF NOT EXISTS chat_v2_cloud_allowlist_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_source TEXT NOT NULL DEFAULT 'runtime_route' CHECK (evidence_source IN ('runtime_route', 'local_sandbox_seed')),
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  sample_hmac TEXT NOT NULL,
  sample_identifier_kind TEXT NOT NULL CHECK (sample_identifier_kind = 'hmac'),
  sent_to_cloud INTEGER NOT NULL CHECK (sent_to_cloud IN (0, 1)),
  raw_private_field_count INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL CHECK (denied IN (0, 1)),
  denial_reason TEXT,
  denial_reason_observable INTEGER NOT NULL CHECK (denial_reason_observable IN (0, 1)),
  hmac_entity_id_count INTEGER NOT NULL DEFAULT 0,
  non_hmac_entity_id_count INTEGER NOT NULL DEFAULT 0,
  hmac_evidence_fingerprint_count INTEGER NOT NULL DEFAULT 0,
  non_hmac_evidence_fingerprint_count INTEGER NOT NULL DEFAULT 0,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_cloud_allowlist_evidence_scope
  ON chat_v2_cloud_allowlist_evidence (tenant_id, user_id, evidence_source, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_v2_cloud_allowlist_evidence_request
  ON chat_v2_cloud_allowlist_evidence (request_id);
