-- Secretary release hardening: move hot-path schema fixes into migrations.

ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT;

ALTER TABLE reminders ADD COLUMN tenant_id INTEGER;
ALTER TABLE reminders ADD COLUMN timezone TEXT;

UPDATE reminders
   SET tenant_id = user_id
 WHERE tenant_id IS NULL;

UPDATE reminders
   SET timezone = COALESCE(
     (SELECT users.timezone FROM users WHERE users.id = reminders.user_id),
     (SELECT users.timezone FROM users WHERE users.telegram_id = reminders.user_id),
     'Europe/Lisbon'
   )
 WHERE timezone IS NULL OR timezone = '';

CREATE INDEX IF NOT EXISTS idx_reminders_tenant_user_status
  ON reminders(tenant_id, user_id, status, remind_at);

CREATE INDEX IF NOT EXISTS idx_reminders_due_tenant
  ON reminders(status, remind_at, tenant_id, user_id);
