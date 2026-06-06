-- Store a stable replay-safe hash for shadow hybrid planner predictions so
-- canary analysis can join predicted actions back to live outcomes without
-- persisting raw user content.

ALTER TABLE chat_action_telemetry
ADD COLUMN predicted_action_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_action_telemetry_predicted_hash
ON chat_action_telemetry(user_id, tenant_id, predicted_action_hash)
WHERE predicted_action_hash IS NOT NULL;
