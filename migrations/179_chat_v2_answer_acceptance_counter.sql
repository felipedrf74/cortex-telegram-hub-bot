-- Wave-3 rank 8 (2026-05-30): Chat Core v2 answer-acceptance counter — an INERT,
-- canary-only EXIT-metric scaffold (per-tenant per-locale).
--
-- This table backs `incrementAnswerAcceptance()` /
-- `computeAnswerAcceptanceRate()` in
-- `src/services/chat-core-v2/answer-acceptance-counter.ts`. It accumulates
-- accepted/total per (tenant_id, locale) so the operator can read the Phase-3
-- canary EXIT metric: answer-acceptance rate per locale bucket
--   (en >= 90%, pt-BR >= 85%, pt-PT >= 80%, mixed >= 75%).
-- These EXIT thresholds are DISTINCT from WP-13 recall@8 and from the
-- composer-mode counter — a separate measurement axis.
--
-- MIGRATION NUMBER = 179. The migration RUNNER
-- (`src/services/database.ts > runMigrations`) tracks applied migrations by
-- FILENAME in `_migrations` (`filename TEXT NOT NULL UNIQUE`); it applies any
-- *.sql file whose filename is not already applied (there is no "above max
-- prefix" gate). The only hard rule is no duplicate numeric prefix
-- (`assertNoUnexpectedMigrationPrefixCollisions`). 178 is taken by the canary
-- turn log; 179 is free and non-colliding.
--
-- CANARY-ONLY INERTNESS (load-bearing): NOTHING in off/shadow/on/absent writes
-- to this table. `incrementAnswerAcceptance()` is a RAW writer (it writes when
-- called); its sole intended call site is canary-gated via
-- `shouldServeCanaryForTenant`, so off / shadow / on / absent and any non-cohort
-- or killed tenant write NOTHING and this table stays EMPTY. Per the WO, the
-- increment is shipped as a TESTED, seeded API rather than wired to a live call
-- site, so there is no live write path at all in this wave.
--
-- THIS IS NOT THE PROMOTION GATE: the acceptance rate here is a canary EXIT
-- metric, NEVER promotion-readiness. `gateCanPromote` (gate-metrics-store.ts)
-- stays the SOLE promotion authority and stays false until a real corpus is
-- persisted. Nothing here reads or writes `gateCanPromote`.
--
-- REVERT-SAFE DEFAULT: when a (tenant, locale) row is EMPTY,
-- `computeAnswerAcceptanceRate()` returns null (no data) — NOT a misleading 0,
-- which would falsely read as "0% accepted" and could trip an exit check on a
-- dormant tenant.
--
-- PRIVACY (§1.3 / §5.J — mirrors migration 174's posture): every column here is
-- a SAFE SCALAR — internal `tenant_id` scoping identifier, a coarse `locale`
-- bucket, integer counters, and an updated_at timestamp. There is NO raw user
-- message text, prompt text, answer text, or other PII in ANY column.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS make re-running a no-op,
-- and the store module ships a matching ensure*Table() helper for fresh
-- in-memory test DBs.

CREATE TABLE IF NOT EXISTS chat_v2_answer_acceptance_counter (
  tenant_id      TEXT NOT NULL,                              -- internal tenant id (scoping, not PII)
  locale         TEXT NOT NULL,                              -- coarse locale bucket (en | pt-BR | pt-PT | mixed)
  accepted_count INTEGER NOT NULL DEFAULT 0,                 -- accepted answers in this (tenant, locale)
  total_count    INTEGER NOT NULL DEFAULT 0,                 -- total answers observed in this (tenant, locale)
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_answer_acceptance_counter_tenant_locale
  ON chat_v2_answer_acceptance_counter(tenant_id, locale);
