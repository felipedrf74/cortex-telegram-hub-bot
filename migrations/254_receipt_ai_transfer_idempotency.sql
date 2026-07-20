-- 254: Bind one explicit receipt-AI consent UUID to one exact transfer and
-- prevent duplicate provider spend on uncertain retries.
--
-- Only tenant-scoped keyed hashes and an encrypted, 24-hour replay response
-- are stored. Raw consent UUIDs, images, OCR text, and provider payloads are
-- excluded. Terminal metadata remains after response expiry so an old UUID can
-- never authorize another provider call.

CREATE TABLE IF NOT EXISTS receipt_ai_transfer_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  consent_receipt_key_hash TEXT NOT NULL CHECK (length(consent_receipt_key_hash) = 64),
  transfer_binding_hash TEXT NOT NULL CHECK (length(transfer_binding_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  response_ciphertext TEXT,
  response_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  error_status INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'in_progress'
      AND response_ciphertext IS NULL
      AND response_expires_at IS NULL
      AND error_code IS NULL
      AND error_message IS NULL
      AND error_status IS NULL)
    OR
    (status = 'completed'
      AND error_code IS NULL
      AND error_message IS NULL
      AND error_status IS NULL)
    OR
    (status = 'failed'
      AND response_ciphertext IS NULL
      AND response_expires_at IS NULL
      AND error_code IS NOT NULL
      AND error_message IS NOT NULL
      AND error_status BETWEEN 400 AND 599)
  ),
  UNIQUE (tenant_id, user_id, consent_receipt_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_receipt_ai_transfer_execution_status
  ON receipt_ai_transfer_executions(tenant_id, user_id, status, updated_at);
