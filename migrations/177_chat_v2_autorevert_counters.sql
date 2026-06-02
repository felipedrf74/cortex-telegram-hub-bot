-- Wave-2 rank 6 (2026-05-30): Chat Core v2 auto-revert per-tenant per-hour
-- counter tables (schema-compliance + legacy-fallback).
--
-- These two tables are the durable, queryable producers the auto-revert metrics
-- aggregator reads to replace its hardcoded revert-safe placeholders:
--   - `computeSchemaComplianceRate1h` sums pass/fail over the trailing 1h, and
--   - `computeLegacyFallbackRate24h`  sums fallback/total over the trailing 24h.
-- See `src/services/chat-core-v2/metrics-aggregator.ts` +
-- `src/services/chat-core-v2/autorevert-counters-store.ts`.
--
-- MIGRATION NUMBER = 177. The migration RUNNER
-- (`src/services/database.ts > runMigrations`) tracks applied migrations by
-- FILENAME in `_migrations` (`filename TEXT NOT NULL UNIQUE`); it applies any
-- *.sql file whose filename is not already applied (there is no "above max
-- prefix" gate). The only hard rule is no duplicate numeric prefix
-- (`assertNoUnexpectedMigrationPrefixCollisions`). Current max prefix is 176
-- (WP-19 gate eval runs); 175 is taken by Wave-2 rank 5 (prepass miss log).
-- 177 is free and non-colliding.
--
-- OFF-MODE INERTNESS (load-bearing): nothing in the OFF-mode live route writes
-- to either table. The schema-compliance counter is incremented ONLY from the
-- shadow planner path (`planChatCoreV2ShadowTurnWithPlanner`), which runs ONLY
-- when a planner is injected (shadow+/sandbox), so it is off-mode inert by
-- construction. The legacy-fallback counter is incremented ONLY behind an
-- ACTIVE-mode guard (`runChatCoreV2OrchestrationGate`, which has already proven
-- mode is canary/on AND the per-tenant kill-switch is not off before any
-- increment). When CHAT_CORE_V2_ORCHESTRATOR_MODE is off/absent both counters
-- stay completely untouched and these tables stay EMPTY.
--
-- REVERT-SAFE DEFAULTS: when a table is EMPTY the aggregator returns its
-- documented no-data default (compliance 1.0, fallback 0.0) so the auto-revert
-- valve never false-fires on a dormant/idle tenant.
--
-- PRIVACY (§1.3 / §5.J — mirrors migration 174's posture): every column here is
-- a SAFE SCALAR — an internal `tenant_id` scoping identifier, an hour-bucket
-- timestamp string, integer counters, and an updated_at timestamp. There is NO
-- raw user message text, prompt text, capability id, or other free-text PII in
-- ANY column. `window_start` is a coarse hour bucket ('YYYY-MM-DDTHH'), never a
-- per-turn timestamp, so it cannot fingerprint an individual turn.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS make re-running a no-op,
-- and the store module ships matching ensure*Table() helpers for fresh in-memory
-- test DBs.

CREATE TABLE IF NOT EXISTS chat_v2_schema_compliance_counter (
  tenant_id     TEXT NOT NULL,                              -- internal tenant id (scoping, not PII)
  window_start  TEXT NOT NULL,                              -- hour bucket 'YYYY-MM-DDTHH' (UTC), never a per-turn ts
  pass_count    INTEGER NOT NULL DEFAULT 0,                 -- constrained outputs that validated (valid|repaired)
  fail_count    INTEGER NOT NULL DEFAULT 0,                 -- constrained outputs that stayed unrepairable
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_schema_compliance_counter_tenant_window
  ON chat_v2_schema_compliance_counter(tenant_id, window_start);

CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_counter (
  tenant_id       TEXT NOT NULL,                            -- internal tenant id (scoping, not PII)
  window_start    TEXT NOT NULL,                            -- hour bucket 'YYYY-MM-DDTHH' (UTC), never a per-turn ts
  fallback_count  INTEGER NOT NULL DEFAULT 0,               -- turns that fell back to the legacy route under active mode
  total_count     INTEGER NOT NULL DEFAULT 0,               -- total active-mode turns observed at this gate
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_fallback_counter_tenant_window
  ON chat_v2_legacy_fallback_counter(tenant_id, window_start);
