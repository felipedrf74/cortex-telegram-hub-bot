-- Down 310: privacy redaction is intentionally irreversible. Restoring retired
-- recipient, subject, or provider-error text would reintroduce data the
-- forward migration was required to remove.
SELECT 1;
