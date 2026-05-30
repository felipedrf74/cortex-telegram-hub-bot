-- Wave-2 rank 5 (2026-05-30): Chat Core v2 prepass recall-miss log.
--
-- Persists ONE row per detected Layer-1 prepass recall-miss — a turn where the
-- deterministic prepass candidate set did NOT contain the capability the route
-- decision ultimately selected. The row is the durable, queryable signal behind
-- the per-language recall arm of the auto-revert policy (today still dormant /
-- OD-3 open) and the recall@8 promotion evidence.
--
-- MIGRATION NUMBER = 175. The migration RUNNER
-- (`src/services/database.ts > runMigrations`) tracks applied migrations by
-- FILENAME in `_migrations` (`filename TEXT NOT NULL UNIQUE`); it applies any
-- *.sql file whose filename is not already applied (there is no "above max
-- prefix" gate). The only hard rule is no duplicate numeric prefix
-- (`assertNoUnexpectedMigrationPrefixCollisions`). 174 and 176 are taken
-- (WP-13 gate metrics + WP-19 gate eval runs); 175 is free and non-colliding.
--
-- OFF-MODE INERTNESS (load-bearing): nothing in the OFF-mode live route writes
-- to this table. The ONLY writers run under an ACTIVE orchestration mode
-- (shadow / canary / on) via `recordPrepassRecallFailure()` /
-- `maybeEmitPrepassRecallMiss()` in `prepass-miss-store.ts`. When
-- CHAT_CORE_V2_ORCHESTRATOR_MODE is off/absent the emission is a no-op and this
-- table stays empty.
--
-- PRIVACY (§1.3 / §5.J — mirrors migration 174's posture): the only content
-- column is `message_hash`, a one-way HMAC-SHA256 digest of the user message
-- (salted per tenant+user). There is NO raw user message text, prompt text, or
-- other free-text PII in ANY column here. `tenant_id` / `user_id` / `turn_id`
-- are the same internal scoping identifiers `chat_v2_trace_spans` already
-- stores (migration 161); the capability-id / reason-code / locale columns are
-- bounded machine enums and JSON arrays of capability ids — never message text.
--
-- RETENTION: `expires_at` defaults to recorded_at + 30 days so a future
-- retention cron can age miss rows out by policy (mirrors the
-- `chat_v2_trace_spans.expires_at` retention pattern). Idempotent: CREATE TABLE
-- IF NOT EXISTS + CREATE INDEX IF NOT EXISTS make re-running a no-op, and the
-- store module ships a matching `ensureChatCoreV2PrepassMissLogTable()` for
-- fresh in-memory test DBs.

CREATE TABLE IF NOT EXISTS chat_v2_prepass_miss_log (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id                   TEXT NOT NULL,                 -- internal turn id (scoping, not PII)
  tenant_id                 TEXT NOT NULL,                 -- internal tenant id (scoping, not PII)
  user_id                   TEXT NOT NULL,                 -- internal user id (scoping, not PII)
  message_hash              TEXT NOT NULL,                 -- HMAC-SHA256 digest, NEVER the message text
  expected_capability_ids   TEXT NOT NULL DEFAULT '[]',    -- JSON array of capability ids (the recall target)
  candidate_capability_ids  TEXT NOT NULL DEFAULT '[]',    -- JSON array of prepass candidate ids
  locale                    TEXT NOT NULL DEFAULT 'unknown',
  reason_codes              TEXT NOT NULL DEFAULT '[]',    -- JSON array of machine reason codes
  schema_version            TEXT NOT NULL,
  recorded_at               TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at                TEXT NOT NULL DEFAULT (datetime('now', '+30 days'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_prepass_miss_log_tenant_recorded
  ON chat_v2_prepass_miss_log(tenant_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_chat_v2_prepass_miss_log_retention
  ON chat_v2_prepass_miss_log(expires_at);
