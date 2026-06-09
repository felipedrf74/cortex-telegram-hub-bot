-- Phase 1C/tenant hardening: athlete readiness and health signals are
-- health-adjacent and must be scoped by tenant for every production read/write.

ALTER TABLE athlete_readiness_events ADD COLUMN tenant_id INTEGER;

UPDATE athlete_readiness_events
SET tenant_id = user_id
WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_athlete_readiness_events_tenant_user_date
  ON athlete_readiness_events(tenant_id, user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_athlete_readiness_events_tenant_user_date_source
  ON athlete_readiness_events(tenant_id, user_id, date, source);

ALTER TABLE athlete_health_signals ADD COLUMN tenant_id INTEGER;

UPDATE athlete_health_signals
SET tenant_id = user_id
WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_athlete_health_signals_tenant_user_date
  ON athlete_health_signals(tenant_id, user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_athlete_health_signals_tenant_user_pain
  ON athlete_health_signals(tenant_id, user_id, date DESC)
  WHERE pain_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_athlete_health_signals_tenant_user_illness
  ON athlete_health_signals(tenant_id, user_id, date DESC)
  WHERE illness_symptoms_json IS NOT NULL;
