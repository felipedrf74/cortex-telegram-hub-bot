import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  candidateMigrationIdentity,
  PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA,
} from '../../scripts/lib/production-shape-migration-rehearsal-evidence.mjs';
import {
  loadProductionMigrationLineagePolicy,
  resolveProductionMigrationLineage,
} from '../../scripts/lib/production-migration-lineage.mjs';
import {
  migrationSafetyGovernanceReason,
} from '../../scripts/lib/migration-safety-policy-classifier.mjs';

const root = resolve(process.cwd());
const migrationSafetyScript = join(root, 'scripts/migration-safety-check.mjs');

function envWithoutMigrationEvidence() {
  const env = { ...process.env };
  delete env.NEXUS_MIGRATION_REVIEW_EVIDENCE;
  delete env.NEXUS_MIGRATION_BACKUP_EVIDENCE;
  delete env.NEXUS_MIGRATION_REHEARSAL_EVIDENCE;
  delete env.NEXUS_MIGRATION_FINAL_REHEARSAL_EVIDENCE;
  return env;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = envWithoutMigrationEvidence();
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) delete env[key];
  return env;
}

const releaseBoundaryMigrationNames = new Map<number, string>([
  [58, '058_composite_unique_constraints.sql'],
  [246, '246_content_pipeline_workspace_exit.sql'],
  [247, '247_content_topics_workspace_exit.sql'],
  [248, '248_content_workspace_rollout_observability.sql'],
  [249, '249_content_editorial_workspace_exit.sql'],
  [250, '250_content_performance_workspace_lineage.sql'],
  [251, '251_content_workspace_integrity.sql'],
  [252, '252_content_legacy_script_workspace_parity.sql'],
  [253, '253_content_legacy_idea_note_workspace_parity.sql'],
  [283, '283_release_schema_convergence.sql'],
]);

const firstReleaseBoundarySql = [
  'CREATE TABLE content_ref_channels (id INTEGER PRIMARY KEY, user_id INTEGER, channel_url TEXT);',
  'CREATE TABLE content_knowledge (id INTEGER PRIMARY KEY, user_id INTEGER, category TEXT);',
  'CREATE TABLE invoice_vendors (id INTEGER PRIMARY KEY, user_id INTEGER, sender_pattern TEXT);',
  'CREATE TABLE video_transcripts (id INTEGER PRIMARY KEY, user_id INTEGER, video_id TEXT);',
  '',
].join('\n');

function releaseBoundaryMigrationName(prefix: number): string {
  return releaseBoundaryMigrationNames.get(prefix)
    ?? `${String(prefix).padStart(3, '0')}_release_boundary_fixture.sql`;
}

function releaseBoundaryMigrationBytes(prefix: number): Buffer {
  if (prefix === 1) return Buffer.from(firstReleaseBoundarySql);
  if (prefix === 2) {
    return Buffer.from(
      'CREATE TABLE release_boundary_fixture_002 (id INTEGER PRIMARY KEY);\n',
    );
  }
  if (prefix === 58 || prefix === 283) {
    return readFileSync(join(root, 'migrations', releaseBoundaryMigrationName(prefix)));
  }
  return Buffer.from(
    `CREATE TABLE release_boundary_fixture_${String(prefix).padStart(3, '0')} `
    + '(id INTEGER PRIMARY KEY);\n',
  );
}

function createReleaseBoundaryRepo(prefix: string) {
  const repo = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const gitEnv = cleanGitEnv();
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Nexus CI Fixture');
  git('config', 'user.email', 'ci-fixture@example.invalid');

  mkdirSync(join(repo, 'migrations'), { recursive: true });
  mkdirSync(join(repo, 'config'), { recursive: true });
  const productionRetired = '900_retired_production_fixture.sql';
  const stagingRetired = '901_retired_staging_fixture.sql';
  const productionBytes = releaseBoundaryMigrationBytes(1);
  const stagingBytes = releaseBoundaryMigrationBytes(2);
  writeFileSync(join(repo, 'migrations', productionRetired), productionBytes);
  writeFileSync(join(repo, 'migrations', stagingRetired), stagingBytes);
  git('add', '.');
  git('commit', '-m', 'fixture: historical retired migration lineage');
  const sourceCommit = git('rev-parse', 'HEAD');
  unlinkSync(join(repo, 'migrations', productionRetired));
  unlinkSync(join(repo, 'migrations', stagingRetired));

  for (let migrationPrefix = 1; migrationPrefix <= 283; migrationPrefix += 1) {
    writeFileSync(
      join(repo, 'migrations', releaseBoundaryMigrationName(migrationPrefix)),
      releaseBoundaryMigrationBytes(migrationPrefix),
    );
  }
  const productionPolicy = JSON.parse(
    readFileSync(join(root, 'config/production-migration-lineages.json'), 'utf8'),
  ) as { release: unknown };
  writeFileSync(join(repo, 'config/production-migration-lineages.json'), `${JSON.stringify({
    schema: 'nexus.production-migration-lineages.v3',
    lineages: [
      {
        id: 'production-2026-05-branch-history',
        reason: 'retain_verified_fixture_production_history',
        migrations: [{
          file: productionRetired,
          sha256: sha256(productionBytes),
          sourceCommit,
          replacement: {
            file: releaseBoundaryMigrationName(1),
            sha256: sha256(productionBytes),
            relationship: 'byte_identical_renumber',
          },
        }],
      },
      {
        id: 'staging-2026-08-notification-renumber-history',
        reason: 'retain_verified_fixture_staging_history',
        migrations: [{
          file: stagingRetired,
          sha256: sha256(stagingBytes),
          sourceCommit,
          replacement: {
            file: releaseBoundaryMigrationName(2),
            sha256: sha256(stagingBytes),
            relationship: 'byte_identical_renumber',
          },
        }],
      },
    ],
    release: productionPolicy.release,
  }, null, 2)}\n`);
  return { repo, git, gitEnv };
}

function createGovernedMigrationRepo({ registrySha }: { registrySha?: string } = {}) {
  const { repo, git, gitEnv } = createReleaseBoundaryRepo('nexus-migration-policy-');
  const sql = 'CREATE TABLE reviewed_value (id INTEGER PRIMARY KEY);\n';
  const migration = 'migrations/284_reviewed_value.sql';
  writeFileSync(join(repo, migration), sql);
  writeFileSync(join(repo, 'config/irreversible-migrations.json'), `${JSON.stringify({
    schema: 'nexus.irreversible-migrations.v2',
    migrations: [{
      file: migration,
      sha256: registrySha ?? sha256(sql),
      reason: 'reviewed_state_cutover',
      rollback: 'exact_pre_migration_snapshot',
    }],
    syntaxExemptions: [],
  }, null, 2)}\n`);
  git('add', '.');
  git('commit', '-m', 'fixture: reviewed migration');
  return { repo, migration, git, gitEnv, base: git('rev-parse', 'HEAD') };
}

function createAppendOnlyMigrationRepo() {
  const { repo, git, gitEnv } = createReleaseBoundaryRepo(
    'nexus-migration-append-only-',
  );
  const migration = 'migrations/284_initial_value.sql';
  writeFileSync(
    join(repo, migration),
    'CREATE TABLE initial_value (id INTEGER PRIMARY KEY);\n',
  );
  writeFileSync(join(repo, 'config/irreversible-migrations.json'), `${JSON.stringify({
    schema: 'nexus.irreversible-migrations.v2',
    migrations: [],
    syntaxExemptions: [],
  }, null, 2)}\n`);
  git('add', '.');
  git('commit', '-m', 'fixture: append-only migration history');
  return { repo, migration, git, gitEnv, base: git('rev-parse', 'HEAD') };
}

function createProductionPolicyFixtureRepo() {
  const { repo, git, gitEnv } = createReleaseBoundaryRepo(
    'nexus-migration-production-policy-',
  );
  const productionPolicy = JSON.parse(
    readFileSync(join(root, 'config/irreversible-migrations.json'), 'utf8'),
  ) as {
    schema: string;
    migrations: Array<{
      file: string;
      reason: string;
      rollback: string;
    }>;
    syntaxExemptions: Array<{
      file: string;
      reason: string;
    }>;
  };
  writeFileSync(join(repo, 'config/irreversible-migrations.json'), `${JSON.stringify({
    schema: productionPolicy.schema,
    migrations: productionPolicy.migrations.map((entry) => ({
      ...entry,
      sha256: sha256(readFileSync(join(repo, entry.file))),
    })),
    syntaxExemptions: productionPolicy.syntaxExemptions.map((entry) => ({
      ...entry,
      sha256: sha256(readFileSync(join(repo, entry.file))),
    })),
  }, null, 2)}\n`);
  git('add', '.');
  git('commit', '-m', 'fixture: production migration policy topology');
  return {
    repo,
    gitEnv,
    base: git('rev-parse', 'HEAD'),
  };
}

describe('migration-safety-check', () => {
  let productionPolicyFixture: ReturnType<typeof createProductionPolicyFixtureRepo>;

  beforeAll(() => {
    productionPolicyFixture = createProductionPolicyFixtureRepo();
  });

  afterAll(() => {
    rmSync(productionPolicyFixture.repo, { recursive: true, force: true });
  });

  it('validates every registered migration identity during cumulative rehearsal', { timeout: 30_000 }, () => {
    const result = spawnSync(
      'node',
      ['scripts/migration-safety-check.mjs', '--json'],
      { encoding: 'utf8', env: envWithoutMigrationEvidence() },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      checks: { cumulativeRehearsal: boolean; policyIdentity: boolean };
      policyIdentityIssues: unknown[];
    };
    expect(payload.checks).toMatchObject({ cumulativeRehearsal: true, policyIdentity: true });
    expect(payload.policyIdentityIssues).toEqual([]);
  });

  it('keeps ordinary CI and local risk checks non-authorizing', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const riskGate = readFileSync('scripts/risk-gate.sh', 'utf8');
    const preCommit = readFileSync('.husky/pre-commit', 'utf8');

    expect(ci).toContain('--approval-mode scan');
    expect(ci).not.toContain('NEXUS_MIGRATION_REVIEW_EVIDENCE_JSON');
    expect(ci).not.toContain('environment: migration-review');
    expect(riskGate).toContain('--approval-mode scan');
    expect(riskGate).not.toContain('--approval-mode review');
    expect(preCommit).not.toContain('NEXUS_MIGRATION_REVIEW_EVIDENCE');
  });

  it('blocks changed irreversible migrations without digest-bound review evidence', { timeout: 30_000 }, () => {
    const result = spawnSync(
      'node',
      [
        migrationSafetyScript,
        '--root',
        productionPolicyFixture.repo,
        '--changed-only',
        '--approval-mode',
        'review',
        '--files',
        'migrations/246_content_pipeline_workspace_exit.sql',
        '--json',
      ],
      { encoding: 'utf8', env: productionPolicyFixture.gitEnv },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as { errors: string[]; requiredReviewSubject: { sha256: string } };
    expect(payload.requiredReviewSubject.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.errors).toContain(
      'irreversible_migration_review_evidence_invalid:path_missing_or_outside_governed_directory',
    );
  });

  it('reports approval as required in non-authorizing scan mode without claiming review', { timeout: 30_000 }, () => {
    const result = spawnSync(
      'node',
      [
        migrationSafetyScript, '--root', productionPolicyFixture.repo, '--changed-only',
        '--approval-mode', 'scan',
        '--files', 'migrations/246_content_pipeline_workspace_exit.sql',
        '--json',
      ],
      { encoding: 'utf8', env: productionPolicyFixture.gitEnv },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      approvalMode: string;
      checks: { reviewApproval: null; exactBackupEvidence: null };
      authorization: {
        approvalRequired: boolean;
        governanceReviewRequired: boolean;
        backupRequired: boolean;
        authorizesPromotion: boolean;
      };
      requiredReviewSubject: { sha256: string };
    };
    expect(payload.approvalMode).toBe('scan');
    expect(payload.checks).toMatchObject({ reviewApproval: null, exactBackupEvidence: null });
    expect(payload.authorization).toEqual({
      approvalRequired: true,
      governanceReviewRequired: false,
      backupRequired: true,
      authorizesPromotion: false,
    });
    expect(payload.requiredReviewSubject.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds review approval to the exact changed governance bytes', { timeout: 30_000 }, () => {
    const fixture = createGovernedMigrationRepo();
    try {
      mkdirSync(join(fixture.repo, 'scripts'), { recursive: true });
      const governedPath = join(fixture.repo, 'scripts/migration-safety-check.mjs');
      const invoke = () => spawnSync('node', [
        migrationSafetyScript, '--root', fixture.repo, '--changed-only',
        '--approval-mode', 'scan', '--files', 'scripts/migration-safety-check.mjs', '--json',
      ], { encoding: 'utf8', env: fixture.gitEnv });

      writeFileSync(governedPath, 'export const policyVersion = 1;\n');
      const before = invoke();
      expect(before.status, `${before.stdout}${before.stderr}`).toBe(0);
      const beforeSubject = JSON.parse(before.stdout).requiredReviewSubject;
      const beforePayload = JSON.parse(before.stdout) as {
        governanceChanges: Array<{ file: string; reason: string }>;
        irreversibleSchemaMigrations: unknown[];
        authorization: {
          approvalRequired: boolean;
          governanceReviewRequired: boolean;
          backupRequired: boolean;
        };
      };
      expect(beforePayload.governanceChanges).toEqual([{
        file: 'scripts/migration-safety-check.mjs',
        reason: 'POLICY_GATE_CHANGED',
      }]);
      expect(beforePayload.irreversibleSchemaMigrations).toEqual([]);
      expect(beforePayload.authorization).toMatchObject({
        approvalRequired: false,
        governanceReviewRequired: true,
        backupRequired: false,
      });

      writeFileSync(governedPath, 'export const policyVersion = 2;\n');
      const after = invoke();
      expect(after.status, `${after.stdout}${after.stderr}`).toBe(0);
      const afterSubject = JSON.parse(after.stdout).requiredReviewSubject;

      expect(beforeSubject.irreversibleChanges[0].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(afterSubject.irreversibleChanges[0].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(afterSubject.sha256).not.toBe(beforeSubject.sha256);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it('allows review without claiming a backup when exact approval evidence matches', { timeout: 60_000 }, () => {
    const relativeEvidence = `.local/release/migration-review/test-${process.pid}-${Date.now()}.json`;
    const absoluteEvidence = join(productionPolicyFixture.repo, relativeEvidence);
    const args = [
      migrationSafetyScript,
      '--root',
      productionPolicyFixture.repo,
      '--changed-only',
      '--approval-mode',
      'review',
      '--files',
      'migrations/246_content_pipeline_workspace_exit.sql',
      '--json',
    ];
    try {
      const missing = spawnSync('node', args, {
        encoding: 'utf8', env: productionPolicyFixture.gitEnv,
      });
      const required = JSON.parse(missing.stdout).requiredReviewSubject;
      mkdirSync(
        join(productionPolicyFixture.repo, '.local/release/migration-review'),
        { recursive: true },
      );
      writeFileSync(absoluteEvidence, `${JSON.stringify({
        schema: 'nexus.migration-review-approval.v1',
        status: 'approved',
        approvedBy: 'fixture-owner',
        approvedAt: new Date().toISOString(),
        subjectSha256: required.sha256,
      })}\n`, { mode: 0o600 });

      const result = spawnSync('node', [...args, '--review-evidence', relativeEvidence], {
        encoding: 'utf8', env: productionPolicyFixture.gitEnv,
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        checks: { changedIrreversiblePolicy: boolean; reviewApproval: boolean };
        backupEvidence: unknown;
        reviewEvidence: { approvedBy: string };
      };
      expect(payload.checks).toMatchObject({ changedIrreversiblePolicy: true, reviewApproval: true });
      expect(payload.reviewEvidence.approvedBy).toBe('fixture-owner');
      expect(payload.backupEvidence).toBeNull();
    } finally {
      rmSync(absoluteEvidence, { force: true });
    }
  });

  it('requires a fresh verified exact-backup record in promotion mode', { timeout: 120_000 }, () => {
    const id = `${process.pid}-${Date.now()}`;
    const reviewRelative = `.local/release/migration-review/promotion-${id}.json`;
    const backupRelative = `.local/release/production/promotion-${id}.json`;
    const onlineRelative = `.local/release/production/promotion-online-${id}.json`;
    const finalRelative = `.local/release/production/promotion-final-${id}.json`;
    const reviewAbsolute = join(productionPolicyFixture.repo, reviewRelative);
    const backupAbsolute = join(productionPolicyFixture.repo, backupRelative);
    const onlineAbsolute = join(productionPolicyFixture.repo, onlineRelative);
    const finalAbsolute = join(productionPolicyFixture.repo, finalRelative);
    const base = productionPolicyFixture.base;
    const artifactDigest = 'c'.repeat(64);
    const promotionRunId = '20260718T225500Z-4242-abcdef123456';
    const commonArgs = [
      migrationSafetyScript, '--root', productionPolicyFixture.repo,
      '--base', base, '--changed-only',
      '--files', 'migrations/246_content_pipeline_workspace_exit.sql', '--json',
    ];
    try {
      const missing = spawnSync('node', [...commonArgs, '--approval-mode', 'review'], {
        encoding: 'utf8', env: productionPolicyFixture.gitEnv,
      });
      const required = JSON.parse(missing.stdout).requiredReviewSubject;
      mkdirSync(
        join(productionPolicyFixture.repo, '.local/release/migration-review'),
        { recursive: true },
      );
      mkdirSync(
        join(productionPolicyFixture.repo, '.local/release/production'),
        { recursive: true },
      );
      writeFileSync(reviewAbsolute, `${JSON.stringify({
        schema: 'nexus.migration-review-approval.v1', status: 'approved',
        approvedBy: 'fixture-owner', approvedAt: new Date().toISOString(),
        subjectSha256: required.sha256,
      })}\n`, { mode: 0o600 });
      const reviewed = spawnSync('node', [
        ...commonArgs, '--approval-mode', 'review', '--review-evidence', reviewRelative,
      ], { encoding: 'utf8', env: productionPolicyFixture.gitEnv });
      expect(reviewed.status, `${reviewed.stdout}${reviewed.stderr}`).toBe(0);
      const reviewPayload = JSON.parse(reviewed.stdout);
      const now = Date.now();
      const onlineCreatedAt = new Date(now - 2_000).toISOString();
      const createdAt = new Date(now - 1_000).toISOString();
      const finalCreatedAt = new Date(now).toISOString();
      const candidate = candidateMigrationIdentity(productionPolicyFixture.repo);
      const lineagePolicy = loadProductionMigrationLineagePolicy({
        root: productionPolicyFixture.repo,
      });
      const canonicalLineage = resolveProductionMigrationLineage(lineagePolicy, []);
      const onlineDatabaseSha256 = 'd'.repeat(64);
      const stoppedDatabaseSha256 = 'e'.repeat(64);
      const rehearsal = (phase: 'online_pre_stop' | 'stopped_final', created: string) => ({
        schema: PRODUCTION_SHAPE_MIGRATION_REHEARSAL_SCHEMA, status: 'verified',
        startedAt: created, createdAt: created, promotionRunId, phase,
        predecessorRuntimeSha: base, targetRuntimeSha: base, targetVersion: '4.14.224',
        artifactDigest, reviewEvidenceSha256: reviewPayload.reviewEvidence.sha256,
        migrationPolicySubjectSha256: reviewPayload.reviewEvidence.policySubjectSha256,
        source: {
          databaseRelativePath: 'data/bot.db',
          databaseOwnerState: phase === 'online_pre_stop' ? 'online' : 'stopped',
          readOnlyConnection: true, onlineBackup: true, alreadyMigrated: false,
          appliedMigrationCount: candidate.migrationCount - 15,
          migrationSetSha256: '1'.repeat(64),
          databaseSha256: phase === 'online_pre_stop' ? onlineDatabaseSha256 : stoppedDatabaseSha256,
          migrationLineageId: canonicalLineage.id,
          retiredMigrationCount: canonicalLineage.migrationCount,
          retiredMigrationSetSha256: canonicalLineage.migrationSetSha256,
          retiredMigrationPolicySha256: lineagePolicy.sha256,
        },
        candidate: {
          migrationCount: candidate.migrationCount,
          migrationSetSha256: candidate.migrationSetSha256,
          pendingMigrationCount: 15, pendingMigrationSetSha256: '2'.repeat(64),
          requiredContentMigrationCount: 15,
          requiredContentMigrationSetSha256: candidate.requiredContentMigrationSetSha256,
          requiredContentMigrationsPending: true,
        },
        clone: { sourceSha256: '3'.repeat(64), migratedSha256: '4'.repeat(64), sizeBytes: 1024 },
        checks: {
          sqliteIntegrity: 'ok', sqliteForeignKeys: 'ok',
          contentPipelineWorkspaceExit: 'ready', contentTopicWorkspaceExit: 'ready',
          contentEditorialWorkspaceExit: 'ready', contentPerformanceWorkspaceLineage: 'ready',
          contentWorkspaceIntegrity: 'ready', contentLegacyIdeaWorkspaceExit: 'ready',
          temporaryCloneCleanup: 'verified',
        },
      });
      const onlineEvidence = rehearsal('online_pre_stop', onlineCreatedAt);
      const finalEvidence = rehearsal('stopped_final', finalCreatedAt);
      const onlineRaw = `${JSON.stringify(onlineEvidence)}\n`;
      const finalRaw = `${JSON.stringify(finalEvidence)}\n`;
      writeFileSync(onlineAbsolute, onlineRaw, { mode: 0o600 });
      writeFileSync(finalAbsolute, finalRaw, { mode: 0o600 });
      writeFileSync(backupAbsolute, `${JSON.stringify({
        schema: 'nexus.exact-migration-backup-evidence.v2', status: 'verified', createdAt,
        promotionRunId,
        predecessorRuntimeSha: base, targetRuntimeSha: base, targetVersion: '4.14.224',
        artifactDigest,
        reviewEvidenceSha256: reviewPayload.reviewEvidence.sha256,
        migrationPolicySubjectSha256: reviewPayload.reviewEvidence.policySubjectSha256,
        productionShapeRehearsals: {
          onlinePreStop: {
            evidenceSha256: sha256(onlineRaw), sourceCloneSha256: '3'.repeat(64),
            migratedCloneSha256: '4'.repeat(64), pendingMigrationSetSha256: '2'.repeat(64),
            sourceDatabaseSha256: onlineDatabaseSha256,
          },
          stoppedFinal: {
            evidenceSha256: sha256(finalRaw), sourceCloneSha256: '3'.repeat(64),
            migratedCloneSha256: '4'.repeat(64), pendingMigrationSetSha256: '2'.repeat(64),
            sourceDatabaseSha256: stoppedDatabaseSha256,
          },
        },
        backup: {
          remotePath: '/home/dominguez/backups/nexushub/v4.14.223_before-v4.14.224_20260718_225500.tar.gz',
          sha256: 'a'.repeat(64), sizeBytes: 1024, archivedVersion: '4.14.223',
          targetVersion: '4.14.224', createdAt, databaseSha256: stoppedDatabaseSha256,
        },
        verification: {
          databaseOwnersStopped: true, noOpenDatabaseHandles: true,
          walCheckpointTruncated: true, sqliteIntegrity: 'ok', sqliteForeignKeys: 'ok',
          archiveSha256Verified: true,
        },
      })}\n`, { mode: 0o600 });

      const promoted = spawnSync('node', [
        ...commonArgs, '--approval-mode', 'promotion', '--review-evidence', reviewRelative,
        '--rehearsal-evidence', onlineRelative, '--final-rehearsal-evidence', finalRelative,
        '--backup-evidence', backupRelative, '--target-version', '4.14.224',
        '--artifact-digest', artifactDigest, '--promotion-run-id', promotionRunId,
      ], { encoding: 'utf8', env: productionPolicyFixture.gitEnv });
      expect(promoted.status, `${promoted.stdout}${promoted.stderr}`).toBe(0);
      expect(JSON.parse(promoted.stdout).checks).toMatchObject({
        reviewApproval: true, productionShapeRehearsal: true,
        finalProductionShapeRehearsal: true, exactBackupEvidence: true,
        changedIrreversiblePolicy: true,
      });

      const tampered = JSON.parse(readFileSync(backupAbsolute, 'utf8'));
      tampered.backup.archivedVersion = '4.14.222';
      writeFileSync(backupAbsolute, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      const archiveIdentityRejected = spawnSync('node', [
        ...commonArgs, '--approval-mode', 'promotion', '--review-evidence', reviewRelative,
        '--rehearsal-evidence', onlineRelative, '--final-rehearsal-evidence', finalRelative,
        '--backup-evidence', backupRelative, '--target-version', '4.14.224',
        '--artifact-digest', artifactDigest, '--promotion-run-id', promotionRunId,
      ], { encoding: 'utf8', env: productionPolicyFixture.gitEnv });
      expect(archiveIdentityRejected.status).toBe(1);
      expect(JSON.parse(archiveIdentityRejected.stdout).errors).toContain(
        'irreversible_migration_backup_evidence_invalid:backup_archived_version_path_mismatch',
      );

      tampered.backup.archivedVersion = '4.14.223';
      tampered.reviewEvidenceSha256 = 'b'.repeat(64);
      writeFileSync(backupAbsolute, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      const rejected = spawnSync('node', [
        ...commonArgs, '--approval-mode', 'promotion', '--review-evidence', reviewRelative,
        '--rehearsal-evidence', onlineRelative, '--final-rehearsal-evidence', finalRelative,
        '--backup-evidence', backupRelative, '--target-version', '4.14.224',
        '--artifact-digest', artifactDigest, '--promotion-run-id', promotionRunId,
      ], { encoding: 'utf8', env: productionPolicyFixture.gitEnv });
      expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stdout).errors).toContain(
        'irreversible_migration_backup_evidence_invalid:review_evidence_mismatch',
      );
    } finally {
      rmSync(reviewAbsolute, { force: true });
      rmSync(backupAbsolute, { force: true });
      rmSync(onlineAbsolute, { force: true });
      rmSync(finalAbsolute, { force: true });
    }
  });

  it('enforces the governed Content cutovers even when their SQL has no destructive keyword', { timeout: 30_000 }, () => {
    const result = spawnSync(
      'node',
      [
        migrationSafetyScript,
        '--root',
        productionPolicyFixture.repo,
        '--changed-only',
        '--files',
        [
          'migrations/246_content_pipeline_workspace_exit.sql',
          'migrations/248_content_workspace_rollout_observability.sql',
          'migrations/250_content_performance_workspace_lineage.sql',
          'migrations/252_content_legacy_script_workspace_parity.sql',
        ].join(','),
        '--json',
      ],
      { encoding: 'utf8', env: productionPolicyFixture.gitEnv },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
    };
    expect(payload.irreversibleChangedMigrations).toEqual([
      {
        file: 'migrations/246_content_pipeline_workspace_exit.sql',
        reason: 'POLICY:state_coupled_legacy_pipeline_cutover',
      },
      {
        file: 'migrations/250_content_performance_workspace_lineage.sql',
        reason: 'POLICY:immutable_performance_lineage_cutover',
      },
      {
        file: 'migrations/252_content_legacy_script_workspace_parity.sql',
        reason: 'POLICY:lossless_legacy_script_authority_cutover',
      },
    ]);
  });

  it.each([
    ['config/irreversible-migrations.json', 'POLICY_REGISTRY_CHANGED'],
    ['config/production-migration-lineages.json', 'POLICY_PRODUCTION_LINEAGE_CHANGED'],
    ['.github/workflows/ci.yml', 'POLICY_CI_ENTRYPOINT_CHANGED'],
    ['.github/workflows/release.yml', 'POLICY_RELEASE_PUBLISH_ENTRYPOINT_CHANGED'],
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
    ['scripts/lib/release-manifest.mjs', 'POLICY_RELEASE_MANIFEST_VALIDATION_CHANGED'],
    ['scripts/lib/release-database.mjs', 'POLICY_RELEASE_MIGRATION_LEDGER_CHANGED'],
    ['scripts/lib/release-deployment.mjs', 'POLICY_RELEASE_MIGRATION_ADMISSION_CHANGED'],
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
  ])('classifies migration governance changes without replaying all migrations: %s', (file, reason) => {
    expect(migrationSafetyGovernanceReason(file)).toBe(reason);
  });

  it('binds the in-process governance classifier to the fail-closed CLI result', { timeout: 30_000 }, () => {
    const file = 'config/irreversible-migrations.json';
    const result = spawnSync(
      'node',
      [
        migrationSafetyScript,
        '--root',
        productionPolicyFixture.repo,
        '--changed-only',
        '--files',
        file,
        '--json',
      ],
      { encoding: 'utf8', env: productionPolicyFixture.gitEnv },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
    };
    expect(payload.irreversibleChangedMigrations).toEqual([{
      file,
      reason: migrationSafetyGovernanceReason(file),
    }]);
  });

  it('compares an in-progress merge to main while preserving incoming-main deletion detection', { timeout: 30_000 }, () => {
    const fixture = createGovernedMigrationRepo();
    try {
      const branchOnlyMigration = 'migrations/285_branch_only.sql';
      const mainMigration = 'migrations/285_main.sql';
      const finalMigration = 'migrations/286_branch_only.sql';

      fixture.git('switch', '-c', 'feature');
      writeFileSync(
        join(fixture.repo, branchOnlyMigration),
        'CREATE TABLE branch_only_value (id INTEGER PRIMARY KEY);\n',
      );
      fixture.git('add', branchOnlyMigration);
      fixture.git('commit', '-m', 'fixture: add branch-only migration');
      const featureHead = fixture.git('rev-parse', 'HEAD');

      fixture.git('switch', 'main');
      writeFileSync(
        join(fixture.repo, mainMigration),
        'CREATE TABLE main_value (id INTEGER PRIMARY KEY);\n',
      );
      fixture.git('add', mainMigration);
      fixture.git('commit', '-m', 'fixture: add main migration');

      fixture.git('switch', 'feature');
      fixture.git('merge', '--no-commit', 'main');
      fixture.git('mv', branchOnlyMigration, finalMigration);

      const result = spawnSync(
        'node',
        [
          migrationSafetyScript,
          '--root', fixture.repo,
          '--base', featureHead,
          '--changed-only',
          '--approval-mode', 'scan',
          '--json',
        ],
        { encoding: 'utf8', env: fixture.gitEnv },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout) as {
        irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
      };
      expect(payload.irreversibleChangedMigrations).not.toContainEqual({
        file: branchOnlyMigration,
        reason: 'DELETED_OR_RENAMED',
      });

      fixture.git('rm', '--force', mainMigration);
      const droppedIncomingMain = spawnSync(
        'node',
        [
          migrationSafetyScript,
          '--root', fixture.repo,
          '--base', featureHead,
          '--changed-only',
          '--approval-mode', 'scan',
          '--json',
        ],
        { encoding: 'utf8', env: fixture.gitEnv },
      );
      expect(droppedIncomingMain.status).toBe(1);
      const droppedPayload = JSON.parse(droppedIncomingMain.stdout) as {
        irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
      };
      expect(droppedPayload.irreversibleChangedMigrations).toContainEqual({
        file: mainMigration,
        reason: 'DELETED_OR_RENAMED',
      });
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it.each(['rename', 'deletion'])(
    'fails closed for a governed same-prefix %s discovered from Git',
    { timeout: 30_000 },
    (operation) => {
      const fixture = createGovernedMigrationRepo();
      try {
        if (operation === 'rename') {
          fixture.git('mv', fixture.migration, 'migrations/284_renamed_value.sql');
        } else {
          unlinkSync(join(fixture.repo, fixture.migration));
        }
        const result = spawnSync(
          'node',
          [
            migrationSafetyScript,
            '--root', fixture.repo,
            '--base', fixture.base,
            '--changed-only',
            '--json',
          ],
          { encoding: 'utf8', env: fixture.gitEnv },
        );

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          checks: { policyIdentity: boolean };
          errors: string[];
          irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
        };
        expect(payload.checks.policyIdentity).toBe(false);
        expect(payload.errors).toContain(
          `irreversible_migration_policy_identity_invalid:${fixture.migration}:missing`,
        );
        expect(payload.irreversibleChangedMigrations).toContainEqual({
          file: fixture.migration,
          reason: 'POLICY_IDENTITY_MISSING',
        });
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    },
  );

  it.each(['modified', 'rename', 'deletion'])(
    'rejects a %s migration already present in the Git base even when the new SQL is compatible',
    { timeout: 30_000 },
    (operation) => {
      const fixture = createAppendOnlyMigrationRepo();
      try {
        if (operation === 'modified') {
          writeFileSync(
            join(fixture.repo, fixture.migration),
            'CREATE TABLE initial_value (id INTEGER PRIMARY KEY, note TEXT);\n',
          );
        } else if (operation === 'rename') {
          fixture.git('mv', fixture.migration, 'migrations/284_renamed_value.sql');
        } else {
          unlinkSync(join(fixture.repo, fixture.migration));
        }

        const result = spawnSync('node', [
          migrationSafetyScript,
          '--root', fixture.repo,
          '--base', fixture.base,
          '--changed-only',
          '--approval-mode', 'scan',
          '--json',
        ], { encoding: 'utf8', env: fixture.gitEnv });

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          checks: { migrationHistoryAppendOnly: boolean };
          errors: string[];
        };
        expect(payload.checks.migrationHistoryAppendOnly).toBe(false);
        expect(payload.errors).toContain(
          `migration_history_not_append_only:${fixture.migration}:`
          + (operation === 'modified' ? 'modified' : 'deleted_or_renamed'),
        );
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    },
  );

  it('allows a new append-only migration that is absent from the Git base', { timeout: 30_000 }, () => {
    const fixture = createAppendOnlyMigrationRepo();
    try {
      const added = 'migrations/285_added_value.sql';
      writeFileSync(
        join(fixture.repo, added),
        'CREATE TABLE added_value (id INTEGER PRIMARY KEY);\n',
      );
      const result = spawnSync('node', [
        migrationSafetyScript,
        '--root', fixture.repo,
        '--base', fixture.base,
        '--changed-only',
        '--approval-mode', 'scan',
        '--json',
      ], { encoding: 'utf8', env: fixture.gitEnv });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        comparisonBase: string;
        checks: { migrationHistoryAppendOnly: boolean };
        cdEligibility: { eligible: boolean; files: Array<{ file: string }> };
      };
      expect(payload.comparisonBase).toBe(fixture.base);
      expect(payload.checks.migrationHistoryAppendOnly).toBe(true);
      expect(payload.cdEligibility.eligible).toBe(true);
      expect(payload.cdEligibility.files.map(({ file }) => file)).toEqual([added]);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it('fails closed when registry identity disagrees with existing migration bytes', { timeout: 30_000 }, () => {
    const fixture = createGovernedMigrationRepo({ registrySha: '0'.repeat(64) });
    try {
      const result = spawnSync(
        'node',
        [
          migrationSafetyScript,
          '--root', fixture.repo,
          '--changed-only',
          '--files', fixture.migration,
          '--json',
        ],
        {
          encoding: 'utf8',
        env: {
          ...fixture.gitEnv,
        },
        },
      );

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        checks: { changedIrreversiblePolicy: boolean; policyIdentity: boolean };
        errors: string[];
        irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
      };
      expect(payload.checks.policyIdentity).toBe(false);
      expect(payload.checks.changedIrreversiblePolicy).toBe(false);
      expect(payload.errors).toContain(
        `irreversible_migration_policy_identity_invalid:${fixture.migration}:digest_mismatch`,
      );
      expect(payload.irreversibleChangedMigrations).toContainEqual({
        file: fixture.migration,
        reason: 'POLICY_DIGEST_DRIFT',
      });
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it('detects governed SQL digest drift after the reviewed baseline', { timeout: 30_000 }, () => {
    const fixture = createGovernedMigrationRepo();
    try {
      writeFileSync(
        join(fixture.repo, fixture.migration),
        'CREATE TABLE reviewed_value (id INTEGER PRIMARY KEY);\n-- unreviewed drift\n',
      );
      const result = spawnSync(
        'node',
        [
          migrationSafetyScript,
          '--root', fixture.repo,
          '--base', fixture.base,
          '--changed-only',
          '--json',
        ],
        { encoding: 'utf8', env: fixture.gitEnv },
      );

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        checks: { policyIdentity: boolean };
        policyIdentityIssues: Array<{ file: string; type: string }>;
        irreversibleChangedMigrations: Array<{ file: string; reason: string }>;
      };
      expect(payload.checks.policyIdentity).toBe(false);
      expect(payload.policyIdentityIssues).toContainEqual(expect.objectContaining({
        file: fixture.migration,
        type: 'digest_mismatch',
      }));
      expect(payload.irreversibleChangedMigrations).toContainEqual({
        file: fixture.migration,
        reason: 'POLICY_DIGEST_DRIFT',
      });
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});
