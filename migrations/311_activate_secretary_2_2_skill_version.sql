-- Migration 311: Publish Secretary 2.2 capability metadata
--
-- The capability manifest and runtime package ship Secretary 2.2.0. Keep the
-- public skill-version registry on that same release without deleting prior
-- release history or changing tenant/user/canary rollouts.

CREATE TABLE IF NOT EXISTS secretary_skill_version_release_journal (
  release_version TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('version', 'global_rollout')),
  entity_id INTEGER NOT NULL,
  prior_status TEXT NOT NULL,
  prior_rollout_scope TEXT,
  prior_activated_at TEXT,
  prior_deprecated_at TEXT,
  PRIMARY KEY (release_version, entity_kind, entity_id)
);

-- Rehearsal rollback must restore the exact predecessor state even if an
-- operator registered a 2.2 candidate before this migration arrived.
INSERT OR IGNORE INTO secretary_skill_version_release_journal (
  release_version,
  entity_kind,
  entity_id,
  prior_status,
  prior_rollout_scope,
  prior_activated_at,
  prior_deprecated_at
)
SELECT
  '2.2.0',
  'version',
  id,
  status,
  rollout_scope,
  activated_at,
  deprecated_at
FROM skill_versions
WHERE skill_id = 'secretary';

INSERT OR IGNORE INTO secretary_skill_version_release_journal (
  release_version,
  entity_kind,
  entity_id,
  prior_status,
  prior_rollout_scope,
  prior_activated_at,
  prior_deprecated_at
)
SELECT
  '2.2.0',
  'global_rollout',
  rollout.id,
  rollout.status,
  rollout.scope_type,
  rollout.activated_at,
  rollout.deprecated_at
FROM skill_version_rollouts rollout
JOIN skill_versions version ON version.id = rollout.skill_version_id
WHERE version.skill_id = 'secretary'
  AND rollout.scope_type = 'global';

INSERT OR IGNORE INTO skill_versions (
  skill_id,
  skill_name,
  version,
  release_type,
  release_title,
  release_summary,
  capabilities_added_json,
  logic_improvements_json,
  bug_fixes_json,
  security_fixes_json,
  tenant_scope_changes_json,
  memory_context_changes_json,
  model_routing_changes_json,
  data_schema_changes_json,
  ios_portal_contract_changes_json,
  tests_added_json,
  smoke_tests_passed_json,
  evaluation_results_json,
  open_risks_json,
  known_limitations_json,
  rollback_notes,
  internal_notes,
  created_by,
  activated_at,
  status,
  rollout_scope,
  compatible_api_version,
  memory_schema_version,
  quality_gate_status
) VALUES (
  'secretary',
  'Secretary',
  '2.2.0',
  'minor',
  'Secretary deterministic planning and orchestration hardening',
  'Unifies scoped Today and Week planning, honest source health, routine settings, calendar command idempotency, scheduled-report delivery, and provider-neutral routing metadata.',
  '["canonical Today and Week planning snapshot","source health and warning contracts","versioned Secretary routine profile","idempotent calendar command service","Decision Center conflict review","leased scheduled reports and exact notification intent delivery"]',
  '["one timezone and language aware planning context per request","Today derives from the composed Week result","local agenda items participate before and after provider synchronization","parent Secretary gating owns every child job and callback"]',
  '["unknown calendar health no longer becomes an all-clear result","calendar command replay requires exact provider identity","transient APNs failures retain retry priority","cached iOS plans remain visibly stale or degraded"]',
  '["tenant and authenticated user scope must match before I/O","provider writes stop when conflict-source health is unknown","routine and calendar receipts use scoped compare-and-swap identities","Fossa owner metadata and process-global notification facts are retired"]',
  '["Secretary planning, routine, command, report, and cache identities are user and tenant scoped","existing tenant, user, and canary skill-version rollouts remain unchanged"]',
  '["Secretary memory and knowledge instructions remain tenant-neutral","no private routine or calendar payload is added to release metadata"]',
  '["provider routing abstractions remain authoritative","SECRETARY_PRIMARY_ROUTE_ENABLED replaces the provider-named route flag with one-release legacy read compatibility"]',
  '["migrations/307_secretary_routine_profiles.sql","migrations/308_secretary_calendar_command_receipts.sql","migrations/309_secretary_calendar_mutation_receipts.sql","migrations/310_retire_fossa_email_metadata.sql","migrations/311_activate_secretary_2_2_skill_version.sql"]',
  '["Today and Week add optional timezone, warning, and source-health fields","routine settings add a versioned GET and full-replacement PUT contract","calendar creation persists an Idempotency-Key across ambiguous retries"]',
  '["Secretary planning, routine, calendar, scheduler, notification, manifest, migration, and iOS compatibility suites"]',
  '[]',
  '{"mode":"release","production_data_used":false,"release_gate":"PENDING_PROTECTED_MAIN"}',
  '["physical-device and next-due report-cycle evidence remain release-time gates"]',
  '["external testers, App Review, public release, and commerce activation are outside this release"]',
  'Revert the protected-main release and restore secretary@2.0.0 as the global rollout; retain scoped rollout and release history.',
  'Release metadata only; contains no calendar contents, routine values, provider responses, identifiers, or secrets.',
  'migration_311',
  datetime('now'),
  'active',
  'global',
  'api-v1',
  'secretary-memory-v1',
  'pass'
);

-- If an earlier candidate row already exists, the deployed 2.2 runtime makes
-- it the active global release while preserving its authored metadata.
UPDATE skill_versions
SET status = 'active',
    rollout_scope = 'global',
    activated_at = COALESCE(activated_at, datetime('now')),
    deprecated_at = NULL
WHERE skill_id = 'secretary'
  AND version = '2.2.0';

-- Preserve an older version's active record when a non-global rollout still
-- relies on it. Only its global rollout is superseded below.
UPDATE skill_versions
SET status = 'deprecated',
    deprecated_at = COALESCE(deprecated_at, datetime('now'))
WHERE skill_id = 'secretary'
  AND version <> '2.2.0'
  AND status = 'active'
  AND rollout_scope = 'global'
  AND NOT EXISTS (
    SELECT 1
    FROM skill_version_rollouts scoped
    WHERE scoped.skill_version_id = skill_versions.id
      AND scoped.scope_type <> 'global'
      AND scoped.status = 'active'
  );

UPDATE skill_version_rollouts
SET status = 'deprecated',
    deprecated_at = COALESCE(deprecated_at, datetime('now'))
WHERE scope_type = 'global'
  AND status = 'active'
  AND skill_version_id IN (
    SELECT id
    FROM skill_versions
    WHERE skill_id = 'secretary'
      AND version <> '2.2.0'
  );

INSERT INTO skill_version_rollouts (
  skill_version_id,
  scope_type,
  status,
  created_by,
  activated_at,
  rollout_notes
)
SELECT
  id,
  'global',
  'active',
  'migration_311',
  COALESCE(activated_at, datetime('now')),
  'Secretary 2.2 runtime and capability-manifest global release parity.'
FROM skill_versions version
WHERE version.skill_id = 'secretary'
  AND version.version = '2.2.0'
  AND NOT EXISTS (
    SELECT 1
    FROM skill_version_rollouts rollout
    WHERE rollout.skill_version_id = version.id
      AND rollout.scope_type = 'global'
      AND rollout.status = 'active'
  );
