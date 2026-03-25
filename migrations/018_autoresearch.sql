-- Autoresearch: automated prompt optimization experiments
CREATE TABLE IF NOT EXISTS autoresearch_experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    baseline_score REAL NOT NULL,
    new_score REAL,
    improvement REAL,
    mutation_description TEXT,
    prompt_diff TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    test_inputs_count INTEGER NOT NULL,
    eval_details JSON,
    git_commit_hash TEXT,
    duration_ms INTEGER,
    model_used TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    scorer_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autoresearch_target ON autoresearch_experiments(target, created_at);
CREATE INDEX IF NOT EXISTS idx_autoresearch_run ON autoresearch_experiments(run_id);

CREATE VIEW IF NOT EXISTS autoresearch_summary AS
SELECT target, run_id, COUNT(*) as rounds,
    MIN(baseline_score) as starting_score,
    MAX(CASE WHEN decision = 'kept' THEN new_score ELSE NULL END) as best_score,
    SUM(CASE WHEN decision = 'kept' THEN 1 ELSE 0 END) as kept_count,
    SUM(CASE WHEN decision = 'reverted' THEN 1 ELSE 0 END) as reverted_count,
    MIN(created_at) as started_at, MAX(created_at) as finished_at
FROM autoresearch_experiments GROUP BY target, run_id;
