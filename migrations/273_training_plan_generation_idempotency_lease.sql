-- 273: Compatibility Training plan-generation idempotency lease (F1, Phase 1A-4).
--
-- Problem this closes
-- -------------------
-- `training_plan_generation_idempotency_scoped` (migration 207) records a
-- claim as `in_progress` but carries no ownership, liveness or expiry. The
-- claim helper only re-claims rows whose status is `failed`; every other
-- state falls through to `{ kind: 'in_progress' }`, which the route maps to
-- 409 TRAINING_PLAN_GENERATION_IN_PROGRESS. The 90s auto-key freshness window
-- explicitly excludes `in_progress` rows, so a claim orphaned by a process
-- death (OOM, SIGKILL, deploy restart) is never reclaimable.
--
-- Because both the client key (iOS derives a SHA-256 of the request) and the
-- server fallback key (`auto:<requestHash>`) are deterministic, the retry of
-- an identical plan request lands on the same orphaned row forever. The user
-- sees a permanent 409 behind the Retry button and can only escape by
-- changing a plan input.
--
-- Why these columns and not new status values
-- -------------------------------------------
-- Migration 207 constrains `status` to the lowercase set
-- ('in_progress','succeeded','failed'), and `training-plan-generation-
-- idempotency.ts` repeats that identical CHECK in its own bootstrap DDL for
-- fresh databases. Introducing `FAILED_RETRYABLE`/`FAILED_TERMINAL` would be
-- rejected by SQLite at insert time and would not be additive. The terminal
-- distinction therefore lives in a new nullable `failure_class` column, and
-- `status` keeps its existing vocabulary and values.
--
-- Rollout safety
-- --------------
-- Existing `in_progress` rows are NOT made immediately reclaimable. A row
-- could still be owned by a generation running on an older process, and
-- reclaiming it would allow two concurrent generations to activate. Instead
-- each row inherits an expiry derived from its own `updated_at` plus a
-- conservative grace that exceeds the worst-case generation (calendar writes
-- run ceil(N/5) x 15s, so a 52-week plan can legitimately take ~18 minutes).
-- Only rows already older than that grace become reclaimable, and only after
-- the grace has elapsed for the rest.
--
-- The lease is dormant until the service reads it; this migration alone
-- changes no behaviour.

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN failure_class TEXT
    CHECK (failure_class IS NULL OR failure_class IN ('retryable', 'terminal'));

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN last_error_code TEXT;

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN lease_owner TEXT;

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN fencing_token TEXT;

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN lease_expires_at TEXT;

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN heartbeat_at TEXT;

ALTER TABLE training_plan_generation_idempotency_scoped
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;

-- Conservative grace for rows that predate the lease. 30 minutes comfortably
-- exceeds the ~18 minute worst-case generation, so no in-flight work on an
-- older process can be reclaimed out from under itself.
UPDATE training_plan_generation_idempotency_scoped
   SET lease_expires_at = datetime(COALESCE(updated_at, created_at, datetime('now')), '+30 minutes')
 WHERE status = 'in_progress'
   AND lease_expires_at IS NULL;

-- Reclaim scans read (status, lease_expires_at) inside the user/tenant scope.
CREATE INDEX IF NOT EXISTS idx_training_plan_generation_idempotency_scoped_lease
  ON training_plan_generation_idempotency_scoped(status, lease_expires_at);
