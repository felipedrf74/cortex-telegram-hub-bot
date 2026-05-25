-- 156: Adaptation ledger for adaptive plan reflows.
--
-- Audit substrate for every adaptive change to a training plan. Each
-- row records ONE coherent adaptive event: what triggered it, what the
-- plan looked like before, what it looks like after, which
-- science-policy version was active, which feature flags were on, and
-- which decision-reason codes were emitted. Per the Week-Level
-- Adaptability + Periodization plan (v2.1, slice A0b).
--
-- Hard invariants (enforced both at the DB layer and in
-- src/services/training-plan-adaptations.ts):
--
--   1. Every `adaptation_revision` increment in fitness_training_plans
--      (migration 155) has EXACTLY ONE row in this ledger. The DB-side
--      UNIQUE(plan_id, adaptation_revision) backstops the application
--      contract; concurrent racers cannot insert two rows for the same
--      revision.
--
--   2. Adaptive writes are transactional: the caller wraps the
--      increment + insert in a single BEGIN/COMMIT so a crash mid-flow
--      cannot leave a bumped counter without a ledger row, nor a
--      ledger row without a bump.
--
--   3. Previews/warnings/non-persisted changes DO NOT increment the
--      revision. They MAY still write a ledger row with `scope =
--      'preview'`, in which case `adaptation_revision` is NULL — these
--      rows exist purely for explainability and never affect plan
--      state. The (plan_id, adaptation_revision) UNIQUE excludes NULL
--      revisions, so multiple previews coexist.
--
--   4. Rollback is append-only. Calling rollbackAdaptation() does NOT
--      delete the original row; it inserts a NEW row that reverses the
--      patch, sets `rollback_of_adaptation_id` to the original's id,
--      and bumps adaptation_revision again. The application enforces
--      "latest-only" rollback (cannot reverse a revision when newer
--      revisions exist) via optimistic lock on
--      fitness_training_plans.adaptation_revision.
--
--   5. Idempotency: when a caller supplies `idempotency_key`, the
--      (plan_id, idempotency_key) UNIQUE index causes duplicate
--      requests to collapse — the second insert raises a constraint
--      violation that the application catches and returns the existing
--      row. NULL keys are not deduped (multiple keyless writes
--      coexist).
--
--   6. Privacy: rows containing health-sensitive triggers (pain,
--      illness, RED-S, menstrual) may have their `trigger_payload_json`
--      redacted in non-admin support views. The raw payload is
--      retained for owner queries + audit; the redaction happens at
--      read-time (see src/services/training-plan-adaptations.ts).

CREATE TABLE IF NOT EXISTS training_plan_adaptations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  -- Revision this row records. NULL for `scope = 'preview'` rows that
  -- explain a hypothetical adaptation without mutating the plan.
  adaptation_revision INTEGER,
  -- One of: 'plan' | 'week' | 'session' | 'preview'.
  scope TEXT NOT NULL,
  -- Free-form trigger discriminator, e.g.
  -- 'missed_session_compensation', 'deload_due',
  -- 'manual_week_reflow', 'scenario_classifier',
  -- 'safety_pause', 'rollback'. Caller-controlled.
  trigger_type TEXT NOT NULL,
  -- JSON payload describing the conditions that fired the rule.
  -- May contain redacted summaries for sensitive triggers in
  -- non-admin reads (see service module).
  trigger_payload_json TEXT,
  -- JSON Patch (RFC 6902) describing what existed before. Allows
  -- reconstruction of the prior state for rollback or audit.
  before_patch_json TEXT,
  -- JSON Patch describing what the plan looks like after the
  -- adaptation applied. Sum of before + after_patch = current state.
  after_patch_json TEXT,
  -- JSON array of TrainingDecisionReason codes emitted to the user.
  decision_reason_codes_json TEXT,
  -- Semver from training-principles.json's sciencePolicyVersion.
  -- Required for reproducibility: replaying an old plan must use the
  -- policy version that was active when it was generated.
  science_policy_version TEXT NOT NULL,
  -- JSON snapshot of feature flags relevant to this adaptation.
  -- Lets us reason about "this rule was warning-only when it fired".
  feature_flag_snapshot TEXT,
  -- Optional caller-supplied idempotency key. When present, duplicate
  -- requests with the same (plan_id, idempotency_key) collapse to a
  -- single row. NULL keys are not deduped.
  idempotency_key TEXT,
  -- Self-reference for rollback rows. NULL on the original
  -- adaptations; set to the original row's id on rollback rows.
  rollback_of_adaptation_id INTEGER,
  -- 'system' (automated), 'user' (user-initiated), or 'admin' (manual
  -- operator override).
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (rollback_of_adaptation_id) REFERENCES training_plan_adaptations(id) ON DELETE SET NULL
);

-- One ledger row per (plan, revision) — exact backstop for the
-- exactly-once contract. The partial filter excludes preview rows so
-- multiple previews can coexist for the same plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_plan_adaptations_plan_revision_unique
  ON training_plan_adaptations(plan_id, adaptation_revision)
  WHERE adaptation_revision IS NOT NULL;

-- Idempotency dedup. Same caller, same key → same row. NULL keys are
-- not deduped (SQLite UNIQUE excludes NULLs in the default
-- multi-column form, but the partial filter makes the intent explicit).
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_plan_adaptations_idempotency_unique
  ON training_plan_adaptations(plan_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Common read pattern: support views "show me the last N adaptations
-- for this plan, newest first".
CREATE INDEX IF NOT EXISTS idx_training_plan_adaptations_plan_created
  ON training_plan_adaptations(plan_id, created_at DESC);

-- For "is this revision the latest?" rollback checks.
CREATE INDEX IF NOT EXISTS idx_training_plan_adaptations_rollback_target
  ON training_plan_adaptations(rollback_of_adaptation_id)
  WHERE rollback_of_adaptation_id IS NOT NULL;
