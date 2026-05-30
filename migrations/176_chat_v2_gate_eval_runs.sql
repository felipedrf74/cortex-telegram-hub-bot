-- WP-19 (2026-05-30): Chat Core v2 corpus-eval run history.
--
-- WP-19 is the SOLE creator of `chat_v2_gate_eval_runs`. It does NOT recreate
-- `chat_v2_gate_metrics` (WP-13 owns it via migration 174) or its store module
-- (`gate-metrics-store.ts`); WP-19 only CALLS `upsertRecallAt8()` from there to
-- write the single keyed `recall_at_8_latest` row. This table is the SEPARATE,
-- append-only per-run history that complements that keyed-latest row (§5.C).
--
-- MIGRATION NUMBER = 176 (NOT a second 172/174). The build plan
-- (`docs/ai/chatcore-v2-orchestrator-runtime-build-plan.md` §5.C / WP-19)
-- pins WP-19 to 176 and reserves 175 for WP-14's `chat_v2_canary_turn_log`.
-- The migration RUNNER (`src/services/database.ts > runMigrations`) tracks
-- applied migrations by FILENAME in `_migrations` (`filename TEXT NOT NULL
-- UNIQUE`); it applies any *.sql file whose filename is not already applied
-- (there is NO "above the current max prefix" gate, so out-of-order is safe).
-- The only hard rule is no duplicate numeric prefix
-- (`assertNoUnexpectedMigrationPrefixCollisions`). Current max on disk is 174,
-- so both 175 and 176 are free; 176 is chosen deliberately to leave 175 for
-- WP-14 and to match the authoritative build plan.
--
-- Privacy (§1.3 / §5.F): every column here is a SAFE SCALAR — a run id, an
-- eval-type enum, a numeric recall, an integer corpus item count, a corpus
-- CONTENT-HASH (a digest, never the corpus text), a salted-token coverage
-- count, and timestamps. There is NO raw message text, user input, tenant
-- identity, candidate/expected capability label, or any other PII. The corpus
-- loader (`shadow-corpus-loader.ts`) drops raw message text entirely before any
-- corpus item reaches this table (OD-4); the only message-derived value that can
-- ever be persisted is a tenant+user-salted HMAC token, and even that is NOT
-- stored on this run-history row — only its count is.
--
-- HONESTY (§5.C, Issue 6): a run over the SYNTHETIC seed corpus records its row
-- here with `corpus_is_synthetic_seed = 1` and writes a recall bound to the
-- synthetic content-hash, which WP-13's `gateCanPromote` REJECTS. Recording the
-- run does NOT open the gate; only a recall measured over a non-synthetic,
-- peer-reviewed real corpus can. This run-history row is audit, not authority.

CREATE TABLE IF NOT EXISTS chat_v2_gate_eval_runs (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                   TEXT NOT NULL UNIQUE,    -- deterministic-or-uuid run identifier
  eval_type                TEXT NOT NULL            -- which pipeline produced the run
    CHECK (eval_type IN ('weekly', 'seed', 'manual')),
  recall_at_k              REAL NOT NULL,           -- the measured recall@k scalar (no PII)
  k                        INTEGER NOT NULL,        -- the k in recall@k (8 for the gate)
  corpus_item_count        INTEGER NOT NULL,        -- total merged corpus items (golden + shadow)
  shadow_item_count        INTEGER NOT NULL,        -- how many items came from the shadow corpus
  golden_item_count        INTEGER NOT NULL,        -- how many items came from the golden corpus
  corpus_content_hash      TEXT NOT NULL,           -- digest of the measured corpus (NEVER the corpus text)
  corpus_is_synthetic_seed INTEGER NOT NULL,        -- 0 / 1 (1 = bound to the rejected synthetic-seed hash)
  wrote_persisted_recall   INTEGER NOT NULL,        -- 0 / 1 (did this run call upsertRecallAt8?)
  recorded_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_gate_eval_runs_recorded_at
  ON chat_v2_gate_eval_runs(recorded_at);
