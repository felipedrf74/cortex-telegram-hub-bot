-- 296: Apple Foundation Models device-lane policy, admission, and evidence.
--
-- Addendum A keeps the server as the only routing authority. The device lane
-- is default OFF through APPLE_FOUNDATION_MODELS_ENABLED; this durable switch
-- is the independent operator stop. Admission rows bridge server-side credit
-- reservation to device execution without storing prompts or model output.

CREATE TABLE hybrid_device_runtime_control (
  control_key TEXT PRIMARY KEY CHECK (control_key = 'apple_foundation_models'),
  engaged INTEGER NOT NULL DEFAULT 0 CHECK (engaged IN (0, 1)),
  reason TEXT NOT NULL DEFAULT 'migration_default_disengaged',
  actor_user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO hybrid_device_runtime_control (control_key, engaged)
VALUES ('apple_foundation_models', 0);

-- Migration 289's event table has a four-key CHECK, so the additive controls
-- from 293 and 296 need an additive event table as well. Rebuilding the old
-- table would turn this expand-only release into a contract migration.
CREATE TABLE hybrid_runtime_control_events_ext (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  control_key TEXT NOT NULL CHECK (control_key IN (
    'subscription_checkout', 'storefront', 'apple_foundation_models'
  )),
  previous_engaged INTEGER NOT NULL CHECK (previous_engaged IN (0, 1)),
  engaged INTEGER NOT NULL CHECK (engaged IN (0, 1)),
  actor_user_id INTEGER NOT NULL CHECK (actor_user_id > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_hybrid_runtime_control_events_ext_key
  ON hybrid_runtime_control_events_ext(control_key, created_at DESC);

CREATE TABLE device_inference_admissions (
  id TEXT PRIMARY KEY,
  tenant_scope TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK (operation_key = 'standard_response'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  client_operation_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  reservation_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'completed', 'released', 'expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE UNIQUE INDEX idx_device_inference_admissions_replay
  ON device_inference_admissions (
    tenant_scope, user_id, device_id, operation_key, request_digest, client_operation_id
  );
CREATE INDEX idx_device_inference_admissions_open
  ON device_inference_admissions (state, expires_at);

CREATE TABLE device_inference_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id TEXT REFERENCES device_inference_admissions(id),
  tenant_scope TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK (operation_key IN (
    'standard_response', 'local_content_parse', 'local_content_summarize'
  )),
  policy_version TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'unavailable', 'fallback')),
  os_version TEXT NOT NULL,
  os_build TEXT NOT NULL,
  device_model TEXT NOT NULL,
  locale TEXT NOT NULL,
  framework_available INTEGER NOT NULL CHECK (framework_available IN (0, 1)),
  availability_reason TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_device_inference_evidence_admission
  ON device_inference_evidence (admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX idx_device_inference_evidence_policy
  ON device_inference_evidence (policy_version, operation_key, outcome, created_at);

CREATE TRIGGER device_inference_evidence_no_update
BEFORE UPDATE ON device_inference_evidence
BEGIN
  SELECT RAISE(ABORT, 'device_inference_evidence rows are append-only');
END;

-- Evidence is immutable during its bounded retention window, but deletion
-- remains available to the account-erasure and retention services. It is
-- content-free operational telemetry, not statutory billing evidence.
