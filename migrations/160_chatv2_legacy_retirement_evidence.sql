CREATE TABLE IF NOT EXISTS chat_v2_legacy_retirement_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_source TEXT NOT NULL DEFAULT 'runtime_route' CHECK (evidence_source IN ('runtime_route', 'local_sandbox_seed')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('route_exit', 'fallback_rate', 'verify_run')),
  tenant_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  sample_hmac TEXT NOT NULL,
  sample_identifier_kind TEXT NOT NULL CHECK (sample_identifier_kind = 'hmac'),
  route_id TEXT,
  replaced INTEGER CHECK (replaced IN (0, 1)),
  tested INTEGER CHECK (tested IN (0, 1)),
  shadow_parity_rate REAL,
  route_sample_count INTEGER,
  legacy_fallback_rate_24h REAL,
  full_verify_clean INTEGER CHECK (full_verify_clean IN (0, 1)),
  raw_field_audit_count INTEGER NOT NULL DEFAULT 0,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_retirement_evidence_scope
  ON chat_v2_legacy_retirement_evidence (evidence_kind, evidence_source, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_retirement_evidence_route
  ON chat_v2_legacy_retirement_evidence (route_id, evidence_source, created_at);
