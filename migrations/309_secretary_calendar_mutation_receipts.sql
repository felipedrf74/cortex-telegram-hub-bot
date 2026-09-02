-- 309: durable idempotency receipts for updates/deletes of existing events.
--
-- Creation receipts remain bound to Secretary agenda items in migration 308.
-- Existing provider events need a separate receipt because they may predate
-- Nexus and therefore have no canonical agenda_item_id.

CREATE TABLE secretary_calendar_mutation_receipts (
  user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  operation TEXT NOT NULL CHECK (operation IN ('update', 'delete')),
  provider_source TEXT NOT NULL CHECK (provider_source IN ('google', 'outlook')),
  provider_event_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  state TEXT NOT NULL CHECK (state IN ('prechecking', 'write_pending', 'review_required', 'succeeded')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  processing_lease_token TEXT,
  processing_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id, idempotency_key),
  CHECK (CAST(user_id AS TEXT) = tenant_id),
  CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  CHECK (processing_lease_token IS NULL OR length(trim(processing_lease_token)) > 0),
  CHECK ((processing_lease_token IS NULL) = (processing_lease_expires_at IS NULL)),
  CHECK (length(trim(provider_event_id)) BETWEEN 1 AND 500)
);

CREATE INDEX idx_secretary_calendar_mutation_expiry
  ON secretary_calendar_mutation_receipts(expires_at);
