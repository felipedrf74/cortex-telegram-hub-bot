-- Link reminders to Secretary agenda items so lifecycle transitions can
-- update/cancel the right reminder without title/date matching.

ALTER TABLE reminders ADD COLUMN agenda_item_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_agenda_item
  ON reminders(user_id, agenda_item_id, remind_at)
  WHERE agenda_item_id IS NOT NULL;
