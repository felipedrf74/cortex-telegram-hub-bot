-- Chat Core v2 command event timeline.
-- Stores redacted lifecycle events only; raw command payloads remain in the
-- short-retention replay bundle when explicitly captured.

CREATE TABLE IF NOT EXISTS chat_v2_command_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_event_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('secretary', 'tasks', 'training', 'content', 'cooking', 'finance', 'connections', 'notifications', 'decision_center')),
  command_type TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'command_proposed', 'preview_rendered', 'confirmation_requested', 'confirmation_received',
    'queued', 'execution_started', 'retrying', 'execution_completed',
    'verification_started', 'verification_completed', 'verification_failed',
    'command_partially_failed', 'command_failed', 'timed_out', 'stale_rejected',
    'command_expired', 'command_cancelled', 'command_undone', 'undo_failed',
    'command_rejected', 'approval_denied', 'human_review_requested'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'previewed', 'confirmation_required', 'confirmed', 'queued',
    'executing', 'retrying', 'executed', 'verification_pending', 'verified',
    'verification_failed', 'partially_failed', 'failed', 'timed_out', 'stale',
    'expired', 'cancelled', 'undone', 'undo_failed', 'rejected_by_policy',
    'approval_denied', 'awaiting_human_review'
  )),
  origin TEXT NOT NULL CHECK (origin IN ('chat', 'decision_center', 'notification', 'automation', 'manual_user')),
  capability_id TEXT,
  idempotency_key TEXT,
  reason TEXT,
  redacted_summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_turn
  ON chat_v2_command_events(turn_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_command
  ON chat_v2_command_events(command_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_scope
  ON chat_v2_command_events(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_status
  ON chat_v2_command_events(status, created_at DESC);
