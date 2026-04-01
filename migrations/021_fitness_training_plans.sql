-- 021: Fitness Training Plans with calendar blockers + weekly auto-adjust
-- Stores AI-generated periodized plans, weekly microcycles, individual sessions,
-- and completion logs for adherence tracking and auto-adjustment.

CREATE TABLE IF NOT EXISTS fitness_training_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT 'strength',   -- strength, running, cycling, triathlon, hybrid
    goal TEXT,                                 -- e.g. "Build strength base", "Marathon prep"
    duration_weeks INTEGER NOT NULL,
    periodization TEXT DEFAULT 'linear',       -- linear, undulating, block
    status TEXT NOT NULL DEFAULT 'active',     -- active, completed, paused, cancelled
    start_date TEXT NOT NULL,                  -- ISO 8601 date
    end_date TEXT NOT NULL,                    -- ISO 8601 date
    preferences_json TEXT,                     -- JSON: available_days, equipment, injuries, etc.
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_weeks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    week_number INTEGER NOT NULL,
    focus TEXT,                                -- strength, hypertrophy, endurance, power, deload, recovery
    intensity_pct INTEGER DEFAULT 100,         -- percentage of max planned intensity (e.g. 60 for deload)
    volume_sessions INTEGER,                   -- target sessions this week
    notes TEXT,
    auto_adjusted INTEGER NOT NULL DEFAULT 0,  -- 1 if this week was auto-adjusted
    adjustment_reason TEXT,                     -- why it was adjusted (e.g. "low HRV, high fatigue")
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    day_of_week TEXT NOT NULL,                 -- Monday, Tuesday, etc.
    session_type TEXT NOT NULL,                -- strength, running, cycling, swim, recovery, mobility
    title TEXT NOT NULL,
    description TEXT,
    exercises_json TEXT,                       -- JSON array: [{name, sets, reps, weight, rpe, rest_sec, tempo}]
    duration_minutes INTEGER,
    intensity_text TEXT,                       -- "RPE 7", "Zone 2", "80% 1RM"
    calendar_event_id TEXT,                    -- linked calendar event ID (for blockers)
    calendar_source TEXT,                      -- "outlook" or "google"
    status TEXT NOT NULL DEFAULT 'pending',    -- pending, completed, skipped, moved
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (week_id) REFERENCES training_weeks(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    actual_exercises_json TEXT,                -- JSON: what was actually done
    rpe_overall INTEGER,                      -- 1-10
    duration_minutes INTEGER,
    energy_level INTEGER,                     -- 1-10
    soreness_level INTEGER,                   -- 1-10
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_training_plans_user_status ON fitness_training_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_training_weeks_plan ON training_weeks(plan_id, week_number);
CREATE INDEX IF NOT EXISTS idx_training_sessions_week ON training_sessions(week_id);
CREATE INDEX IF NOT EXISTS idx_training_sessions_plan_status ON training_sessions(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_training_completions_plan ON training_completions(plan_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_training_sessions_calendar ON training_sessions(calendar_event_id);
