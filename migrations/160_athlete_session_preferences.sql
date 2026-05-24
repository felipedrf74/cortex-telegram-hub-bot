-- 160: Athlete session preferences (symptom-aware, opt-in).
--
-- Per slice B4b of the Week-Level Adaptability + Periodization plan
-- (v2.1). The v2.1 critique correctly noted that cycle-phase
-- algorithmic modulation has mixed evidence (McNulty 2020 meta);
-- the right MVP is symptom-aware **capture + preference**, with
-- algorithmic modulation deferred.
--
-- This table stores the user-declared preference for a given date —
-- typically "I'd prefer lower intensity today" — without ANY
-- inferred cycle-phase prediction. Reasons may include menstrual
-- symptoms (when the user opts into menstrual consent scope), but
-- the table is generic enough to cover non-menstrual reasons too
-- ("travel fatigue", "high work stress").
--
-- Engines (C8 scenario classifier) consume the preference as a soft
-- signal: it modulates intensity ceiling, never overrides safety.

CREATE TABLE IF NOT EXISTS athlete_session_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  -- ISO 8601 date the preference applies to.
  date TEXT NOT NULL,
  -- 'lower_intensity' | 'standard' | 'higher_intensity'. The
  -- engine treats 'lower_intensity' as a soft cap on the day's
  -- intensity ceiling; 'higher_intensity' as a hint that the
  -- athlete is feeling strong; 'standard' as no override.
  intensity_preference TEXT NOT NULL,
  -- Short tag describing the reason. Examples: 'menstrual_symptom',
  -- 'travel_fatigue', 'high_work_stress', 'self_reported_strong'.
  -- Engine emits a decision-reason citing this tag.
  reason_tag TEXT,
  -- Optional free-text note from the user.
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_athlete_session_preferences_user_date
  ON athlete_session_preferences(user_id, date DESC);
