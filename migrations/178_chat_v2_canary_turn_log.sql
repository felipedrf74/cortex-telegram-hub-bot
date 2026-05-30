-- Wave-3 rank 8 (2026-05-30): Chat Core v2 canary turn log — an INERT,
-- canary-only measurement scaffold.
--
-- This table is the durable sink for `recordCanaryTurn()` /
-- `maybeRecordCanaryTurn()` in
-- `src/services/chat-core-v2/canary-turn-log.ts`. It records ONE safe-scalar row
-- per served canary turn so the operator can observe canary traffic shape
-- (route, reasoning tier, confidence band, locale) over the canary window.
--
-- MIGRATION NUMBER = 178. The migration RUNNER
-- (`src/services/database.ts > runMigrations`) tracks applied migrations by
-- FILENAME in `_migrations` (`filename TEXT NOT NULL UNIQUE`); it applies any
-- *.sql file whose filename is not already applied (there is no "above max
-- prefix" gate). The only hard rule is no duplicate numeric prefix
-- (`assertNoUnexpectedMigrationPrefixCollisions`). Current max prefix is 177
-- (Wave-2 rank 6 auto-revert counters); 178 is free and non-colliding.
--
-- CANARY-ONLY INERTNESS (load-bearing): NOTHING in off/shadow/on/absent writes
-- to this table. The only writer is `maybeRecordCanaryTurn()`, which is a strict
-- NO-OP unless `shouldServeCanaryForTenant(tenantId, env)` is true — i.e. ONLY
-- when CHAT_CORE_V2_ORCHESTRATOR_MODE === 'canary' AND the per-tenant master
-- kill-switch is not forcing this tenant off AND the tenant is in the canary
-- cohort allowlist. In off / shadow / on / absent (absent parses to 'off'), and
-- for any non-cohort or killed tenant, this table stays EMPTY by construction.
--
-- THIS IS NOT THE PROMOTION GATE: rows here are a coarse traffic-shape
-- measurement, NEVER a promotion-readiness signal. `gateCanPromote`
-- (gate-metrics-store.ts) remains the SOLE promotion authority and stays false
-- until a real (non-synthetic, peer-reviewed) corpus is persisted. Nothing in
-- this table or its writer reads, writes, or influences `gateCanPromote`.
--
-- PRIVACY (§1.3 / §5.J — mirrors migration 174's posture): every column here is
-- a SAFE SCALAR — internal `tenant_id` / `user_id` scoping identifiers, an opaque
-- `turn_id` correlation handle, a route path/method enum-like string, a fixed
-- reasoning-tier label, a numeric confidence in [0,1], a coarse locale bucket,
-- and timestamps. There is NO raw user message text, prompt text, answer text,
-- capability free-text, or other PII in ANY column. `route_path` is the matched
-- API route template (e.g. '/api/v1/...'), never a user-supplied string.
--
-- RETENTION: `expires_at` defaults to recorded_at + 90 days so a later retention
-- cron can prune aged canary rows (same posture as migration 172's expires_at).
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS make re-running a no-op,
-- and the store module ships a matching ensure*Table() helper for fresh
-- in-memory test DBs.

CREATE TABLE IF NOT EXISTS chat_v2_canary_turn_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,                              -- internal tenant id (scoping, not PII)
  user_id        TEXT NOT NULL,                              -- internal user id (scoping, not PII)
  turn_id        TEXT NOT NULL,                              -- opaque per-turn correlation handle (not message text)
  route_path     TEXT,                                       -- matched API route template (e.g. '/api/v1/...'), never user text
  route_method   TEXT,                                       -- HTTP method (GET/POST/...) — enum-like, no PII
  reasoning_tier TEXT,                                       -- fixed reasoning-tier label (no free text)
  confidence     REAL,                                       -- numeric confidence in [0,1] (no PII)
  locale         TEXT,                                       -- coarse locale bucket (en | pt-BR | pt-PT | mixed)
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL DEFAULT (datetime('now', '+90 days'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_canary_turn_log_tenant_recorded_at
  ON chat_v2_canary_turn_log(tenant_id, recorded_at);
