-- Harden hybrid chat action state lookup, expiry, and retention jobs.

CREATE INDEX IF NOT EXISTS idx_chat_pending_actions_expires_active
ON chat_pending_actions(expires_at)
WHERE status IN ('needs_input', 'needs_confirmation', 'executable');

CREATE INDEX IF NOT EXISTS idx_chat_action_runs_executing_updated
ON chat_action_runs(updated_at)
WHERE status = 'executing';

CREATE INDEX IF NOT EXISTS idx_chat_action_runs_completed_retention
ON chat_action_runs(completed_at)
WHERE status IN ('verified_success', 'verified_pending', 'partial_success', 'failed', 'blocked', 'cancelled');
