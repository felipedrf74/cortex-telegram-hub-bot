-- Onboarding questionnaire sessions and user profiles
-- Supports multi-step profiling for fitness, diet, homeschool, etc.

CREATE TABLE IF NOT EXISTS onboarding_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    questionnaire   TEXT NOT NULL,           -- e.g. 'fitness', 'diet', 'homeschool'
    current_step    INTEGER NOT NULL DEFAULT 0,
    answers         TEXT NOT NULL DEFAULT '{}',  -- JSON object of step_key → answer
    status          TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress, completed, abandoned
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    UNIQUE(user_id, questionnaire)
);

CREATE TABLE IF NOT EXISTS user_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    profile_type    TEXT NOT NULL,            -- e.g. 'fitness', 'diet', 'homeschool'
    data            TEXT NOT NULL DEFAULT '{}',  -- JSON profile data from completed questionnaire
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, profile_type)
);

CREATE INDEX IF NOT EXISTS idx_onboard_user ON onboarding_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_profile_user ON user_profiles(user_id, profile_type);
