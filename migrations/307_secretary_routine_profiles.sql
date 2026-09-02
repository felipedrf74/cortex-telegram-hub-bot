-- 307: explicit, tenant-scoped Secretary routine profiles.
--
-- A profile is created only after an explicit user save. Absence is the
-- canonical `unconfigured` state; no migration backfill infers working hours,
-- focus windows, or protected routines from historical behavior.
-- The tables deliberately avoid a new foreign key to the pre-existing users
-- table so this remains a predecessor-compatible expand migration. The
-- account-erasure service discovers and removes every user_id-owned table.

CREATE TABLE secretary_routine_profiles (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  working_windows_json TEXT NOT NULL CHECK (json_valid(working_windows_json)),
  preferred_focus_windows_json TEXT NOT NULL CHECK (json_valid(preferred_focus_windows_json)),
  protected_routines_json TEXT NOT NULL CHECK (json_valid(protected_routines_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id),
  CHECK (user_id = tenant_id)
);

CREATE TABLE secretary_routine_idempotency_receipts (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id, idempotency_key),
  CHECK (user_id = tenant_id)
);

CREATE INDEX idx_secretary_routine_receipts_expiry
  ON secretary_routine_idempotency_receipts(expires_at);
