-- 308: durable Secretary calendar command receipts and provider payloads.
--
-- One scoped row is both the idempotency receipt for REST/chat calendar
-- commands and the private payload companion for the canonical Secretary
-- agenda item. Provider effects remain owned by the existing agenda provider
-- sync state machine; this table never authorizes a direct provider write.

CREATE TABLE secretary_calendar_command_receipts (
  user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_instance_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  provider_source TEXT NOT NULL CHECK (provider_source IN ('google', 'outlook')),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  state TEXT NOT NULL CHECK (state IN (
    'prechecking',
    'conflict_unknown',
    'review_required',
    'sync_pending',
    'succeeded'
  )),
  agenda_item_id TEXT,
  decision_item_id TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  processing_lease_token TEXT,
  processing_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id, idempotency_key),
  CHECK (CAST(user_id AS TEXT) = tenant_id),
  CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  CHECK (length(trim(command_instance_id)) > 0),
  CHECK (processing_lease_token IS NULL OR length(trim(processing_lease_token)) > 0),
  CHECK ((processing_lease_token IS NULL) = (processing_lease_expires_at IS NULL)),
  CHECK (agenda_item_id IS NULL OR length(trim(agenda_item_id)) > 0),
  CHECK (decision_item_id IS NULL OR length(trim(decision_item_id)) > 0)
);

CREATE UNIQUE INDEX idx_secretary_calendar_command_instance
  ON secretary_calendar_command_receipts(command_instance_id);

CREATE UNIQUE INDEX idx_secretary_calendar_command_agenda
  ON secretary_calendar_command_receipts(agenda_item_id)
  WHERE agenda_item_id IS NOT NULL;

CREATE INDEX idx_secretary_calendar_command_expiry
  ON secretary_calendar_command_receipts(expires_at);

-- Idempotency receipts expire after 30 days, but an active/future agenda row
-- can require provider reconciliation after that window. Keep the private
-- provider payload independently for the lifetime of its canonical agenda
-- item so drift repair never truncates fields after receipt pruning.
CREATE TABLE secretary_calendar_command_payloads (
  agenda_item_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(agenda_item_id)) > 0),
  CHECK (CAST(user_id AS TEXT) = tenant_id)
);

CREATE INDEX idx_secretary_calendar_command_payload_scope
  ON secretary_calendar_command_payloads(user_id, tenant_id);
