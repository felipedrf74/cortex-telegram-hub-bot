-- 285: additive AI credit ledger foundation (hybrid AI commerce plan §2).
--
-- Default OFF: no runtime path consumes these tables in this release; the
-- admission and catalog layers ship separately. Applying this migration
-- cannot charge a user, start provider work, or alter existing billing.
--
-- Money evidence is append-only and enforced at the schema level:
-- - ai_credit_lots accept only the active -> revoked lifecycle transition;
-- - ai_credit_reservations accept only reserved -> captured/released/expired;
-- - ai_credit_captures are immutable once written.
-- The predecessor image ignores the new columns and tables. Per release
-- policy, existing tables gain only DEFAULT'd nullable-compatible columns.

ALTER TABLE plan_configs ADD COLUMN monthly_ai_credits INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN daily_ai_credit_cap INTEGER DEFAULT 0;

UPDATE plan_configs
SET monthly_ai_credits = CASE plan_id
      WHEN 'free' THEN 60
      WHEN 'beta' THEN 60
      WHEN 'pro' THEN 500
      WHEN 'max' THEN 1200
      WHEN 'owner' THEN 12000
      ELSE 0 END,
    daily_ai_credit_cap = CASE plan_id
      WHEN 'free' THEN 5
      WHEN 'beta' THEN 5
      WHEN 'pro' THEN 50
      WHEN 'max' THEN 100
      WHEN 'owner' THEN 1000
      ELSE 0 END
WHERE plan_id IN ('free', 'beta', 'pro', 'max', 'owner');

CREATE TABLE ai_credit_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  lot_type TEXT NOT NULL CHECK (lot_type IN ('monthly', 'promotional', 'purchased')),
  credits_granted INTEGER NOT NULL CHECK (credits_granted > 0),
  granted_at TEXT NOT NULL,
  -- NULL means the lot never expires (purchased credits).
  expires_at TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('subscription_period', 'promotion', 'provider_purchase', 'admin_grant')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) > 0),
  provider TEXT CHECK (provider IS NULL OR provider IN ('stripe', 'apple')),
  provider_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE UNIQUE INDEX idx_ai_credit_lots_source
  ON ai_credit_lots (user_id, source_kind, source_ref);
CREATE UNIQUE INDEX idx_ai_credit_lots_provider_txn
  ON ai_credit_lots (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX idx_ai_credit_lots_user_status
  ON ai_credit_lots (user_id, status);

CREATE TRIGGER ai_credit_lots_no_delete
BEFORE DELETE ON ai_credit_lots
BEGIN
  SELECT RAISE(ABORT, 'ai_credit_lots rows are append-only');
END;

CREATE TRIGGER ai_credit_lots_limited_update
BEFORE UPDATE ON ai_credit_lots
WHEN NOT (
  NEW.id = OLD.id
  AND NEW.user_id = OLD.user_id
  AND NEW.lot_type = OLD.lot_type
  AND NEW.credits_granted = OLD.credits_granted
  AND NEW.granted_at = OLD.granted_at
  AND COALESCE(NEW.expires_at, '') = COALESCE(OLD.expires_at, '')
  AND NEW.source_kind = OLD.source_kind
  AND NEW.source_ref = OLD.source_ref
  AND COALESCE(NEW.provider, '') = COALESCE(OLD.provider, '')
  AND COALESCE(NEW.provider_transaction_id, '') = COALESCE(OLD.provider_transaction_id, '')
  AND OLD.status = 'active'
  AND NEW.status = 'revoked'
  AND NEW.revoked_at IS NOT NULL
  AND NEW.revoke_reason IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'ai_credit_lots permit only the active -> revoked transition');
END;

CREATE TABLE ai_credit_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  operation_class TEXT NOT NULL CHECK (operation_class IN ('standard', 'deep', 'standard_script', 'scheduled_script', 'priority_script')),
  credits INTEGER NOT NULL CHECK (credits > 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'captured', 'released', 'expired')),
  tenant_scope TEXT NOT NULL CHECK (length(tenant_scope) > 0),
  workload TEXT NOT NULL CHECK (length(workload) > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
  client_operation_id TEXT NOT NULL CHECK (length(client_operation_id) > 0),
  reserved_at TEXT NOT NULL,
  reserved_day TEXT NOT NULL CHECK (length(reserved_day) = 10),
  settled_at TEXT,
  capture_result_ref TEXT,
  capture_shortfall INTEGER NOT NULL DEFAULT 0 CHECK (capture_shortfall >= 0)
);

CREATE UNIQUE INDEX idx_ai_credit_reservations_replay
  ON ai_credit_reservations (tenant_scope, user_id, workload, request_hash, client_operation_id);
CREATE INDEX idx_ai_credit_reservations_user_day
  ON ai_credit_reservations (user_id, reserved_day, state);
CREATE INDEX idx_ai_credit_reservations_state
  ON ai_credit_reservations (state, reserved_at);

CREATE TRIGGER ai_credit_reservations_no_delete
BEFORE DELETE ON ai_credit_reservations
BEGIN
  SELECT RAISE(ABORT, 'ai_credit_reservations rows are append-only');
END;

CREATE TRIGGER ai_credit_reservations_limited_update
BEFORE UPDATE ON ai_credit_reservations
WHEN NOT (
  NEW.id = OLD.id
  AND NEW.user_id = OLD.user_id
  AND NEW.operation_class = OLD.operation_class
  AND NEW.credits = OLD.credits
  AND NEW.tenant_scope = OLD.tenant_scope
  AND NEW.workload = OLD.workload
  AND NEW.request_hash = OLD.request_hash
  AND NEW.client_operation_id = OLD.client_operation_id
  AND NEW.reserved_at = OLD.reserved_at
  AND NEW.reserved_day = OLD.reserved_day
  AND OLD.state = 'reserved'
  AND NEW.state IN ('captured', 'released', 'expired')
  AND NEW.settled_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'ai_credit_reservations permit only reserved -> captured/released/expired settlement');
END;

CREATE TABLE ai_credit_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES ai_credit_reservations(id),
  lot_id INTEGER NOT NULL REFERENCES ai_credit_lots(id),
  user_id INTEGER NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ai_credit_captures_lot ON ai_credit_captures (lot_id);
CREATE INDEX idx_ai_credit_captures_reservation ON ai_credit_captures (reservation_id);

CREATE TRIGGER ai_credit_captures_no_update
BEFORE UPDATE ON ai_credit_captures
BEGIN
  SELECT RAISE(ABORT, 'ai_credit_captures rows are immutable');
END;

CREATE TRIGGER ai_credit_captures_no_delete
BEFORE DELETE ON ai_credit_captures
BEGIN
  SELECT RAISE(ABORT, 'ai_credit_captures rows are immutable');
END;
