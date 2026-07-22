// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadProductionMigrationLineagePolicy,
  resolveProductionMigrationLineage,
} from './production-migration-lineage.mjs';

export const PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA =
  'nexus.production-shape-migration-rehearsal.v2';
export const MAX_PRODUCTION_SHAPE_REHEARSAL_AGE_MS = 30 * 60 * 1000;

const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9A-Za-z.+-]+$/;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/;

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function candidateMigrationIdentity(rootInput) {
  const root = path.resolve(rootInput);
  const migrationsDir = path.join(root, 'migrations');
  const entries = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d{3}_[^/]+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      file,
      sha256: sha256Bytes(fs.readFileSync(path.join(migrationsDir, file))),
    }));
  const requiredContent = entries.filter(({ file }) => {
    const prefix = Number(file.slice(0, 3));
    return prefix >= 239 && prefix <= 253;
  });
  return Object.freeze({
    migrationCount: entries.length,
    migrationSetSha256: sha256Bytes(Buffer.from(JSON.stringify(entries))),
    requiredContentMigrationCount: requiredContent.length,
    requiredContentMigrationSetSha256: sha256Bytes(
      Buffer.from(JSON.stringify(requiredContent)),
    ),
  });
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function governedEvidence(input, rootInput) {
  if (!input) return { absolute: null, raw: null, parsed: null, reason: 'path_missing' };
  const root = path.resolve(rootInput);
  const allowedRoot = path.join(root, '.local', 'release', 'production');
  const absolute = path.resolve(root, input);
  if (absolute === allowedRoot || !absolute.startsWith(`${allowedRoot}${path.sep}`)) {
    return { absolute: null, raw: null, parsed: null, reason: 'path_outside_governed_directory' };
  }
  try {
    const stat = fs.lstatSync(absolute);
    for (const directory of [
      path.join(root, '.local'),
      path.join(root, '.local', 'release'),
      allowedRoot,
    ]) {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (directoryStat.mode & 0o022) !== 0
        || fs.realpathSync(directory) !== directory) {
        return { absolute: null, raw: null, parsed: null, reason: 'governed_directory_unsafe' };
      }
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { absolute: null, raw: null, parsed: null, reason: 'evidence_not_regular_file' };
    }
    if ((stat.mode & 0o777) !== 0o600) {
      return { absolute, raw: null, parsed: null, reason: 'evidence_permissions_unsafe' };
    }
    const realAllowed = fs.realpathSync(allowedRoot);
    const realEvidence = fs.realpathSync(absolute);
    if (!realEvidence.startsWith(`${realAllowed}${path.sep}`)) {
      return { absolute: null, raw: null, parsed: null, reason: 'evidence_path_escape' };
    }
    const raw = fs.readFileSync(absolute);
    return { absolute, raw, parsed: JSON.parse(raw.toString('utf8')), reason: null };
  } catch {
    return { absolute: null, raw: null, parsed: null, reason: 'evidence_unreadable' };
  }
}

export function validateProductionShapeMigrationRehearsalEvidence({
  root,
  input,
  expectedPredecessorRuntimeSha,
  expectedTargetRuntimeSha,
  expectedTargetVersion,
  expectedArtifactDigest,
  expectedReviewEvidenceSha256,
  expectedMigrationPolicySubjectSha256,
  expectedPromotionRunId,
  expectedPhase,
  expectedDatabaseOwnerState,
  now = Date.now(),
}) {
  const evidence = governedEvidence(input, root);
  const parsed = evidence.parsed;
  const candidate = candidateMigrationIdentity(root);
  let lineagePolicy = null;
  try { lineagePolicy = loadProductionMigrationLineagePolicy({ root }); } catch { /* invalid below */ }
  const expectedLineage = lineagePolicy && parsed?.source?.migrationLineageId
    ? (parsed.source.migrationLineageId === 'canonical'
      ? resolveProductionMigrationLineage(lineagePolicy, [])
      : lineagePolicy.lineages.find(({ id }) => id === parsed.source.migrationLineageId) ?? null)
    : null;
  let reason = evidence.reason;
  if (!reason && !parsed) reason = 'invalid_json';
  else if (!reason && !lineagePolicy) reason = 'retired_migration_policy_invalid';
  else if (!reason && parsed.schema !== PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA) reason = 'invalid_schema';
  else if (!reason && parsed.status !== 'verified') reason = 'status_not_verified';
  else if (!reason && !isIsoTimestamp(parsed.startedAt)) reason = 'started_at_invalid';
  else if (!reason && !isIsoTimestamp(parsed.createdAt)) reason = 'created_at_invalid';
  else if (!reason && Date.parse(parsed.createdAt) < Date.parse(parsed.startedAt)) reason = 'timestamp_order_invalid';
  else if (!reason && Date.parse(parsed.createdAt) > now + 60_000) reason = 'created_at_in_future';
  else if (!reason && now - Date.parse(parsed.createdAt) > MAX_PRODUCTION_SHAPE_REHEARSAL_AGE_MS) reason = 'evidence_stale';
  else if (!reason && now - Date.parse(parsed.startedAt) > MAX_PRODUCTION_SHAPE_REHEARSAL_AGE_MS) reason = 'started_at_stale';
  else if (!reason && (!RUNTIME_SHA.test(parsed.predecessorRuntimeSha || '')
    || parsed.predecessorRuntimeSha !== expectedPredecessorRuntimeSha)) reason = 'predecessor_runtime_mismatch';
  else if (!reason && (!RUNTIME_SHA.test(parsed.targetRuntimeSha || '')
    || parsed.targetRuntimeSha !== expectedTargetRuntimeSha)) reason = 'target_runtime_mismatch';
  else if (!reason && (!VERSION.test(parsed.targetVersion || '')
    || parsed.targetVersion !== expectedTargetVersion)) reason = 'target_version_mismatch';
  else if (!reason && (!SHA256.test(parsed.artifactDigest || '')
    || parsed.artifactDigest !== expectedArtifactDigest)) reason = 'artifact_digest_mismatch';
  else if (!reason && (!SHA256.test(parsed.reviewEvidenceSha256 || '')
    || parsed.reviewEvidenceSha256 !== expectedReviewEvidenceSha256)) reason = 'review_evidence_mismatch';
  else if (!reason && (!SHA256.test(parsed.migrationPolicySubjectSha256 || '')
    || parsed.migrationPolicySubjectSha256 !== expectedMigrationPolicySubjectSha256)) reason = 'migration_policy_subject_mismatch';
  else if (!reason && (!RUN_ID.test(parsed.promotionRunId || '')
    || parsed.promotionRunId !== expectedPromotionRunId)) reason = 'promotion_run_mismatch';
  else if (!reason && parsed.phase !== expectedPhase) reason = 'rehearsal_phase_mismatch';
  else if (!reason && parsed.source?.databaseOwnerState !== expectedDatabaseOwnerState) reason = 'database_owner_state_mismatch';
  else if (!reason && parsed.source?.databaseRelativePath !== 'data/bot.db') reason = 'source_database_identity_invalid';
  else if (!reason && parsed.source?.readOnlyConnection !== true) reason = 'source_not_read_only';
  else if (!reason && parsed.source?.onlineBackup !== true) reason = 'online_backup_not_proved';
  else if (!reason && parsed.source?.alreadyMigrated !== false) reason = 'source_already_migrated';
  else if (!reason && (!Number.isSafeInteger(parsed.source?.appliedMigrationCount)
    || parsed.source.appliedMigrationCount < 0)) reason = 'source_migration_count_invalid';
  else if (!reason && !SHA256.test(parsed.source?.migrationSetSha256 || '')) reason = 'source_migration_set_invalid';
  else if (!reason && !SHA256.test(parsed.source?.databaseSha256 || '')) reason = 'source_database_digest_invalid';
  else if (!reason && parsed.source?.retiredMigrationPolicySha256 !== lineagePolicy.sha256) reason = 'retired_migration_policy_mismatch';
  else if (!reason && !expectedLineage) reason = 'source_migration_lineage_invalid';
  else if (!reason && parsed.source?.retiredMigrationCount !== expectedLineage.migrationCount) reason = 'retired_migration_count_mismatch';
  else if (!reason && parsed.source?.retiredMigrationSetSha256 !== expectedLineage.migrationSetSha256) reason = 'retired_migration_set_mismatch';
  else if (!reason && parsed.candidate?.migrationCount !== candidate.migrationCount) reason = 'candidate_migration_count_mismatch';
  else if (!reason && parsed.candidate?.migrationSetSha256 !== candidate.migrationSetSha256) reason = 'candidate_migration_set_mismatch';
  else if (!reason && (parsed.candidate?.requiredContentMigrationCount !== 15
    || candidate.requiredContentMigrationCount !== 15)) reason = 'required_content_migration_count_mismatch';
  else if (!reason && parsed.candidate?.requiredContentMigrationSetSha256
    !== candidate.requiredContentMigrationSetSha256) reason = 'required_content_migration_set_mismatch';
  else if (!reason && (!Number.isSafeInteger(parsed.candidate?.pendingMigrationCount)
    || parsed.candidate?.pendingMigrationCount <= 0)) reason = 'pending_migration_count_invalid';
  else if (!reason && !SHA256.test(parsed.candidate?.pendingMigrationSetSha256 || '')) reason = 'pending_migration_set_invalid';
  else if (!reason && parsed.candidate?.requiredContentMigrationsPending !== true) reason = 'required_content_migrations_not_pending';
  else if (!reason && !SHA256.test(parsed.clone?.sourceSha256 || '')) reason = 'source_clone_digest_invalid';
  else if (!reason && !SHA256.test(parsed.clone?.migratedSha256 || '')) reason = 'migrated_clone_digest_invalid';
  else if (!reason && (!Number.isSafeInteger(parsed.clone?.sizeBytes)
    || parsed.clone?.sizeBytes <= 0)) reason = 'clone_size_invalid';
  else if (!reason && parsed.checks?.sqliteIntegrity !== 'ok') reason = 'sqlite_integrity_not_proved';
  else if (!reason && parsed.checks?.sqliteForeignKeys !== 'ok') reason = 'sqlite_foreign_keys_not_proved';
  else if (!reason && parsed.checks?.contentPipelineWorkspaceExit !== 'ready') reason = 'content_pipeline_readiness_not_proved';
  else if (!reason && parsed.checks?.contentTopicWorkspaceExit !== 'ready') reason = 'content_topic_readiness_not_proved';
  else if (!reason && parsed.checks?.contentEditorialWorkspaceExit !== 'ready') reason = 'content_editorial_readiness_not_proved';
  else if (!reason && parsed.checks?.contentPerformanceWorkspaceLineage !== 'ready') reason = 'content_performance_readiness_not_proved';
  else if (!reason && parsed.checks?.contentWorkspaceIntegrity !== 'ready') reason = 'content_integrity_readiness_not_proved';
  else if (!reason && parsed.checks?.contentLegacyIdeaWorkspaceExit !== 'ready') reason = 'content_legacy_idea_readiness_not_proved';
  else if (!reason && parsed.checks?.temporaryCloneCleanup !== 'verified') reason = 'clone_cleanup_not_proved';

  return Object.freeze({
    valid: reason === null,
    reason,
    path: evidence.absolute ? path.relative(path.resolve(root), evidence.absolute) : null,
    sha256: evidence.raw ? sha256Bytes(evidence.raw) : null,
    parsed: reason === null ? parsed : null,
  });
}
