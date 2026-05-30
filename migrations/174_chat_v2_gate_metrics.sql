-- WP-13 (2026-05-30): Chat Core v2 persisted gate metrics + automated gate-check log.
--
-- WP-13 is the SOLE creator of `chat_v2_gate_metrics` and its gate-check log.
-- WP-19 (migration 176) adds a SEPARATE `chat_v2_gate_eval_runs` table and
-- CALLS `upsertRecallAt8()` from `gate-metrics-store.ts`; WP-19 does NOT
-- recreate this table, the keyed-metric store, or its store module (§5.C).
--
-- MIGRATION NUMBER = 174 (172/173 taken by WP-08/WP-07). The migration RUNNER
-- (`src/services/database.ts > runMigrations`) tracks applied migrations by
-- FILENAME in `_migrations` (`filename TEXT NOT NULL UNIQUE`); it applies any
-- *.sql file whose filename is not already applied (no "above max prefix" gate).
-- The only hard rule is no duplicate numeric prefix
-- (`assertNoUnexpectedMigrationPrefixCollisions`), which 174 satisfies (173 is
-- the current max; 174 is free, non-colliding).
--
-- WHY a keyed-config row, not an append-only table: the gate reads the SINGLE
-- latest persisted recall@8 (`recall_at_8_latest`). Modelling it as a keyed
-- config (`metric_key` PK + upsert) keeps "latest" trivially O(1) and avoids a
-- secondary "max(recorded_at)" scan. Per-run history is WP-19's separate
-- `chat_v2_gate_eval_runs` concern, not this table's.
--
-- Privacy (§1.3 / §5.J): every column here is a SAFE SCALAR — a metric key, a
-- numeric metric value, a corpus CONTENT-HASH (a digest, never the corpus
-- text), and timestamps. There is NO raw message text, user input, tenant
-- identity, or other PII in either table.
--
-- HONESTY (§5.C, Issue 6): no row is seeded here. `getLatestRecallAt8()`
-- returns null until WP-19-seed writes the first persisted recall through
-- `upsertRecallAt8()`. `gateCanPromote` is therefore FALSE by construction
-- until then — the DOCUMENTED, EXPECTED state, not a defect. The persisted
-- recall is also bound to a corpus content-hash so the synthetic seed corpus
-- can never satisfy the promotion gate.

CREATE TABLE IF NOT EXISTS chat_v2_gate_metrics (
  metric_key          TEXT PRIMARY KEY,            -- e.g. 'recall_at_8_latest'
  metric_value        REAL NOT NULL,               -- the scalar metric (no PII)
  corpus_content_hash TEXT,                         -- digest of the measured corpus (nullable; NEVER the corpus text)
  recorded_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Automated gate-check audit log. The hourly `chat_core_v2_gate_check` cron
-- (gated by CHAT_CORE_V2_GATE_CHECK_ENABLED) writes one row per evaluation so
-- the operator has a timeline of gate readiness. SAFE SCALARS ONLY.
CREATE TABLE IF NOT EXISTS chat_v2_gate_check_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_can_promote         INTEGER NOT NULL,        -- 0 / 1
  meets_min_rows           INTEGER NOT NULL,        -- 0 / 1
  meets_schema_validity    INTEGER NOT NULL,        -- 0 / 1
  meets_safe_shape         INTEGER NOT NULL,        -- 0 / 1
  recall_at_8              REAL,                    -- persisted recall (null when none yet)
  recall_meets_target      INTEGER NOT NULL,        -- 0 / 1
  recall_is_synthetic_hash INTEGER NOT NULL,        -- 0 / 1 (1 = bound to the rejected synthetic-seed hash)
  shadow_row_count         INTEGER NOT NULL,
  checked_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_gate_check_log_checked_at
  ON chat_v2_gate_check_log(checked_at);
