-- Training tenant scope hardening.
--
-- Training plans/sessions were user-owned only. Backfill tenant_id=user_id so
-- future shared workspaces can scope plan/session reads and calendar-event
-- reconciliation by both user and tenant.

ALTER TABLE fitness_training_plans ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE fitness_training_plans SET tenant_id = user_id WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_training_plans_tenant_user_status
  ON fitness_training_plans(tenant_id, user_id, status);

ALTER TABLE training_sessions ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE training_sessions
   SET tenant_id = (
     SELECT COALESCE(NULLIF(ftp.tenant_id, 0), ftp.user_id)
       FROM fitness_training_plans ftp
      WHERE ftp.id = training_sessions.plan_id
   )
 WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_training_sessions_tenant_plan_status
  ON training_sessions(tenant_id, plan_id, status);
CREATE INDEX IF NOT EXISTS idx_training_sessions_tenant_calendar
  ON training_sessions(tenant_id, calendar_event_id, calendar_source);
