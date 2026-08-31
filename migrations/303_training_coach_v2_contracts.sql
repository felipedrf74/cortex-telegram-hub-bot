-- 303: Coach V2 public-contract, travel lifecycle, and health authority.
--
-- Additive and dormant until the corresponding routes are called. Coach V2
-- proposals never mutate a plan; Decision Center is the only activation
-- authority and must CAS against expected_version under an adapt lock.

-- All changes in this migration are predecessor-compatible expand/backfill
-- operations so ordinary protected-main CD can roll the runtime back without
-- restoring an older database. Application validation owns cross-table scope;
-- new tables deliberately avoid foreign keys to predecessor-owned tables.
ALTER TABLE travel_windows ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE travel_windows ADD COLUMN updated_at TEXT;
ALTER TABLE travel_windows ADD COLUMN idempotency_key TEXT;
ALTER TABLE travel_windows ADD COLUMN request_hash TEXT;

CREATE TABLE IF NOT EXISTS travel_window_mutation_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  travel_window_id INTEGER,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'patch', 'delete')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, idempotency_key)
);

ALTER TABLE fitness_training_plans
  ADD COLUMN coach_plan_policy_version INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS training_coach_v2_reflow_previews (
  preview_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  plan_id INTEGER NOT NULL,
  week_id INTEGER NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, preview_id)
);

CREATE INDEX IF NOT EXISTS idx_training_coach_v2_reflow_previews_scope_expiry
  ON training_coach_v2_reflow_previews(tenant_id, user_id, expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS training_coach_v2_proposals (
  proposal_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  kind TEXT NOT NULL CHECK (kind IN ('week_reflow', 'coach_policy')),
  plan_id INTEGER NOT NULL,
  week_id INTEGER,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  client_request_hash TEXT NOT NULL CHECK (length(client_request_hash) = 64),
  idempotency_key TEXT NOT NULL,
  preview_id TEXT,
  proposed_revision_id TEXT,
  decision_id TEXT,
  activation_result_json TEXT CHECK (
    activation_result_json IS NULL OR json_valid(activation_result_json)
  ),
  state TEXT NOT NULL DEFAULT 'proposal_created' CHECK (state IN (
    'proposal_created', 'approved', 'activated', 'rejected', 'expired',
    'superseded', 'activation_failed'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (tenant_id, user_id, idempotency_key),
  UNIQUE (tenant_id, user_id, proposal_id),
  UNIQUE (tenant_id, user_id, decision_id),
  UNIQUE (tenant_id, user_id, preview_id)
);

CREATE INDEX IF NOT EXISTS idx_training_coach_v2_proposals_scope_state
  ON training_coach_v2_proposals(tenant_id, user_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS health_data_consent_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  active_scopes_json TEXT NOT NULL CHECK (json_valid(active_scopes_json)),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  reason TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, revision),
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_health_data_consent_scope_latest
  ON health_data_consent_revisions(tenant_id, user_id, revision DESC);

ALTER TABLE athlete_health_signals ADD COLUMN expires_at TEXT;
ALTER TABLE athlete_health_signals ADD COLUMN idempotency_key TEXT;
ALTER TABLE athlete_health_signals ADD COLUMN request_hash TEXT;

CREATE TABLE IF NOT EXISTS athlete_health_signal_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  correction_json TEXT NOT NULL CHECK (json_valid(correction_json)),
  effective_signal_json TEXT NOT NULL CHECK (json_valid(effective_signal_json)),
  safety_disposition_json TEXT NOT NULL CHECK (json_valid(safety_disposition_json)),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_health_signal_corrections_latest
  ON athlete_health_signal_corrections(tenant_id, user_id, signal_id, id DESC);

CREATE TABLE IF NOT EXISTS health_data_mutation_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  operation TEXT NOT NULL CHECK (operation IN ('create_intake', 'delete_one', 'delete_all')),
  signal_id INTEGER,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_health_data_mutation_receipts_scope
  ON health_data_mutation_receipts(tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS training_health_safety_state (
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('clear', 'review', 'pause_hard_training')),
  trigger_type TEXT,
  source_signal_id INTEGER,
  source_correction_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_health_signals_expiry
  ON athlete_health_signals(tenant_id, user_id, expires_at);
