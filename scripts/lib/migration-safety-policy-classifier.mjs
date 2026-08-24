// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Paths whose modification changes the migration-safety authorization
 * boundary even when no migrations/*.sql file changed.
 *
 * Keep this dependency-free so policy classification can be verified in
 * process. The CLI still performs the cumulative SQLite rehearsal once; unit
 * cases for this exact mapping must not replay the complete migration history.
 */
export const migrationSafetyGovernanceReasons = new Map([
  ['config/irreversible-migrations.json', 'POLICY_REGISTRY_CHANGED'],
  ['config/production-migration-lineages.json', 'POLICY_PRODUCTION_LINEAGE_CHANGED'],
  ['.github/workflows/ci.yml', 'POLICY_CI_ENTRYPOINT_CHANGED'],
  ['.github/workflows/release.yml', 'POLICY_RELEASE_PUBLISH_ENTRYPOINT_CHANGED'],
  [
    '.github/workflows/release-manifest-schema-activate.yml',
    'POLICY_RELEASE_MANIFEST_SCHEMA_ACTIVATION_CHANGED',
  ],
  [
    '.github/workflows/release-candidate-evidence.yml',
    'POLICY_RELEASE_CHECKPOINT_ENTRYPOINT_CHANGED',
  ],
  ['.husky/pre-commit', 'POLICY_HOOK_ENTRYPOINT_CHANGED'],
  ['scripts/lib/irreversible-migration-policy.mjs', 'POLICY_ENFORCEMENT_CHANGED'],
  ['scripts/lib/production-migration-lineage.mjs', 'POLICY_PRODUCTION_LINEAGE_ENFORCEMENT_CHANGED'],
  ['scripts/lib/git-changed-paths.mjs', 'POLICY_CHANGE_DISCOVERY_CHANGED'],
  ['scripts/lib/migration-cd-eligibility.mjs', 'POLICY_CD_ELIGIBILITY_CHANGED'],
  ['scripts/migration-safety-check.mjs', 'POLICY_GATE_CHANGED'],
  ['scripts/release-manifest-build.mjs', 'POLICY_RELEASE_MANIFEST_SIGNER_CHANGED'],
  ['scripts/release-manifest-schema-guard.mjs', 'POLICY_RELEASE_MANIFEST_SCHEMA_GUARD_CHANGED'],
  [
    'scripts/release-manifest-pointer-guard.mjs',
    'POLICY_RELEASE_MANIFEST_POINTER_GUARD_CHANGED',
  ],
  ['scripts/lib/release-manifest.mjs', 'POLICY_RELEASE_MANIFEST_VALIDATION_CHANGED'],
  [
    'scripts/lib/release-manifest-schema-policy.mjs',
    'POLICY_RELEASE_MANIFEST_SCHEMA_ENFORCEMENT_CHANGED',
  ],
  [
    'ops/nexus-release/release-manifest-schema-policy.json',
    'POLICY_RELEASE_MANIFEST_SCHEMA_POLICY_CHANGED',
  ],
  ['scripts/lib/release-database.mjs', 'POLICY_RELEASE_MIGRATION_LEDGER_CHANGED'],
  ['scripts/lib/release-deployment.mjs', 'POLICY_RELEASE_MIGRATION_ADMISSION_CHANGED'],
  ['scripts/lib/release-state-store.mjs', 'POLICY_RELEASE_MIGRATION_ADMISSION_CHANGED'],
  ['scripts/lib/release-deploy-arguments.mjs', 'POLICY_RELEASE_MIGRATION_ADMISSION_ENTRYPOINT_CHANGED'],
  ['scripts/release-deploy.mjs', 'POLICY_RELEASE_MIGRATION_ADMISSION_ENTRYPOINT_CHANGED'],
  ['scripts/release-poll.sh', 'POLICY_RELEASE_MIGRATION_ADMISSION_ENTRYPOINT_CHANGED'],
  ['scripts/lib/release-registry.mjs', 'POLICY_RELEASE_MIGRATION_ORCHESTRATION_CHANGED'],
  ['src/services/migration-runner.ts', 'POLICY_RUNTIME_MIGRATION_RUNNER_CHANGED'],
  ['src/services/database-bootstrap.ts', 'POLICY_APPLICATION_MIGRATION_ADMISSION_CHANGED'],
  ['src/services/database.ts', 'POLICY_APPLICATION_MIGRATION_ADMISSION_CHANGED'],
  ['src/services/release-data-maintenance.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/ios-auth-session.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/user-service.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/oauth-store.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/oauth-token-cache-events.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/oauth-connection-health.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/cache-coherence-registry.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/finance-tracker.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/services/garmin-session-store.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/utils/encryption.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/skills/skill-manager.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/skills/skill-config.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/skills/registry.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/generated/capability-skill-metadata.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['config/capability-manifest.json', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['scripts/generate-capability-skill-metadata.mjs', 'POLICY_RELEASE_DATA_MAINTENANCE_CHANGED'],
  ['src/config.ts', 'POLICY_RELEASE_DATA_MAINTENANCE_CONFIGURATION_CHANGED'],
  ['src/tools/run-release-migrations.ts', 'POLICY_RELEASE_MIGRATOR_CHANGED'],
  ['Dockerfile.release.node', 'POLICY_RELEASE_MIGRATION_PACKAGING_CHANGED'],
  ['docker-compose.release.yml', 'POLICY_RELEASE_MIGRATION_ORCHESTRATION_CHANGED'],
  ['scripts/lib/migration-safety-policy-classifier.mjs', 'POLICY_CLASSIFIER_CHANGED'],
  ['scripts/changed-area-classifier.mjs', 'POLICY_CLASSIFIER_ENTRYPOINT_CHANGED'],
  ['scripts/lib/changed-area-classifier.mjs', 'POLICY_CLASSIFIER_CHANGED'],
  ['scripts/risk-gate.sh', 'POLICY_RELEASE_ENTRYPOINT_CHANGED'],
  ['scripts/promote-exact-release.sh', 'POLICY_PROMOTION_ENTRYPOINT_CHANGED'],
  ['scripts/remote-production-shape-migration-rehearsal.sh', 'POLICY_REHEARSAL_ENTRYPOINT_CHANGED'],
  ['scripts/production-shape-migration-rehearsal.mjs', 'POLICY_REHEARSAL_CHANGED'],
  ['scripts/validate-production-shape-migration-rehearsal.mjs', 'POLICY_REHEARSAL_EVIDENCE_CHANGED'],
  ['scripts/lib/production-shape-migration-rehearsal-evidence.mjs', 'POLICY_REHEARSAL_EVIDENCE_CHANGED'],
]);

export const PRODUCTION_MIGRATION_ARCHIVE_PREFIX =
  'docs/release/evidence/retired-migrations/';

export function isProductionMigrationArchivePath(file) {
  return typeof file === 'string'
    && file.startsWith(PRODUCTION_MIGRATION_ARCHIVE_PREFIX);
}

export function migrationSafetyGovernanceReason(file) {
  if (isProductionMigrationArchivePath(file)) {
    return 'POLICY_PRODUCTION_LINEAGE_ARCHIVE_CHANGED';
  }
  return migrationSafetyGovernanceReasons.get(file) ?? null;
}
