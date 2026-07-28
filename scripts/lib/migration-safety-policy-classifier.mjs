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
  ['.husky/pre-commit', 'POLICY_HOOK_ENTRYPOINT_CHANGED'],
  ['scripts/lib/irreversible-migration-policy.mjs', 'POLICY_ENFORCEMENT_CHANGED'],
  ['scripts/lib/production-migration-lineage.mjs', 'POLICY_PRODUCTION_LINEAGE_ENFORCEMENT_CHANGED'],
  ['scripts/lib/git-changed-paths.mjs', 'POLICY_CHANGE_DISCOVERY_CHANGED'],
  ['scripts/migration-safety-check.mjs', 'POLICY_GATE_CHANGED'],
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

export function migrationSafetyGovernanceReason(file) {
  return migrationSafetyGovernanceReasons.get(file) ?? null;
}
