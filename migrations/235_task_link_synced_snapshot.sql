-- 235: last-synced content snapshot on provider links (M2B conflict work).
-- Records the compact task content ({title,status,priority,dueDate,
-- dueIsDatetime,notes}) both sides agreed on at the last successful sync:
-- written by the push worker after a provider write lands and by the pull
-- path when provider content is imported/applied/verified hash-equal. It is
-- the merge base for conflict resolution (and future 3-way merge) — without
-- it "keep mine"/"keep theirs" cannot tell which side actually diverged.
-- Plain ADD COLUMN: the production runner strips already-applied ADD COLUMN
-- statements (filterAlreadyAppliedAddColumnStatements), so re-running is safe.
ALTER TABLE task_provider_links ADD COLUMN last_synced_snapshot TEXT;
