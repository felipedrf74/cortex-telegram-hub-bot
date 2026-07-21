-- 256: Durable chat conversation continuity (Chat M13).
--
-- chat_conversation_state persists the per-user active-domain pin that
-- previously lived only in an in-process Map inside
-- src/api/routes/chat-message-context.ts, so chat continuity survives
-- process restarts. Exactly one row per (tenant_id, user_id) — the runtime
-- upserts on every remembered turn and reads through a private Map cache.
--
-- Semantics live in code, not the schema:
--   * last_domain honors the existing 5-minute read-time TTL
--     (CHAT_ACTIVE_DOMAIN_TTL_MS) against last_domain_at;
--   * anchor_entities_json is a JSON array of { entityId, referencedAt }
--     with a 30-minute read-time decay — no cron prunes this table;
--   * last_assistant_message_id references messages.message_uuid for
--     post-restart recovery of the last assistant reply (soft reference,
--     no FK: messages history may be cleared independently).
--
-- tenant_id follows the repo convention (INTEGER, tenant fallback = user id
-- for single-tenant scopes), matching messages/conversations.

CREATE TABLE IF NOT EXISTS chat_conversation_state (
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  conversation_id TEXT,
  last_domain TEXT,
  last_domain_at TEXT,
  last_assistant_message_id TEXT,
  anchor_entities_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);
