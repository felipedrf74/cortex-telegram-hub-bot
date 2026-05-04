-- Email verification brute-force guard.
--
-- Codes are six digits and valid for 15 minutes. Track failed attempts per
-- active code and stop accepting guesses after a small fixed budget.

ALTER TABLE email_verification_codes
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
