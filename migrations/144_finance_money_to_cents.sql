-- Add cent-backed storage for finance transaction amounts.
-- Legacy REAL `amount` stays for one release as a compatibility read path.

ALTER TABLE finance_transactions ADD COLUMN amount_cents INTEGER;

UPDATE finance_transactions
   SET amount_cents = CAST(ROUND(amount * 100) AS INTEGER)
 WHERE amount_cents IS NULL
   AND amount IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_tx_user_date_amount_cents
  ON finance_transactions(user_id, date, amount_cents);

