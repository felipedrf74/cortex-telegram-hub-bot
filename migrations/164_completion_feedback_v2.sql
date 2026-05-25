-- 157: CompletionFeedbackV2 — extend training_completions for the
--      coach-level engine's data substrate.
--
-- Per the Week-Level Adaptability + Periodization plan (v2.1, slice
-- A0c). The coach engine's B0 (load normalization), B1 (load model),
-- B5 (deload), and B6 (strength progression gating) all read post-
-- session completion data; the existing migration-023 schema captures
-- the bare minimum, not the breadth needed for sRPE × duration
-- internal load, RPE/RIR autoregulation, pain-aware progression
-- gating, or missed-session classification.
--
-- Discovery step (executed before writing this migration):
--
--   PRAGMA table_info('training_completions') showed migration-023
--   already had:
--     - rpe_overall    INTEGER (1-10, Foster CR-10 session RPE)
--     - duration_minutes INTEGER
--     - energy_level   INTEGER (1-10)
--     - soreness_level INTEGER (1-10)
--     - notes          TEXT
--     - actual_exercises_json TEXT
--
--   These are KEPT and serve as the V2 fields they semantically
--   match. `rpe_overall` IS the session_rpe field; `soreness_level`
--   IS the soreness_score field. Adding parallel columns would
--   create dual sources of truth.
--
--   The new columns below are strictly additive — finer-resolution
--   versions (completed_duration_sec) or genuinely-missing data
--   (pain, RIR, completed sets/reps/load, missed-session reasons,
--   external-training declarations, technical-success).
--
-- All new columns are nullable: backfill is impossible (no historical
-- value exists) and the engine reads with defensive defaults. The
-- engine consults `rpe_overall` first; `session_rpe`-named code paths
-- alias to this column.

-- Finer-resolution duration. Engines fall back to duration_minutes * 60
-- when this is NULL (older completions).
ALTER TABLE training_completions
  ADD COLUMN completed_duration_sec INTEGER;

-- Distance for running/cycling/swim completions, in meters. Required
-- substrate for external load calculation when a device sample is
-- present.
ALTER TABLE training_completions
  ADD COLUMN completed_distance_meters INTEGER;

-- Strength prescription completion details. JSON arrays of completed
-- sets / reps / load tonnage for each prescribed exercise, indexed by
-- the prescription order in actual_exercises_json. Used by B6 to gate
-- load progression.
ALTER TABLE training_completions
  ADD COLUMN completed_sets_json TEXT;
ALTER TABLE training_completions
  ADD COLUMN completed_reps_json TEXT;
ALTER TABLE training_completions
  ADD COLUMN completed_load_json TEXT;

-- Reps in reserve (Zourdos RIR scale, 0-5). Used by B6 alongside
-- rpe_overall for autoregulated strength progression. May be null
-- when the athlete tracks RPE but not RIR.
ALTER TABLE training_completions
  ADD COLUMN rir INTEGER;

-- Pain score (0-10, athlete-reported). Distinct from soreness_level —
-- pain implies injury risk, soreness implies normal training stress.
-- Together they gate B6 (strength progression) and feed A4 (safety).
ALTER TABLE training_completions
  ADD COLUMN pain_score INTEGER;

-- Free-text pain location (e.g., "left knee, medial", "lower back").
-- Health-sensitive (privacy slice A4p redacts in non-admin views).
ALTER TABLE training_completions
  ADD COLUMN pain_location TEXT;

-- Technical success score (0-10, athlete-reported or coach-rated).
-- "Did I execute the movement well?" — used by B6 to delay
-- progression on novel/complex exercises.
ALTER TABLE training_completions
  ADD COLUMN technical_success_score INTEGER;

-- Why a session was missed, when status=skipped. Free-form short
-- string ("illness", "travel", "low_motivation", "schedule_conflict",
-- etc.) used by C4 (gap detector) to classify the protocol class.
ALTER TABLE training_completions
  ADD COLUMN missed_reason TEXT;

-- Athlete declared they did an external (unlogged) training session.
-- 1 = yes (suppresses C1 "missed session" detection), 0/NULL = no.
ALTER TABLE training_completions
  ADD COLUMN external_training_declared INTEGER NOT NULL DEFAULT 0;
