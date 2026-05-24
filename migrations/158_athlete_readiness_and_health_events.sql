-- 158: Athlete readiness + health event tables.
--
-- Per the Week-Level Adaptability + Periodization plan (v2.1, slice
-- A0c). Splits time-varying state off AthleteProfile (which the v2.1
-- critique correctly noted should remain immutable stable attributes
-- only). Readiness and health signals become EVENTS that the
-- PlanGenerationContext (slice A3) consumes per-week, rather than
-- mutable fields on the profile.
--
-- Two tables, not one, because:
--
--   - Readiness signals (sleep, stress, HRV-derived statuses) are
--     low-sensitivity and updated frequently — typically once per
--     day, driven by passive device data.
--
--   - Health signals (pain, illness, injury, menstrual, RED-S) are
--     high-sensitivity and updated when the user reports them. They
--     require per-signal opt-in consent (privacy slice A4p) and
--     redaction in non-admin views.
--
-- Consent scope:
--
--   Each row carries a `consent_scope` enumerating WHICH signal
--   family the user has opted in to. A4p (privacy/consent) enforces:
--
--     - readiness_basic   — sleep, stress (default opt-in)
--     - hrv_status        — HRV-derived training-readiness ratings
--     - resting_hr        — resting HR trend
--     - pain              — pain score + location
--     - illness           — illness symptoms + duration
--     - injury            — injury status + return-to-training stage
--     - menstrual         — menstrual status (opt-in only)
--     - red_s_screening   — RED-S risk indicators (opt-in only,
--                           framed as RISK SCREENING not diagnosis,
--                           per IOC 2023 consensus)
--
--   A row's consent_scope is a comma-separated list of scopes the
--   user has authorized; the application enforces "if scope=menstrual
--   not in consent_scope, do not persist menstrual_status".

CREATE TABLE IF NOT EXISTS athlete_readiness_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  -- ISO 8601 date the readings apply to (NOT created_at — devices
  -- often upload yesterday's data this morning).
  date TEXT NOT NULL,
  -- Hours of sleep, fractional (e.g., 7.5). NULL when not reported.
  sleep_hours REAL,
  -- Subjective sleep quality, 1-10. NULL when not reported.
  sleep_quality INTEGER,
  -- Subjective stress score, 1-10. NULL when not reported.
  stress_score INTEGER,
  -- HRV-derived status. One of: 'balanced' | 'low' | 'unbalanced'
  -- | 'poor' | NULL. Mapped from device-native ratings (Garmin HRV
  -- Status, Whoop, Oura) by the integration layer.
  hrv_status TEXT,
  -- Resting-HR trend status. One of: 'normal' | 'elevated' | NULL.
  resting_hr_status TEXT,
  -- Where the data came from. e.g., 'garmin', 'apple_health',
  -- 'manual', 'whoop'. Used for cross-source de-duplication and
  -- confidence weighting in the load model (B1).
  source TEXT,
  -- Comma-separated list of consent scopes (see file header).
  consent_scope TEXT NOT NULL DEFAULT 'readiness_basic',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Latest-event-by-day read pattern: "what was the user's readiness
-- as of date D?".
CREATE INDEX IF NOT EXISTS idx_athlete_readiness_events_user_date
  ON athlete_readiness_events(user_id, date DESC);

-- Multi-source dedup at the application layer needs an efficient
-- lookup by (user, date, source).
CREATE INDEX IF NOT EXISTS idx_athlete_readiness_events_user_date_source
  ON athlete_readiness_events(user_id, date, source);


CREATE TABLE IF NOT EXISTS athlete_health_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  -- ISO 8601 date the signal applies to.
  date TEXT NOT NULL,
  -- Pain score (0-10) and free-text location. Together they gate
  -- B6 (strength progression) and feed A4 (safety overrides).
  -- Pain rows always require pain consent scope.
  pain_score INTEGER,
  pain_location TEXT,
  -- JSON array of illness symptom tags ("fever", "cough",
  -- "fatigue", "gi_distress", etc.). Used by C4 to classify
  -- return-from-gap protocol (febrile_or_systemic_illness vs
  -- minor_illness_resolved).
  illness_symptoms_json TEXT,
  -- Injury status. One of: 'none' | 'acute' | 'chronic_managed'
  -- | 'returning' | 'post_exertional_symptom_risk' | NULL.
  injury_status TEXT,
  -- Menstrual status (OPT-IN ONLY — requires 'menstrual' in
  -- consent_scope). One of: 'menses' | 'follicular' |
  -- 'ovulation' | 'luteal' | 'amenorrhea' | 'symptom_only' | NULL.
  -- Per the v2.1 critique, we do NOT infer cycle phase from
  -- calendar estimates — this column stores ONLY user-declared
  -- status or symptom-only entries (slice B4b is symptom-aware,
  -- not phase-predictive).
  menstrual_status TEXT,
  -- RED-S energy availability risk screening (OPT-IN ONLY —
  -- requires 'red_s_screening' in consent_scope). One of:
  -- 'low' | 'moderate' | 'high' | NULL. Framed as RISK SCREENING,
  -- not diagnosis (IOC 2023 REDs CAT2 is for qualified clinicians).
  energy_availability_risk TEXT,
  -- Data source: 'manual', 'integration_intake', 'inferred', etc.
  source TEXT,
  -- Comma-separated consent scopes the user has authorized for
  -- this row. The application enforces per-column gating by scope.
  consent_scope TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Latest-event-by-day read pattern.
CREATE INDEX IF NOT EXISTS idx_athlete_health_signals_user_date
  ON athlete_health_signals(user_id, date DESC);

-- A4 (safety) reads "any pain reported in the last N days":
CREATE INDEX IF NOT EXISTS idx_athlete_health_signals_user_pain
  ON athlete_health_signals(user_id, date DESC)
  WHERE pain_score IS NOT NULL;

-- C4 (gap detector) reads "any illness symptoms during the gap":
CREATE INDEX IF NOT EXISTS idx_athlete_health_signals_user_illness
  ON athlete_health_signals(user_id, date DESC)
  WHERE illness_symptoms_json IS NOT NULL;
