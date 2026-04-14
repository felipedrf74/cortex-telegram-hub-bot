CREATE TABLE IF NOT EXISTS coach_states (
    user_id INTEGER PRIMARY KEY,
    recommendations_json TEXT NOT NULL,
    briefing_summary TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_coach_states_expires_at
    ON coach_states(expires_at_ms);

CREATE TABLE IF NOT EXISTS callback_entries (
    ref TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_callback_entries_expires_at
    ON callback_entries(expires_at_ms);
