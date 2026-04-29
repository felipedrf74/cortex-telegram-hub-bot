-- Chat message lifecycle and idempotency foundation.
--
-- Additive-only: older code can ignore these columns. The route layer uses
-- them to prevent duplicate message/action rows on retry, mark interrupted
-- or failed states explicitly, and repair messages stuck in streaming/sent.

ALTER TABLE messages ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE messages ADD COLUMN client_message_id TEXT;
ALTER TABLE messages ADD COLUMN request_id TEXT;
ALTER TABLE messages ADD COLUMN retry_of_message_uuid TEXT;
ALTER TABLE messages ADD COLUMN completed_at TEXT;
ALTER TABLE messages ADD COLUMN failed_at TEXT;
ALTER TABLE messages ADD COLUMN canceled_at TEXT;
ALTER TABLE messages ADD COLUMN error_code TEXT;
ALTER TABLE messages ADD COLUMN error_message TEXT;

UPDATE messages
SET completed_at = COALESCE(completed_at, created_at)
WHERE lifecycle_state = 'completed';

CREATE INDEX IF NOT EXISTS idx_messages_lifecycle_scope
  ON messages(tenant_id, user_id, lifecycle_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_client_id_scope
  ON messages(tenant_id, user_id, client_message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_request_scope
  ON messages(tenant_id, user_id, request_id, created_at DESC);

ALTER TABLE conversations ADD COLUMN conversation_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN deleted_at TEXT;
ALTER TABLE conversations ADD COLUMN errored_at TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_lifecycle_scope
  ON conversations(tenant_id, user_id, domain, conversation_state, created_at DESC);
