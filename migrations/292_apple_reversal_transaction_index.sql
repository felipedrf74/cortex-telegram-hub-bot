-- 292: indexed reversal transaction ids on the Apple notification inbox.
--
-- hasRecordedAppleReversalForTransaction() scanned `ORDER BY id DESC LIMIT
-- 2000` and decoded each row's nested JWS in JavaScript, because the
-- transaction id lives inside the signed payload and had no column. Past the
-- cap the scan returned a CLEAN verdict for a refund that was still on disk,
-- so restore-packs would mint credits for it (QA6 P2). Migration 286 forbids
-- deletes and retention is deferred, so reversal rows accumulate permanently
-- and the cap is crossed eventually rather than hypothetically.
--
-- Extracting the ids at ingest turns the lookup into an indexed equality
-- probe with no cap and no decode. Rows written before this migration keep
-- NULL and are resolved by a bounded backfill; the lookup fails CLOSED while
-- any unresolved reversal row remains, so it can never report a false clean.
--
-- Expand only: three nullable columns and plain equality indexes. No backfill
-- in SQL (the values are inside a signed JWS), no rewrite of existing rows,
-- predecessor-compatible — older code simply ignores the columns.
--
-- Plain indexes, not partial ones: a partial index on a pre-existing table
-- classifies as a CONTRACT migration and would halt unattended CD. Indexing
-- the NULLs costs a little space and changes nothing about the equality
-- probes these exist to serve.

ALTER TABLE apple_notification_inbox ADD COLUMN reversal_transaction_id TEXT;
ALTER TABLE apple_notification_inbox ADD COLUMN reversal_original_transaction_id TEXT;
ALTER TABLE apple_notification_inbox ADD COLUMN reversal_indexed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_apple_inbox_reversal_txn
  ON apple_notification_inbox (reversal_transaction_id);

CREATE INDEX IF NOT EXISTS idx_apple_inbox_reversal_original_txn
  ON apple_notification_inbox (reversal_original_transaction_id);

-- Drives the backfill sweep: reversal rows still awaiting extraction.
CREATE INDEX IF NOT EXISTS idx_apple_inbox_reversal_pending
  ON apple_notification_inbox (reversal_indexed_at);
