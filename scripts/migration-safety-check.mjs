#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  IRREVERSIBLE_MIGRATION_REVIEW_APPROVAL_SCHEMA,
  irreversibleMigrationReason,
  loadIrreversibleMigrationPolicy,
  sha256Text,
} from './lib/irreversible-migration-policy.mjs';
import {
  parseGitNameStatusZ,
  parseGitPathsZ,
} from './lib/git-changed-paths.mjs';
import {
  validateProductionShapeMigrationRehearsalEvidence,
} from './lib/production-shape-migration-rehearsal-evidence.mjs';
import {
  migrationSafetyGovernanceReasons,
} from './lib/migration-safety-policy-classifier.mjs';
import {
  MIGRATION_CD_ELIGIBILITY_SCHEMA,
  buildMigrationInventory,
  evaluateMigrationCdEligibility,
} from './lib/migration-cd-eligibility.mjs';
import {
  loadProductionMigrationLineagePolicy,
  verifyProductionMigrationLineageHistory,
} from './lib/production-migration-lineage.mjs';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasArg(name) {
  return args.includes(name);
}

const root = path.resolve(readArg('--root', process.cwd()));
let releaseMigrationLineagePolicy = null;
const baseRef = readArg('--base', '');
const explicitFiles = readArg('--files', '');
const changedOnly = hasArg('--changed-only');
const outputJson = hasArg('--json');
// The full ordered inventory is ~45 KiB for this repository, which pushes the
// default JSON payload past the 64 KiB pipe buffer that ordinary `execFileSync`
// consumers read through. Only the release manifest builder needs it, so it is
// opt-in rather than a cost every caller pays.
const emitInventory = hasArg('--emit-inventory');
const approvalMode = readArg('--approval-mode', changedOnly ? 'review' : 'none');
const reviewEvidenceInput = readArg(
  '--review-evidence',
  process.env.NEXUS_MIGRATION_REVIEW_EVIDENCE || '',
);
const backupEvidenceInput = readArg(
  '--backup-evidence',
  process.env.NEXUS_MIGRATION_BACKUP_EVIDENCE || '',
);
const rehearsalEvidenceInput = readArg(
  '--rehearsal-evidence',
  process.env.NEXUS_MIGRATION_REHEARSAL_EVIDENCE || '',
);
const finalRehearsalEvidenceInput = readArg(
  '--final-rehearsal-evidence',
  process.env.NEXUS_MIGRATION_FINAL_REHEARSAL_EVIDENCE || '',
);
const expectedTargetVersion = readArg('--target-version', '');
const expectedArtifactDigest = readArg('--artifact-digest', '');
const expectedPromotionRunId = readArg('--promotion-run-id', '');
if (!['none', 'scan', 'review', 'promotion'].includes(approvalMode)) {
  process.stderr.write(`Unsupported migration approval mode: ${approvalMode}\n`);
  process.exit(64);
}
const irreversiblePolicy = loadIrreversibleMigrationPolicy({ root });
const REVIEW_EVIDENCE_SCHEMA = IRREVERSIBLE_MIGRATION_REVIEW_APPROVAL_SCHEMA;
const BACKUP_EVIDENCE_SCHEMA = 'nexus.exact-migration-backup-evidence.v2';
const REVIEW_SUBJECT_SCHEMA = 'nexus.migration-review-subject.v1';
const MAX_BACKUP_EVIDENCE_AGE_MS = 15 * 60 * 1000;

const knownHistoricalGaps = new Set([
  142,
  143,
  162,
  163,
  164,
  165,
  166,
  167,
  168,
  169,
  170,
  171,
  175,
  176,
]);
const legacyDuplicatePrefixes = new Map([
  ['008', ['008_api_cache.sql', '008_email_log.sql']],
  ['009', ['009_api_usage_provider.sql', '009_job_history.sql']],
  ['022', ['022_finance_tables.sql', '022_webhook_events.sql']],
  ['023', ['023_fitness_training_plans.sql', '023_onboarding.sql']],
  ['024', ['024_cooking_tables.sql', '024_usage_metering.sql']],
]);

function git(commandArgs) {
  return execFileSync('git', commandArgs, { cwd: root, encoding: 'utf8' }).trim();
}

function gitRaw(commandArgs) {
  return execFileSync('git', commandArgs, { cwd: root, encoding: 'utf8' });
}

function tryResolveGitCommit(ref) {
  try {
    return execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return null;
  }
}

function activeMergeMainParent() {
  const mergeHead = tryResolveGitCommit('MERGE_HEAD');
  if (!mergeHead) return null;
  const head = tryResolveGitCommit('HEAD');
  const mergeParents = new Set([head, mergeHead].filter(Boolean));
  const matchingMainParents = new Set(
    ['origin/main', 'main']
      .map((ref) => tryResolveGitCommit(ref))
      .filter((commit) => commit && mergeParents.has(commit)),
  );
  return matchingMainParents.size === 1 ? [...matchingMainParents][0] : null;
}

function resolveBase() {
  if (baseRef) {
    return git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
  }
  for (const ref of ['origin/main', 'main', 'HEAD~1']) {
    try {
      return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Could not resolve a base ref for changed-migration policy');
}

let cachedComparisonBase;
function comparisonBaseIdentity() {
  if (!changedOnly) return null;
  if (cachedComparisonBase === undefined) {
    cachedComparisonBase = activeMergeMainParent() ?? resolveBase();
  }
  return cachedComparisonBase;
}

function migrationFiles() {
  const dir = path.join(root, 'migrations');
  return fs.readdirSync(dir)
    .filter((file) => /^\d{3}_.*\.sql$/.test(file))
    .sort();
}

function sameMembers(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function changedFiles() {
  if (explicitFiles) {
    return explicitFiles.split(',').map((file) => file.trim()).filter(Boolean);
  }
  const resolved = resolveBase();
  const mergeMainParent = activeMergeMainParent();
  // An in-progress feature/main merge must be evaluated as the resulting
  // index versus main. Unioning feature-vs-base with index-vs-feature would
  // misclassify branch-only migration rename sources as deployed deletes and
  // could miss an incoming-main migration dropped during conflict resolution.
  const committed = mergeMainParent
    ? []
    : parseGitNameStatusZ(gitRaw([
      'diff', '--name-status', '-z', `${resolved}...HEAD`,
    ]));
  const staged = parseGitNameStatusZ(gitRaw(mergeMainParent
    ? ['diff', '--cached', '--name-status', '-z', mergeMainParent]
    : ['diff', '--cached', '--name-status', '-z']));
  const unstaged = parseGitNameStatusZ(gitRaw([
    'diff', '--name-status', '-z',
  ]));
  const untracked = parseGitPathsZ(gitRaw([
    'ls-files', '--others', '--exclude-standard', '-z',
  ]));
  return [...new Set([
    ...committed,
    ...staged,
    ...unstaged,
    ...untracked,
  ])].sort();
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function evidencePath(input, directory) {
  if (!input) return null;
  const absolute = path.resolve(root, input);
  const allowedRoot = path.resolve(root, '.local', 'release', directory);
  if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}${path.sep}`)) {
    return null;
  }
  try {
    for (const governedDirectory of [
      path.resolve(root, '.local'),
      path.resolve(root, '.local', 'release'),
      allowedRoot,
    ]) {
      const directoryStat = fs.lstatSync(governedDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (directoryStat.mode & 0o022) !== 0
        || fs.realpathSync(governedDirectory) !== governedDirectory) return null;
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) return null;
    const realAllowedRoot = fs.realpathSync(allowedRoot);
    const realEvidence = fs.realpathSync(absolute);
    if (realEvidence !== realAllowedRoot
      && !realEvidence.startsWith(`${realAllowedRoot}${path.sep}`)) return null;
  } catch {
    return null;
  }
  return absolute;
}

function readJsonEvidence(input, directory) {
  const absolute = evidencePath(input, directory);
  if (!absolute) return { absolute: null, raw: null, parsed: null };
  try {
    const raw = fs.readFileSync(absolute);
    return { absolute, raw, parsed: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { absolute, raw: null, parsed: null };
  }
}

function reviewSubject(irreversible) {
  const value = {
    schema: REVIEW_SUBJECT_SCHEMA,
    policySubjectSha256: irreversiblePolicy.reviewSubjectSha256,
    irreversibleChanges: irreversible.map(({ file, reason }) => {
      const absolute = path.join(root, file);
      return {
        file,
        reason,
        sha256: fs.existsSync(absolute) ? sha256Text(fs.readFileSync(absolute)) : null,
      };
    }),
  };
  return Object.freeze({
    ...value,
    sha256: sha256Text(JSON.stringify(value)),
  });
}

function validateReviewEvidence(errors, irreversible) {
  const subject = reviewSubject(irreversible);
  const evidence = readJsonEvidence(reviewEvidenceInput, 'migration-review');
  const parsed = evidence.parsed;
  let reason = null;
  if (!evidence.absolute) reason = 'path_missing_or_outside_governed_directory';
  else if (!parsed) reason = 'invalid_json';
  else if (parsed.schema !== REVIEW_EVIDENCE_SCHEMA) reason = 'invalid_schema';
  else if (parsed.status !== 'approved') reason = 'status_not_approved';
  else if (typeof parsed.approvedBy !== 'string' || parsed.approvedBy.trim().length === 0) reason = 'approver_missing';
  else if (!isIsoTimestamp(parsed.approvedAt)) reason = 'approval_timestamp_invalid';
  else if (Date.parse(parsed.approvedAt) > Date.now() + 60_000) reason = 'approval_timestamp_in_future';
  else if (parsed.subjectSha256 !== subject.sha256) reason = 'review_subject_mismatch';
  if (reason) errors.push(`irreversible_migration_review_evidence_invalid:${reason}`);
  return {
    valid: reason === null,
    path: evidence.absolute ? path.relative(root, evidence.absolute) : null,
    sha256: evidence.raw ? sha256Text(evidence.raw) : null,
    approvedBy: reason === null ? parsed.approvedBy.trim() : null,
    approvedAt: reason === null ? parsed.approvedAt : null,
    subjectSha256: subject.sha256,
    policySubjectSha256: subject.policySubjectSha256,
  };
}

function parseBackupArchivePath(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^\/home\/dominguez\/backups\/nexushub\/v([0-9A-Za-z.+-]+)_before-v([0-9A-Za-z.+-]+)_[0-9]{8}_[0-9]{6}\.tar\.gz$/,
  );
  return match ? { archivedVersion: match[1], targetVersion: match[2] } : null;
}

function validateRehearsalEvidence(errors, reviewEvidence, {
  input,
  phase,
  databaseOwnerState,
  errorPrefix,
}) {
  const predecessorRuntimeSha = resolveBase();
  const targetRuntimeSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const result = validateProductionShapeMigrationRehearsalEvidence({
    root,
    input,
    expectedPredecessorRuntimeSha: predecessorRuntimeSha,
    expectedTargetRuntimeSha: targetRuntimeSha,
    expectedTargetVersion,
    expectedArtifactDigest,
    expectedReviewEvidenceSha256: reviewEvidence.sha256,
    expectedMigrationPolicySubjectSha256: reviewEvidence.policySubjectSha256,
    expectedPromotionRunId,
    expectedPhase: phase,
    expectedDatabaseOwnerState: databaseOwnerState,
  });
  if (!result.valid) {
    errors.push(`${errorPrefix}:${result.reason}`);
  }
  return {
    valid: result.valid,
    path: result.path,
    sha256: result.sha256,
    parsed: result.parsed,
    predecessorRuntimeSha,
    targetRuntimeSha,
  };
}

function validateBackupEvidence(errors, reviewEvidence, rehearsalEvidence, finalRehearsalEvidence) {
  const evidence = readJsonEvidence(backupEvidenceInput, 'production');
  const parsed = evidence.parsed;
  const predecessorRuntimeSha = resolveBase();
  const targetRuntimeSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const archiveIdentity = parseBackupArchivePath(parsed?.backup?.remotePath);
  let reason = null;
  if (!evidence.absolute) reason = 'path_missing_or_outside_governed_directory';
  else if (!parsed) reason = 'invalid_json';
  else if (parsed.schema !== BACKUP_EVIDENCE_SCHEMA) reason = 'invalid_schema';
  else if (parsed.status !== 'verified') reason = 'status_not_verified';
  else if (!isIsoTimestamp(parsed.createdAt)) reason = 'created_at_invalid';
  else if (Date.parse(parsed.createdAt) > Date.now() + 60_000) reason = 'created_at_in_future';
  else if (Date.now() - Date.parse(parsed.createdAt) > MAX_BACKUP_EVIDENCE_AGE_MS) reason = 'evidence_stale';
  else if (parsed.predecessorRuntimeSha !== predecessorRuntimeSha) reason = 'predecessor_runtime_mismatch';
  else if (parsed.targetRuntimeSha !== targetRuntimeSha) reason = 'target_runtime_mismatch';
  else if (!expectedTargetVersion || parsed.targetVersion !== expectedTargetVersion) reason = 'target_version_mismatch';
  else if (!/^[a-f0-9]{64}$/.test(expectedArtifactDigest)
    || parsed.artifactDigest !== expectedArtifactDigest) reason = 'artifact_digest_mismatch';
  else if (!expectedPromotionRunId || parsed.promotionRunId !== expectedPromotionRunId) reason = 'promotion_run_mismatch';
  else if (parsed.reviewEvidenceSha256 !== reviewEvidence.sha256) reason = 'review_evidence_mismatch';
  else if (parsed.migrationPolicySubjectSha256 !== reviewEvidence.policySubjectSha256) reason = 'migration_policy_subject_mismatch';
  else if (!rehearsalEvidence.valid) reason = 'production_shape_rehearsal_invalid';
  else if (!finalRehearsalEvidence.valid) reason = 'production_shape_final_rehearsal_invalid';
  else if (parsed.productionShapeRehearsals?.onlinePreStop?.evidenceSha256 !== rehearsalEvidence.sha256) reason = 'production_shape_rehearsal_evidence_mismatch';
  else if (parsed.productionShapeRehearsals?.onlinePreStop?.sourceCloneSha256
    !== rehearsalEvidence.parsed?.clone?.sourceSha256) reason = 'production_shape_source_clone_mismatch';
  else if (parsed.productionShapeRehearsals?.onlinePreStop?.migratedCloneSha256
    !== rehearsalEvidence.parsed?.clone?.migratedSha256) reason = 'production_shape_migrated_clone_mismatch';
  else if (parsed.productionShapeRehearsals?.onlinePreStop?.pendingMigrationSetSha256
    !== rehearsalEvidence.parsed?.candidate?.pendingMigrationSetSha256) reason = 'production_shape_pending_migration_set_mismatch';
  else if (parsed.productionShapeRehearsals?.onlinePreStop?.sourceDatabaseSha256
    !== rehearsalEvidence.parsed?.source?.databaseSha256) reason = 'production_shape_online_source_database_mismatch';
  else if (parsed.productionShapeRehearsals?.stoppedFinal?.evidenceSha256
    !== finalRehearsalEvidence.sha256) reason = 'production_shape_final_rehearsal_evidence_mismatch';
  else if (parsed.productionShapeRehearsals?.stoppedFinal?.sourceCloneSha256
    !== finalRehearsalEvidence.parsed?.clone?.sourceSha256) reason = 'production_shape_final_source_clone_mismatch';
  else if (parsed.productionShapeRehearsals?.stoppedFinal?.migratedCloneSha256
    !== finalRehearsalEvidence.parsed?.clone?.migratedSha256) reason = 'production_shape_final_migrated_clone_mismatch';
  else if (parsed.productionShapeRehearsals?.stoppedFinal?.pendingMigrationSetSha256
    !== finalRehearsalEvidence.parsed?.candidate?.pendingMigrationSetSha256) reason = 'production_shape_final_pending_migration_set_mismatch';
  else if (parsed.productionShapeRehearsals?.stoppedFinal?.sourceDatabaseSha256
    !== finalRehearsalEvidence.parsed?.source?.databaseSha256) reason = 'production_shape_final_source_database_mismatch';
  else if (parsed.backup?.databaseSha256
    !== finalRehearsalEvidence.parsed?.source?.databaseSha256) reason = 'backup_database_final_rehearsal_mismatch';
  else if (Date.parse(parsed.createdAt) < Date.parse(rehearsalEvidence.parsed?.createdAt || '')) reason = 'backup_predates_online_rehearsal';
  else if (Date.parse(finalRehearsalEvidence.parsed?.createdAt || '') < Date.parse(parsed.createdAt)) reason = 'final_rehearsal_predates_backup';
  else if (!archiveIdentity) reason = 'backup_path_invalid';
  else if (!/^[a-f0-9]{64}$/.test(parsed.backup?.sha256 || '')) reason = 'backup_digest_invalid';
  else if (!Number.isSafeInteger(parsed.backup?.sizeBytes) || parsed.backup.sizeBytes <= 0) reason = 'backup_size_invalid';
  else if (typeof parsed.backup?.archivedVersion !== 'string' || parsed.backup.archivedVersion.length === 0) reason = 'archived_version_missing';
  else if (archiveIdentity.archivedVersion !== parsed.backup.archivedVersion) reason = 'backup_archived_version_path_mismatch';
  else if (archiveIdentity.targetVersion !== expectedTargetVersion) reason = 'backup_target_version_path_mismatch';
  else if (parsed.backup?.targetVersion !== expectedTargetVersion) reason = 'backup_target_version_mismatch';
  else if (parsed.backup?.createdAt !== parsed.createdAt) reason = 'backup_timestamp_mismatch';
  else if (parsed.verification?.databaseOwnersStopped !== true) reason = 'database_owners_not_stopped';
  else if (parsed.verification?.noOpenDatabaseHandles !== true) reason = 'database_handles_not_proved_closed';
  else if (parsed.verification?.walCheckpointTruncated !== true) reason = 'wal_checkpoint_not_proved';
  else if (parsed.verification?.sqliteIntegrity !== 'ok') reason = 'sqlite_integrity_not_proved';
  else if (parsed.verification?.sqliteForeignKeys !== 'ok') reason = 'sqlite_foreign_keys_not_proved';
  else if (parsed.verification?.archiveSha256Verified !== true) reason = 'archive_digest_not_proved';
  if (reason) errors.push(`irreversible_migration_backup_evidence_invalid:${reason}`);
  return {
    valid: reason === null,
    path: evidence.absolute ? path.relative(root, evidence.absolute) : null,
    sha256: evidence.raw ? sha256Text(evidence.raw) : null,
    remotePath: reason === null ? parsed.backup.remotePath : null,
    predecessorRuntimeSha,
    targetRuntimeSha,
  };
}

function verifySequence(files, errors) {
  const prefixes = [...new Set(files.map((file) => Number(file.slice(0, 3))))].sort((a, b) => a - b);
  let expected = 1;
  for (const prefix of prefixes) {
    while (knownHistoricalGaps.has(expected) && expected < prefix) {
      expected += 1;
    }
    if (prefix !== expected) {
      errors.push(`migration_sequence_gap:expected_${String(expected).padStart(3, '0')}:got_${String(prefix).padStart(3, '0')}`);
      return;
    }
    expected += 1;
  }
}

function verifyDuplicates(files, errors) {
  const groups = new Map();
  for (const file of files) {
    const prefix = file.slice(0, 3);
    groups.set(prefix, [...(groups.get(prefix) || []), file]);
  }
  for (const [prefix, members] of groups.entries()) {
    if (members.length <= 1) continue;
    if (!sameMembers(members, legacyDuplicatePrefixes.get(prefix) || [])) {
      errors.push(`migration_duplicate_prefix:${prefix}:${members.sort().join(',')}`);
    }
  }
}

function runCumulativeRehearsal(files, errors) {
  const dbPath = path.join(os.tmpdir(), `nexus-migration-rehearsal-${process.pid}-${Date.now()}.db`);
  let db;
  try {
    db = new Database(dbPath);
    // Keep release rehearsal aligned with the production migration runner.
    // These deterministic helpers let data-copy migrations prove byte/hash
    // parity without weakening canonical revision hashes.
    db.function('nexus_sha256', { deterministic: true }, (value) => (
      createHash('sha256').update(String(value ?? '')).digest('hex')
    ));
    db.function('nexus_plain_text_revision_hash', { deterministic: true }, (value) => (
      createHash('sha256')
        .update(JSON.stringify({ format: 'plain_text', text: String(value ?? '') }))
        .digest('hex')
    ));
    for (const file of files) {
      const sqlPath = path.join(root, 'migrations', file);
      try {
        db.exec(fs.readFileSync(sqlPath, 'utf8'));
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error).trim().replace(/\s+/g, ' ');
        errors.push(`migration_rehearsal_failed:${file}:${detail || 'unknown_error'}`);
        return;
      }
    }
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }
}

function checkChangedIrreversible(errors) {
  if (!changedOnly) {
    return { irreversible: [], reviewEvidence: null, rehearsalEvidence: null, finalRehearsalEvidence: null, backupEvidence: null };
  }
  const changed = changedFiles()
    .filter((file) => /^migrations\/\d{3}_.*\.sql$/.test(file)
      || migrationSafetyGovernanceReasons.has(file));
  const irreversibleByFile = new Map();
  for (const issue of irreversiblePolicy.integrityIssues) {
    const identityReason = issue.type === 'missing'
      ? 'POLICY_IDENTITY_MISSING'
      : 'POLICY_DIGEST_DRIFT';
    irreversibleByFile.set(issue.file, { file: issue.file, reason: identityReason });
  }
  for (const file of changed) {
    const governanceReason = migrationSafetyGovernanceReasons.get(file);
    if (governanceReason) {
      irreversibleByFile.set(file, { file, reason: governanceReason });
      continue;
    }
    const migrationPath = path.join(root, file);
    const reason = fs.existsSync(migrationPath)
      ? irreversibleMigrationReason(file, fs.readFileSync(migrationPath, 'utf8'), irreversiblePolicy)
      : 'DELETED_OR_RENAMED';
    if (reason) {
      if (!irreversibleByFile.has(file)) {
        irreversibleByFile.set(file, { file, reason });
      }
    }
  }
  const irreversible = [...irreversibleByFile.values()]
    .sort((left, right) => left.file.localeCompare(right.file));
  if (irreversible.length === 0) {
    return { irreversible, reviewEvidence: null, rehearsalEvidence: null, finalRehearsalEvidence: null, backupEvidence: null };
  }

  const unregistered = irreversible.filter(({ file, reason }) => (
    /^migrations\/\d{3}_.*\.sql$/.test(file)
      && !reason.startsWith('POLICY:')
      && !reason.startsWith('POLICY_IDENTITY_')
      && reason !== 'POLICY_DIGEST_DRIFT'
  ));
  if (unregistered.length > 0) {
    errors.push(`irreversible_migration_unregistered:${unregistered.map(({ file, reason }) => `${file}:${reason}`).join('|')}`);
  }
  if (approvalMode === 'none') {
    errors.push('irreversible_migration_approval_mode_required');
    return { irreversible, reviewEvidence: null, rehearsalEvidence: null, finalRehearsalEvidence: null, backupEvidence: null };
  }
  if (approvalMode === 'scan') {
    return { irreversible, reviewEvidence: null, rehearsalEvidence: null, finalRehearsalEvidence: null, backupEvidence: null };
  }
  const reviewEvidence = validateReviewEvidence(errors, irreversible);
  const rehearsalEvidence = approvalMode === 'promotion'
    ? validateRehearsalEvidence(errors, reviewEvidence, {
      input: rehearsalEvidenceInput,
      phase: 'online_pre_stop',
      databaseOwnerState: 'online',
      errorPrefix: 'irreversible_migration_rehearsal_evidence_invalid',
    })
    : null;
  const finalRehearsalEvidence = approvalMode === 'promotion'
    ? validateRehearsalEvidence(errors, reviewEvidence, {
      input: finalRehearsalEvidenceInput,
      phase: 'stopped_final',
      databaseOwnerState: 'stopped',
      errorPrefix: 'irreversible_migration_final_rehearsal_evidence_invalid',
    })
    : null;
  const backupEvidence = approvalMode === 'promotion'
    ? validateBackupEvidence(errors, reviewEvidence, rehearsalEvidence, finalRehearsalEvidence)
    : null;
  return { irreversible, reviewEvidence, rehearsalEvidence, finalRehearsalEvidence, backupEvidence };
}

function verifyPolicyIdentity(errors) {
  for (const issue of irreversiblePolicy.integrityIssues) {
    errors.push(`irreversible_migration_policy_identity_invalid:${issue.file}:${issue.type}`);
  }
}

function changedMigrationSqlPaths() {
  return changedFiles()
    .filter((file) => /^migrations\/\d{3}_.*\.sql$/.test(file))
    .sort();
}

function migrationBytesAtCommit(commit, file) {
  try {
    return execFileSync('git', ['show', `${commit}:${file}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The migration ledger records filenames, not byte digests. Once a migration
 * exists in the comparison base, changing its bytes would let a durable staging
 * database skip the new SQL while production (where it is still pending) applies
 * it. Renames and deletions have the same history-rewrite problem.
 *
 * New files remain editable until they land. During an in-progress feature/main
 * merge, compare with the main parent just as changedFiles() does, so a
 * branch-only migration can still be renamed before it first reaches main.
 */
function verifyMigrationHistoryAppendOnly(errors) {
  if (!changedOnly) return;
  const comparisonBase = comparisonBaseIdentity();
  for (const file of changedMigrationSqlPaths()) {
    const baseBytes = migrationBytesAtCommit(comparisonBase, file);
    if (baseBytes === null) continue;

    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
      errors.push(`migration_history_not_append_only:${file}:deleted_or_renamed`);
      continue;
    }
    const currentBytes = fs.readFileSync(absolute);
    if (!baseBytes.equals(currentBytes)) {
      errors.push(`migration_history_not_append_only:${file}:modified`);
    }
  }
}

/**
 * Continuous-deployment eligibility, evaluated independently of
 * `authorization.authorizesPromotion`.
 *
 * `authorizesPromotion` answers "has an owner approved this specific
 * irreversible operation?". This answers a different question: "can an
 * unattended pipeline apply these migrations and still roll back to the
 * predecessor image?". Deriving one from the other would let an owner-approved
 * destructive migration ride an unattended deploy, or block every ordinary
 * additive release for want of an approval it does not need.
 */
function evaluateCdEligibility(errors, irreversible) {
  if (!changedOnly) {
    // Without a change scope there is no delta to classify, and guessing would
    // authorize an unattended deploy over unknown schema work.
    return {
      schema: MIGRATION_CD_ELIGIBILITY_SCHEMA,
      eligible: false,
      predecessorCompatible: false,
      reasons: ['change_scope_not_evaluated'],
      files: [],
    };
  }
  const blockingErrors = [...errors];
  const changedMigrations = [];
  for (const file of changedMigrationSqlPaths()) {
    const migrationPath = path.join(root, file);
    if (!fs.existsSync(migrationPath)) {
      blockingErrors.push(`migration_deleted_or_renamed:${file}`);
      continue;
    }
    changedMigrations.push({ file, sql: fs.readFileSync(migrationPath, 'utf8') });
  }
  return evaluateMigrationCdEligibility({
    changedMigrations,
    blockingErrors,
    irreversibleFindings: irreversible,
    compatibilityExemptions:
      releaseMigrationLineagePolicy?.release.compatibilityExemptions ?? [],
  });
}

const errors = [];
try {
  releaseMigrationLineagePolicy = loadProductionMigrationLineagePolicy({ root });
  verifyProductionMigrationLineageHistory({
    policy: releaseMigrationLineagePolicy,
    readHistoricalMigration: ({ commit, file }) => execFileSync(
      'git',
      ['show', `${commit}:migrations/${file}`],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    ),
    readReplacementMigration: ({ file }) => fs.readFileSync(
      path.join(root, 'migrations', file),
    ),
  });
} catch (error) {
  errors.push(
    `release_migration_reconciliation_policy_invalid:`
    + `${error instanceof Error ? error.message : String(error)}`,
  );
}
const files = migrationFiles();
verifyMigrationHistoryAppendOnly(errors);
verifyPolicyIdentity(errors);
verifySequence(files, errors);
verifyDuplicates(files, errors);
runCumulativeRehearsal(files, errors);
const {
  irreversible,
  reviewEvidence,
  rehearsalEvidence,
  finalRehearsalEvidence,
  backupEvidence,
} = checkChangedIrreversible(errors);
const governanceChanges = irreversible.filter(({ file }) => (
  migrationSafetyGovernanceReasons.has(file)
));
const irreversibleSchemaMigrations = irreversible.filter(({ file }) => (
  !migrationSafetyGovernanceReasons.has(file)
));
const cdEligibility = evaluateCdEligibility(errors, irreversible);
// The complete ordered inventory, independent of the change delta. The delta
// says what this release *changed*; the inventory says what the migrator can
// actually apply, and only the latter can be reconciled against the ledger.
const migrationInventory = emitInventory
  ? buildMigrationInventory({
    readDir: (dir) => fs.readdirSync(path.join(root, dir)),
    readFile: (file) => fs.readFileSync(path.join(root, file)),
    compatibilityExemptions:
      releaseMigrationLineagePolicy?.release.compatibilityExemptions ?? [],
  })
  : null;

const payload = {
  ok: errors.length === 0,
  generatedAt: new Date().toISOString(),
  // Release publication independently recomputes this exact changed-scope
  // verdict on a GitHub-hosted runner. Binding the resolved commit here lets
  // that trusted boundary reject a self-hosted artifact that silently changed
  // the comparison base (especially for a multi-commit push).
  comparisonBase: comparisonBaseIdentity(),
  migrationCount: files.length,
  checks: {
    migrationHistoryAppendOnly: !errors.some((error) => (
      error.startsWith('migration_history_not_append_only:')
    )),
    sequence: !errors.some((error) => error.startsWith('migration_sequence_gap')),
    duplicates: !errors.some((error) => error.startsWith('migration_duplicate_prefix')),
    cumulativeRehearsal: !errors.some((error) => error.startsWith('migration_rehearsal_failed')),
    policyIdentity: !errors.some((error) => error.startsWith('irreversible_migration_policy_identity_invalid')),
    changedIrreversiblePolicy: !errors.some((error) => error.startsWith('irreversible_migration_')),
    reviewApproval: approvalMode === 'scan' || irreversible.length === 0
      ? null
      : !errors.some((error) => error.startsWith('irreversible_migration_review_evidence_invalid')),
    productionShapeRehearsal: approvalMode !== 'promotion' || irreversible.length === 0
      ? null
      : !errors.some((error) => error.startsWith('irreversible_migration_rehearsal_evidence_invalid')),
    finalProductionShapeRehearsal: approvalMode !== 'promotion' || irreversible.length === 0
      ? null
      : !errors.some((error) => error.startsWith('irreversible_migration_final_rehearsal_evidence_invalid')),
    exactBackupEvidence: approvalMode !== 'promotion' || irreversible.length === 0
      ? null
      : !errors.some((error) => error.startsWith('irreversible_migration_backup_evidence_invalid')),
  },
  changedOnly,
  approvalMode,
  irreversibleChangedMigrations: irreversible,
  governanceChanges,
  irreversibleSchemaMigrations,
  policyIdentityIssues: irreversiblePolicy.integrityIssues,
  requiredReviewSubject: irreversible.length > 0 ? reviewSubject(irreversible) : null,
  authorization: {
    approvalRequired: irreversibleSchemaMigrations.length > 0,
    governanceReviewRequired: governanceChanges.length > 0,
    backupRequired: irreversibleSchemaMigrations.length > 0,
    authorizesPromotion: irreversibleSchemaMigrations.length > 0
      && approvalMode === 'promotion'
      && errors.length === 0,
  },
  cdEligibility,
  migrationInventory,
  migrationReconciliation: releaseMigrationLineagePolicy?.releaseReconciliation ?? null,
  reviewEvidence,
  rehearsalEvidence,
  finalRehearsalEvidence,
  backupEvidence,
  errors,
};

if (outputJson) {
  // Pretty-printing the complete inventory exceeds a 64 KiB synchronous-child
  // pipe even though the governed data fits. Keep the evidence compact when the
  // inventory is requested so a successful child cannot return truncated JSON.
  if (!process.stdout.write(`${JSON.stringify(payload, null, emitInventory ? 0 : 2)}\n`)) {
    await once(process.stdout, 'drain');
  }
} else if (payload.ok) {
  process.stdout.write(`✅ Migration safety checks passed (${files.length} migrations)\n`);
  if (changedOnly) {
    process.stdout.write(cdEligibility.eligible
      ? '   Continuous deployment eligible: expand/backfill only, predecessor-compatible\n'
      : `   Continuous deployment blocked: ${cdEligibility.reasons.join(', ')}\n`);
  }
  if (irreversible.length > 0) {
    if (approvalMode === 'scan') {
      process.stdout.write(`   Approval required for review subject ${payload.requiredReviewSubject.sha256}\n`);
    } else {
      process.stdout.write(`   Irreversible migration review approved by ${payload.reviewEvidence.approvedBy}\n`);
    }
    if (approvalMode === 'promotion') {
      process.stdout.write(`   Exact migration backup verified: ${payload.backupEvidence.remotePath}\n`);
    }
  }
} else {
  for (const error of errors) {
    process.stderr.write(`❌ ${error}\n`);
  }
}

process.exit(payload.ok ? 0 : 1);
