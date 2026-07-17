-- 236: mutation availability holdback on the task ledger (M6 latency work).
-- `available_at` is the earliest instant the push worker may claim a journaled
-- mutation. NULL (the default for every existing writer) means immediately
-- available — identical to pre-236 behavior. task.delete producers journal
-- available_at = now + 10s so the iOS undo window can retire a delete before
-- the provider hard-delete ships; the gate lives in the worker's readyMutations
-- SQL, so cron, push-kick, and force-sync all respect it durably.
-- Plain ADD COLUMN: the production runner strips already-applied ADD COLUMN
-- statements (filterAlreadyAppliedAddColumnStatements), so re-running is safe.
ALTER TABLE task_mutations ADD COLUMN available_at TEXT;
