-- Migration 169: local_request_units on api_usage
--
-- Adds a metering dimension for zero-cost local LLM calls so the per-user
-- dollar-based cost guardrail isn't bypassed. cost_usd stays 0 for
-- provider='ollama' rows (truth); local_request_units=1 per accepted
-- Ollama call lets the new local-llm-rate-limiter throttle on call count.
--
-- IDEMPOTENT: src/services/database.ts line 204 already PRAGMA-guards
-- duplicate ADD COLUMN statements and skips them with a warn log, so this
-- file is safe to re-run.
--
-- See WO-ollama-local-llm and plan Revision 4 amendment R3-4.

ALTER TABLE api_usage ADD COLUMN local_request_units INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_api_usage_local_units
  ON api_usage (provider, user_id, ts)
  WHERE local_request_units > 0;

-- Rollback: DROP INDEX IF EXISTS idx_api_usage_local_units;
--           -- (column removal requires SQLite's ALTER TABLE ... DROP COLUMN
--           --  which is 3.35+; manual rebuild may be needed on older SQLite)
