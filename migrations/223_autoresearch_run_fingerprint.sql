-- 223: Autoresearch pre-flight skip-gate persistence.
-- The Sunday autoresearch cron previously re-ran its rotation target
-- unconditionally (~2xN generate+score calls per round, up to 3 rounds,
-- billed to system actor 0) even when the target's prompt had not changed
-- since the last run and that run already scored well.
-- These columns store, stamped on every row of a run (by run_id) when the
-- run completes:
--   prompt_hash  sha256 fingerprint of the end-of-run prompt content plus
--                eval-target config (criteria, test inputs, models)
--   final_score  the run's final weighted score (0..1)
-- The scheduled entry path skips a run when the latest row's prompt_hash
-- matches the current fingerprint AND final_score >= the re-score
-- threshold (env AUTORESEARCH_RESCORE_THRESHOLD, default 0.9).
-- NULL (legacy rows / crashed runs) disables the skip and the run proceeds.
ALTER TABLE autoresearch_experiments ADD COLUMN prompt_hash TEXT;
ALTER TABLE autoresearch_experiments ADD COLUMN final_score REAL;
