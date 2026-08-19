-- 291: reconciliation progress cursor for Apple credit lots.
--
-- The reconciliation job ordered by id with a fixed limit, so every pass
-- re-checked the same head of the table and lots beyond the limit were never
-- reached (QA5 P2 recon-no-cursor / recon-window).
--
-- The cursor lives in its own table rather than a column on ai_credit_lots:
-- that table is append-only and its trigger permits ONLY the active->revoked
-- transition, so operational metadata must not live beside financial fields.
--
-- Expand only: one new table, no backfill, predecessor-compatible.

CREATE TABLE IF NOT EXISTS ai_credit_lot_reconciliation_state (
  lot_id INTEGER PRIMARY KEY,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_credit_lot_reconciliation_checked
  ON ai_credit_lot_reconciliation_state (checked_at);
