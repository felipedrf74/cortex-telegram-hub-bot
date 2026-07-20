#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  candidateMigrationIdentity,
  PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA,
  sha256Bytes,
} from './lib/production-shape-migration-rehearsal-evidence.mjs';
import {
  loadIrreversibleMigrationPolicy,
} from './lib/irreversible-migration-policy.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
};
const releaseDir = path.resolve(value('--release-dir'));
const productionBase = path.resolve(value('--production-base'));
const sourceDatabase = path.resolve(value('--source-database'));
const predecessorRuntimeSha = value('--predecessor-runtime-sha');
const targetRuntimeSha = value('--target-runtime-sha');
const targetVersion = value('--target-version');
const artifactDigest = value('--artifact-digest');
const reviewEvidenceSha256 = value('--review-evidence-sha256');
const migrationPolicySubjectSha256 = value('--migration-policy-subject-sha256');
const promotionRunId = value('--promotion-run-id');
const phase = value('--phase');
const databaseOwnerState = value('--database-owner-state');
const startedAt = new Date().toISOString();

const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9A-Za-z.+-]+$/;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/;
const requiredContentFiles = Array.from({ length: 15 }, (_, index) => 239 + index);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertRegularFile(file, code) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(code); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code);
}

function assertSafeDirectory(directory, code) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  if (fs.realpathSync(directory) !== directory) fail(code);
}

function assertPrivateDirectory(directory, code) {
  assertSafeDirectory(directory, code);
  if ((fs.lstatSync(directory).mode & 0o077) !== 0) fail(code);
}

function ensurePrivateDirectory(parent, name, code) {
  const directory = path.join(parent, name);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') fail(code);
  }
  assertPrivateDirectory(directory, code);
  return directory;
}

function digestFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function migrationEntries(root) {
  const dir = path.join(root, 'migrations');
  return fs.readdirSync(dir)
    .filter((file) => /^\d{3}_[^/]+\.sql$/.test(file))
    .sort()
    .map((file) => ({ file, sha256: sha256Bytes(fs.readFileSync(path.join(dir, file))) }));
}

function cleanupClone(cloneDir, clonePath) {
  let cleanupFailed = false;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = `${clonePath}${suffix}`;
    try { fs.chmodSync(file, 0o600); } catch { /* absent */ }
    try { fs.rmSync(file, { force: true }); } catch { cleanupFailed = true; }
  }
  // SQLite or a failed future validation step may introduce another private
  // sidecar. The directory was created by this process with mkdtemp and was
  // proven non-symlink, so remove any residual entry without following it.
  try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch { cleanupFailed = true; }
  return !cleanupFailed
    && ['', '-wal', '-shm', '-journal'].every((suffix) => !fs.existsSync(`${clonePath}${suffix}`))
    && !fs.existsSync(cloneDir);
}

async function run() {
  if (!RUNTIME_SHA.test(predecessorRuntimeSha) || !RUNTIME_SHA.test(targetRuntimeSha)) fail('runtime_identity_invalid');
  if (!VERSION.test(targetVersion)) fail('target_version_invalid');
  if (![artifactDigest, reviewEvidenceSha256, migrationPolicySubjectSha256].every((item) => SHA256.test(item))) fail('digest_identity_invalid');
  if (!RUN_ID.test(promotionRunId)) fail('promotion_run_id_invalid');
  if (!['online_pre_stop', 'stopped_final'].includes(phase)) fail('rehearsal_phase_invalid');
  if ((phase === 'online_pre_stop' && databaseOwnerState !== 'online')
    || (phase === 'stopped_final' && databaseOwnerState !== 'stopped')) fail('database_owner_state_invalid');
  assertSafeDirectory(productionBase, 'production_base_unsafe');
  if (!releaseDir.startsWith(`${productionBase}${path.sep}releases${path.sep}`)) fail('release_path_unsafe');
  assertSafeDirectory(path.join(productionBase, 'releases'), 'release_parent_unsafe');
  assertSafeDirectory(releaseDir, 'release_path_unsafe');
  const expectedSource = path.join(productionBase, 'data', 'bot.db');
  if (sourceDatabase !== expectedSource) fail('source_database_path_mismatch');
  assertSafeDirectory(path.join(productionBase, 'data'), 'source_database_parent_unsafe');
  assertRegularFile(sourceDatabase, 'source_database_not_regular');
  if (fs.realpathSync(sourceDatabase) !== sourceDatabase) fail('source_database_realpath_mismatch');
  assertRegularFile(path.join(releaseDir, '.complete.json'), 'release_marker_missing');
  assertRegularFile(path.join(releaseDir, 'artifact-manifest.json'), 'artifact_manifest_missing');
  const marker = JSON.parse(fs.readFileSync(path.join(releaseDir, '.complete.json'), 'utf8'));
  const packageVersion = JSON.parse(fs.readFileSync(path.join(releaseDir, 'package.json'), 'utf8')).version;
  if (marker.runtimeSha !== targetRuntimeSha || marker.artifactDigest !== artifactDigest) fail('release_marker_identity_mismatch');
  if (packageVersion !== targetVersion) fail('release_version_identity_mismatch');
  const policy = loadIrreversibleMigrationPolicy({ root: releaseDir });
  if (policy.integrityIssues.length !== 0
    || policy.reviewSubjectSha256 !== migrationPolicySubjectSha256) fail('migration_policy_identity_mismatch');

  const candidateEntries = migrationEntries(releaseDir);
  const candidateIdentity = candidateMigrationIdentity(releaseDir);
  if (candidateIdentity.requiredContentMigrationCount !== 15) fail('required_content_migration_inventory_invalid');
  const requiredFiles = candidateEntries.filter(({ file }) => {
    const prefix = Number(file.slice(0, 3));
    return prefix >= 239 && prefix <= 253;
  });
  if (!requiredContentFiles.every((prefix, index) => Number(requiredFiles[index]?.file.slice(0, 3)) === prefix)) {
    fail('required_content_migration_sequence_invalid');
  }

  const localRoot = ensurePrivateDirectory(productionBase, '.local', 'temporary_root_unsafe');
  const tempRoot = ensurePrivateDirectory(localRoot, 'release', 'temporary_root_unsafe');
  const cloneDir = fs.mkdtempSync(path.join(tempRoot, 'migration-rehearsal-'));
  fs.chmodSync(cloneDir, 0o700);
  const clonePath = path.join(cloneDir, 'production-shape.db');
  let cleanupVerified = false;
  let result;
  try {
    const sourceDatabaseSha256 = digestFile(sourceDatabase);
    const source = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
    let applied;
    try {
      source.pragma('query_only = ON');
      applied = source.prepare('SELECT filename FROM _migrations ORDER BY filename').all()
        .map((row) => String(row.filename));
      if (applied.some((file) => requiredFiles.some((entry) => entry.file === file))) {
        fail('source_already_contains_content_workspace_migrations');
      }
      const candidateNames = candidateEntries.map(({ file }) => file);
      if (applied.length > candidateNames.length
        || applied.some((file, index) => file !== candidateNames[index])) {
        fail('source_migration_ledger_not_candidate_prefix');
      }
      await source.backup(clonePath);
    } finally { source.close(); }
    fs.chmodSync(clonePath, 0o600);
    const sourceCloneSha256 = digestFile(clonePath);
    const appliedSet = new Set(applied);
    const pendingEntries = candidateEntries.filter(({ file }) => !appliedSet.has(file));
    if (!requiredFiles.every(({ file }) => pendingEntries.some((entry) => entry.file === file))) {
      fail('required_content_migrations_not_pending');
    }

    const requireFromRelease = createRequire(path.join(releaseDir, 'package.json'));
    const { applyPendingMigrations } = requireFromRelease('./dist/services/migration-runner.js');
    const { assertContentPipelineWorkspaceExitReady } = requireFromRelease('./dist/services/content-pipeline-workspace-exit.js');
    const { assertContentTopicWorkspaceCompatibilityReady } = requireFromRelease('./dist/services/content-topic-workspace-compat.js');
    const { assertContentEditorialWorkspaceExitReady } = requireFromRelease('./dist/services/content-editorial-workspace-exit.js');
    const { assertContentPerformanceWorkspaceLineageReady } = requireFromRelease('./dist/services/content-performance-lineage.js');
    const { assertContentWorkspaceIntegrityReady } = requireFromRelease('./dist/services/content-workspace-integrity-readiness.js');
    const { assertContentLegacyIdeaWorkspaceExitReady } = requireFromRelease('./dist/services/content-legacy-idea-workspace-exit.js');
    const clone = new Database(clonePath, { fileMustExist: true });
    try {
      clone.pragma('foreign_keys = ON');
      applyPendingMigrations(clone);
      const integrity = clone.pragma('integrity_check');
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') fail('sqlite_integrity_failed');
      if (clone.pragma('foreign_key_check').length !== 0) fail('sqlite_foreign_keys_failed');
      assertContentPipelineWorkspaceExitReady(clone);
      assertContentTopicWorkspaceCompatibilityReady(clone);
      assertContentEditorialWorkspaceExitReady(clone);
      assertContentPerformanceWorkspaceLineageReady(clone);
      assertContentWorkspaceIntegrityReady(clone);
      assertContentLegacyIdeaWorkspaceExitReady(clone);
      const finalApplied = clone.prepare('SELECT filename FROM _migrations ORDER BY filename').all()
        .map((row) => String(row.filename));
      if (JSON.stringify(finalApplied) !== JSON.stringify(candidateEntries.map(({ file }) => file))) {
        fail('candidate_migration_ledger_incomplete');
      }
      clone.pragma('wal_checkpoint(TRUNCATE)');
      clone.pragma('journal_mode = DELETE');
    } finally { clone.close(); }
    const migratedCloneSha256 = digestFile(clonePath);
    const sizeBytes = fs.statSync(clonePath).size;
    result = {
      schema: PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA,
      status: 'verified',
      startedAt,
      createdAt: new Date().toISOString(),
      promotionRunId,
      phase,
      predecessorRuntimeSha,
      targetRuntimeSha,
      targetVersion,
      artifactDigest,
      reviewEvidenceSha256,
      migrationPolicySubjectSha256,
      source: {
        databaseRelativePath: 'data/bot.db',
        databaseOwnerState,
        readOnlyConnection: true,
        onlineBackup: true,
        alreadyMigrated: false,
        appliedMigrationCount: applied.length,
        migrationSetSha256: sha256Bytes(Buffer.from(JSON.stringify(applied))),
        databaseSha256: sourceDatabaseSha256,
      },
      candidate: {
        migrationCount: candidateIdentity.migrationCount,
        migrationSetSha256: candidateIdentity.migrationSetSha256,
        pendingMigrationCount: pendingEntries.length,
        pendingMigrationSetSha256: sha256Bytes(Buffer.from(JSON.stringify(pendingEntries))),
        requiredContentMigrationCount: candidateIdentity.requiredContentMigrationCount,
        requiredContentMigrationSetSha256: candidateIdentity.requiredContentMigrationSetSha256,
        requiredContentMigrationsPending: true,
      },
      clone: { sourceSha256: sourceCloneSha256, migratedSha256: migratedCloneSha256, sizeBytes },
      checks: {
        sqliteIntegrity: 'ok',
        sqliteForeignKeys: 'ok',
        contentPipelineWorkspaceExit: 'ready',
        contentTopicWorkspaceExit: 'ready',
        contentEditorialWorkspaceExit: 'ready',
        contentPerformanceWorkspaceLineage: 'ready',
        contentWorkspaceIntegrity: 'ready',
        contentLegacyIdeaWorkspaceExit: 'ready',
        temporaryCloneCleanup: 'pending',
      },
    };
  } finally {
    cleanupVerified = cleanupClone(cloneDir, clonePath);
  }
  if (!cleanupVerified || !result) fail('temporary_clone_cleanup_failed');
  result.checks.temporaryCloneCleanup = 'verified';
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

run().catch((error) => {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code)
    ? error.code
    : 'migration_or_readiness_check_failed';
  process.stderr.write(`production_shape_migration_rehearsal_failed:${code}\n`);
  process.exitCode = 1;
});
