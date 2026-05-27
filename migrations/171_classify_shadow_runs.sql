-- Option 3 (2026-05-26): classify shadow-eval table.
--
-- Stores per-call shadow Ollama classification results alongside the
-- live Gemini baseline. Used to validate that a small dedicated
-- classifier model (qwen2.5:3b-instruct-q4_K_M) agrees with the cloud
-- baseline before we cut over to Ollama for the live classify path.
--
-- Privacy (O3-A5, O3-A20): message bodies are NEVER stored. Only an
-- HMAC-SHA256 hash keyed by CLASSIFY_SHADOW_HASH_SECRET. The redacted
-- preview column is present but always NULL in the v1 rollout.
-- Future enable would require routing the redactor pipeline through
-- here first.
--
-- Schema versioning (O3-A21): `schema_version` lets queries safely
-- filter rows across migrations. Bump it in a new migration file
-- (172_..., 173_...) rather than ALTERing this one in-place.
--
-- Manual review (O3-A24): Gemini is the production baseline, NOT
-- ground truth. The cutover gate requires every disagreement row to
-- be manually labeled (`manually_reviewed=1`) before pass/fail
-- evaluation. Reviewed rows are also exempt from retention pruning.

CREATE TABLE IF NOT EXISTS classify_shadow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  request_id TEXT NULL,                            -- O3-A21: correlate with audit_trail
  user_id INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER NOT NULL DEFAULT 0,
  message_hash TEXT NOT NULL,                      -- O3-A5/A20: HMAC-SHA256
  message_preview_redacted TEXT NULL,              -- always NULL in v1 rollout
  schema_version INTEGER NOT NULL DEFAULT 1,       -- O3-A21
  ollama_model TEXT,                               -- O3-A21: the classifier model that ran
  ollama_prompt_version TEXT,                      -- O3-A21: compact-prompt version
  gemini_model TEXT,                               -- O3-A21: baseline model
  gemini_domain TEXT,
  gemini_confidence REAL,
  gemini_duration_ms INTEGER,
  ollama_domain TEXT,
  ollama_confidence REAL,
  ollama_duration_ms INTEGER,
  ollama_error TEXT,
  agree INTEGER NOT NULL DEFAULT 0,
  manually_reviewed INTEGER NOT NULL DEFAULT 0,    -- O3-A24
  manual_review_verdict TEXT NULL                  -- O3-A24: 'gemini_correct' | 'ollama_correct' | 'both_wrong' | 'either_acceptable'
);

CREATE INDEX IF NOT EXISTS idx_classify_shadow_ts ON classify_shadow_runs(ts);
CREATE INDEX IF NOT EXISTS idx_classify_shadow_agree ON classify_shadow_runs(agree, ts);
CREATE INDEX IF NOT EXISTS idx_classify_shadow_request_id ON classify_shadow_runs(request_id);
CREATE INDEX IF NOT EXISTS idx_classify_shadow_review ON classify_shadow_runs(manually_reviewed, agree, ts);
