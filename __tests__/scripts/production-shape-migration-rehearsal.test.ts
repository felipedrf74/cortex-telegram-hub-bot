import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  candidateMigrationIdentity,
  PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA,
  validateProductionShapeMigrationRehearsalEvidence,
} from '../../scripts/lib/production-shape-migration-rehearsal-evidence.mjs';
import { loadIrreversibleMigrationPolicy } from '../../scripts/lib/irreversible-migration-policy.mjs';
import { applyPendingMigrations } from '../../src/services/migration-runner';

const ROOT = resolve(process.cwd());
const REHEARSAL = join(ROOT, 'scripts/production-shape-migration-rehearsal.mjs');
const PREDECESSOR_SHA = '1'.repeat(40);
const TARGET_SHA = '2'.repeat(40);
const ARTIFACT_DIGEST = '3'.repeat(64);
const REVIEW_DIGEST = '4'.repeat(64);
const RUN_ID = '20260718T230000Z-4242-abcdef123456';
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

describe('production-shape migration rehearsal', () => {
  let base: string;
  let release: string;
  let policyDigest: string;

  beforeAll(() => {
    const builtMigrationRunner = join(ROOT, 'dist/services/migration-runner.js');
    const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    expect(existsSync(builtMigrationRunner)).toBe(true);
    mkdirSync(join(ROOT, '.local'), { recursive: true, mode: 0o700 });
    base = mkdtempSync(join(ROOT, '.local', 'production-shape-rehearsal-test-'));
    release = join(base, 'releases', 'candidate');
    mkdirSync(join(base, 'data'), { recursive: true, mode: 0o700 });
    mkdirSync(release, { recursive: true, mode: 0o700 });
    cpSync(join(ROOT, 'dist'), join(release, 'dist'), { recursive: true });
    cpSync(join(ROOT, 'migrations'), join(release, 'migrations'), { recursive: true });
    cpSync(join(ROOT, 'config'), join(release, 'config'), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(release, 'package.json'));
    writeFileSync(join(release, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1', runtimeSha: TARGET_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    })}\n`, { mode: 0o600 });
    writeFileSync(join(release, 'artifact-manifest.json'), '{}\n', { mode: 0o600 });
    policyDigest = loadIrreversibleMigrationPolicy({ root: release }).reviewSubjectSha256;
  }, 120_000);

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  function createSource({ fullyMigrated = false, invalidPipeline = false, seedPipeline = true } = {}) {
    const source = join(base, 'data', 'bot.db');
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${source}${suffix}`, { force: true });
    const db = new Database(source);
    db.pragma('journal_mode = WAL');
    applyPendingMigrations(db, fullyMigrated ? {} : { stopBefore: '239_content_agency_package_integrity.sql' });
    if (!fullyMigrated && seedPipeline) {
      db.prepare(`
        INSERT INTO content_pipeline (
          topic_title, niche, stage, stage_history, user_id, tenant_id,
          owner_user_id, visibility_scope, scope_status, created_by, updated_by
        ) VALUES (?, 'fixture', 'idea', '[]', 501, 501, 501,
                  'user_private', 'active', 501, 501)
      `).run(invalidPipeline ? '   ' : 'Production-shape fixture');
    }
    return { db, source };
  }

  function invoke(source: string, overrides: string[] = []) {
    const invocation = [
      REHEARSAL,
      '--release-dir', release,
      '--production-base', base,
      '--source-database', source,
      '--predecessor-runtime-sha', PREDECESSOR_SHA,
      '--target-runtime-sha', TARGET_SHA,
      '--target-version', VERSION,
      '--artifact-digest', ARTIFACT_DIGEST,
      '--review-evidence-sha256', REVIEW_DIGEST,
      '--migration-policy-subject-sha256', policyDigest,
      '--promotion-run-id', RUN_ID,
      '--phase', 'online_pre_stop',
      '--database-owner-state', 'online',
    ];
    for (let index = 0; index < overrides.length; index += 2) {
      const argumentIndex = invocation.indexOf(overrides[index]);
      if (argumentIndex === -1 || index + 1 >= overrides.length) {
        throw new Error(`invalid rehearsal test override: ${overrides[index]}`);
      }
      invocation[argumentIndex + 1] = overrides[index + 1];
    }
    return spawnSync(process.execPath, invocation, {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' },
    });
  }

  function expectNoClone(): void {
    const temporary = join(base, '.local', 'release');
    const remaining = existsSync(temporary)
      ? readdirSync(temporary).filter((entry) => entry.startsWith('migration-rehearsal-'))
      : [];
    expect(remaining).toEqual([]);
  }

  it('migrates an online backup with the canonical runner and emits aggregate-only evidence after cleanup', { timeout: 60_000 }, () => {
    const { db, source } = createSource({ seedPipeline: false });
    try {
      const result = invoke(source);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence).toMatchObject({
        schema: PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA,
        status: 'verified',
        source: {
          databaseRelativePath: 'data/bot.db', databaseOwnerState: 'online',
          readOnlyConnection: true, onlineBackup: true, alreadyMigrated: false,
        },
        candidate: { requiredContentMigrationCount: 15, requiredContentMigrationsPending: true },
        checks: {
          sqliteIntegrity: 'ok', sqliteForeignKeys: 'ok',
          contentPipelineWorkspaceExit: 'ready', contentTopicWorkspaceExit: 'ready',
          contentEditorialWorkspaceExit: 'ready', contentPerformanceWorkspaceLineage: 'ready',
          contentWorkspaceIntegrity: 'ready', contentLegacyIdeaWorkspaceExit: 'ready',
          temporaryCloneCleanup: 'verified',
        },
      });
      expect(evidence.clone.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.clone.migratedSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(source)).toBeDefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM _migrations WHERE filename LIKE '24%'").get())
        .toEqual({ count: 0 });
    } finally { db.close(); }
    expectNoClone();
  });

  it('fails closed on production rows that cannot satisfy Content readiness and still removes the clone', { timeout: 60_000 }, () => {
    const { db, source } = createSource({ invalidPipeline: true });
    try {
      const result = invoke(source);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('production_shape_migration_rehearsal_failed:migration_or_readiness_check_failed');
      expect(result.stderr).not.toContain('fixture');
    } finally { db.close(); }
    expectNoClone();
  });

  it('governs rollback-journal and residual-sidecar cleanup inside only the private clone directory', () => {
    const source = readFileSync(REHEARSAL, 'utf8');
    const cleanup = source.slice(source.indexOf('function cleanupClone'), source.indexOf('async function run'));
    expect(cleanup).toContain("'-journal'");
    expect(cleanup).toContain('fs.rmSync(cloneDir, { recursive: true, force: true })');
    expect(cleanup).toContain('!fs.existsSync(cloneDir)');
  });

  it('pins the remote production, release, and predecessor directories to canonical non-symlink paths', () => {
    const wrapper = readFileSync(
      join(ROOT, 'scripts/remote-production-shape-migration-rehearsal.sh'),
      'utf8',
    );
    expect(wrapper).toContain('"$PRODUCTION_BASE" "$PRODUCTION_BASE/releases" "$RELEASE_DIR" "$CURRENT_RUNTIME"');
    expect(wrapper).toContain('readlink -f "$governed_directory"');
  });

  it('rejects an already-migrated source before claiming rehearsal', { timeout: 60_000 }, () => {
    const { db, source } = createSource({ fullyMigrated: true });
    try {
      const result = invoke(source);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('source_already_contains_content_workspace_migrations');
    } finally { db.close(); }
    expectNoClone();
  });

  it('rejects a source ledger that is a candidate subset but not its exact applied prefix', { timeout: 60_000 }, () => {
    const { db, source } = createSource();
    try {
      db.prepare("DELETE FROM _migrations WHERE filename = '200_content_radar_phase0_rollout_guards.sql'").run();
      const result = invoke(source);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('source_migration_ledger_not_candidate_prefix');
    } finally { db.close(); }
    expectNoClone();
  });

  it('rejects a wrong source path before creating a clone', () => {
    const wrong = join(base, 'wrong.db');
    writeFileSync(wrong, 'not a database', { mode: 0o600 });
    const result = invoke(wrong);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source_database_path_mismatch');
    expectNoClone();
  });

  it('rejects wrong candidate runtime, version, artifact, and policy identities before cloning', () => {
    const { db, source } = createSource({ seedPipeline: false });
    try {
      for (const [argument, wrongValue, expected] of [
        ['--target-runtime-sha', '0'.repeat(40), 'release_marker_identity_mismatch'],
        ['--target-version', '0.0.0-test', 'release_version_identity_mismatch'],
        ['--artifact-digest', '0'.repeat(64), 'release_marker_identity_mismatch'],
        ['--migration-policy-subject-sha256', '0'.repeat(64), 'migration_policy_identity_mismatch'],
      ]) {
        const result = invoke(source, [argument, wrongValue]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
        expectNoClone();
      }
    } finally { db.close(); }
  });

  it('rejects symlinked source and temporary-directory ancestors', () => {
    const realData = join(base, 'real-data');
    const linkedBase = join(base, 'linked-base');
    const linkedRelease = join(linkedBase, 'releases', 'candidate');
    mkdirSync(realData, { recursive: true });
    mkdirSync(join(linkedBase, 'releases'), { recursive: true });
    cpSync(release, linkedRelease, { recursive: true });
    writeFileSync(join(realData, 'bot.db'), '', { mode: 0o600 });
    symlinkSync(realData, join(linkedBase, 'data'));
    const result = spawnSync(process.execPath, [
      REHEARSAL, '--release-dir', linkedRelease, '--production-base', linkedBase,
      '--source-database', join(linkedBase, 'data', 'bot.db'),
      '--predecessor-runtime-sha', PREDECESSOR_SHA, '--target-runtime-sha', TARGET_SHA,
      '--target-version', VERSION, '--artifact-digest', ARTIFACT_DIGEST,
      '--review-evidence-sha256', REVIEW_DIGEST,
      '--migration-policy-subject-sha256', policyDigest,
      '--promotion-run-id', RUN_ID, '--phase', 'online_pre_stop',
      '--database-owner-state', 'online',
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source_database_parent_unsafe');
    expect(existsSync(join(linkedBase, '.local'))).toBe(false);
    rmSync(join(linkedBase, 'data'), { force: true });
  });
});

describe('production-shape rehearsal evidence validation', () => {
  const productionDir = join(ROOT, '.local', 'release', 'production');
  const target = '5'.repeat(40);
  const predecessor = '6'.repeat(40);
  const artifact = '7'.repeat(64);
  const review = '8'.repeat(64);
  const policy = '9'.repeat(64);
  const runId = '20260718T231000Z-5252-fedcba654321';
  const candidate = candidateMigrationIdentity(ROOT);

  function validEvidence(createdAt = new Date().toISOString()) {
    return {
      schema: PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA,
      status: 'verified', startedAt: createdAt, createdAt, promotionRunId: runId,
      phase: 'online_pre_stop',
      predecessorRuntimeSha: predecessor, targetRuntimeSha: target,
      targetVersion: VERSION, artifactDigest: artifact,
      reviewEvidenceSha256: review, migrationPolicySubjectSha256: policy,
      source: {
        databaseRelativePath: 'data/bot.db', databaseOwnerState: 'online',
        readOnlyConnection: true, onlineBackup: true, alreadyMigrated: false,
        appliedMigrationCount: 233, migrationSetSha256: 'a'.repeat(64),
        databaseSha256: 'e'.repeat(64),
      },
      candidate: {
        migrationCount: candidate.migrationCount,
        migrationSetSha256: candidate.migrationSetSha256,
        pendingMigrationCount: 18, pendingMigrationSetSha256: 'b'.repeat(64),
        requiredContentMigrationCount: 15,
        requiredContentMigrationSetSha256: candidate.requiredContentMigrationSetSha256,
        requiredContentMigrationsPending: true,
      },
      clone: { sourceSha256: 'c'.repeat(64), migratedSha256: 'd'.repeat(64), sizeBytes: 4096 },
      checks: {
        sqliteIntegrity: 'ok', sqliteForeignKeys: 'ok',
        contentPipelineWorkspaceExit: 'ready', contentTopicWorkspaceExit: 'ready',
        contentEditorialWorkspaceExit: 'ready', contentPerformanceWorkspaceLineage: 'ready',
        contentWorkspaceIntegrity: 'ready', contentLegacyIdeaWorkspaceExit: 'ready',
        temporaryCloneCleanup: 'verified',
      },
    };
  }

  function validate(file: string, now = Date.now()) {
    return validateProductionShapeMigrationRehearsalEvidence({
      root: ROOT, input: file, expectedPredecessorRuntimeSha: predecessor,
      expectedTargetRuntimeSha: target, expectedTargetVersion: VERSION,
      expectedArtifactDigest: artifact, expectedReviewEvidenceSha256: review,
      expectedMigrationPolicySubjectSha256: policy, expectedPromotionRunId: runId, now,
      expectedPhase: 'online_pre_stop', expectedDatabaseOwnerState: 'online',
    });
  }

  it('accepts exact private evidence and rejects stale, tampered, replayed, permissive, and symlink records', () => {
    mkdirSync(productionDir, { recursive: true, mode: 0o700 });
    chmodSync(productionDir, 0o700);
    const id = `${process.pid}-${Date.now()}`;
    const file = join(productionDir, `rehearsal-${id}.json`);
    const link = join(productionDir, `rehearsal-${id}.link.json`);
    try {
      writeFileSync(file, `${JSON.stringify(validEvidence())}\n`, { mode: 0o600 });
      expect(validate(file)).toMatchObject({ valid: true, reason: null });

      for (const [mutate, expectedReason] of [
        [(value: any) => { value.predecessorRuntimeSha = '0'.repeat(40); }, 'predecessor_runtime_mismatch'],
        [(value: any) => { value.targetRuntimeSha = '0'.repeat(40); }, 'target_runtime_mismatch'],
        [(value: any) => { value.targetVersion = '0.0.0-test'; }, 'target_version_mismatch'],
        [(value: any) => { value.artifactDigest = '0'.repeat(64); }, 'artifact_digest_mismatch'],
        [(value: any) => { value.reviewEvidenceSha256 = '0'.repeat(64); }, 'review_evidence_mismatch'],
        [(value: any) => { value.migrationPolicySubjectSha256 = '0'.repeat(64); }, 'migration_policy_subject_mismatch'],
        [(value: any) => { value.candidate.migrationSetSha256 = '0'.repeat(64); }, 'candidate_migration_set_mismatch'],
        [(value: any) => { value.source.databaseRelativePath = 'other.db'; }, 'source_database_identity_invalid'],
        [(value: any) => { value.checks.temporaryCloneCleanup = 'pending'; }, 'clone_cleanup_not_proved'],
      ] as Array<[(value: any) => void, string]>) {
        const tampered = validEvidence();
        mutate(tampered);
        writeFileSync(file, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
        expect(validate(file).reason).toBe(expectedReason);
      }

      const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      writeFileSync(file, `${JSON.stringify(validEvidence(staleAt))}\n`, { mode: 0o600 });
      expect(validate(file).reason).toBe('evidence_stale');

      const replay = validEvidence();
      replay.promotionRunId = '20260718T231000Z-9999-aaaaaaaaaaaa';
      writeFileSync(file, `${JSON.stringify(replay)}\n`, { mode: 0o600 });
      expect(validate(file).reason).toBe('promotion_run_mismatch');

      writeFileSync(file, `${JSON.stringify(validEvidence())}\n`, { mode: 0o644 });
      chmodSync(file, 0o644);
      expect(validate(file).reason).toBe('evidence_permissions_unsafe');

      chmodSync(file, 0o600);
      chmodSync(productionDir, 0o770);
      expect(validate(file).reason).toBe('governed_directory_unsafe');
      chmodSync(productionDir, 0o700);

      symlinkSync(file, link);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(validate(link).reason).toBe('evidence_not_regular_file');

      const outside = join(ROOT, '.local', `rehearsal-outside-${id}.json`);
      writeFileSync(outside, `${JSON.stringify(validEvidence())}\n`, { mode: 0o600 });
      expect(validate(outside).reason).toBe('path_outside_governed_directory');
      rmSync(outside, { force: true });
    } finally {
      rmSync(link, { force: true });
      rmSync(file, { force: true });
    }
  });
});
