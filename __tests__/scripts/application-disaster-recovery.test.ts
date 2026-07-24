import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const backupScript = path.resolve('scripts/application-dr-backup.sh');
const restoreScript = path.resolve('scripts/application-dr-restore-drill.sh');
const sqliteHelper = path.resolve('scripts/application-dr-sqlite.py');
const retentionHelper = path.resolve('scripts/application-dr-retention.py');
const archiveHelper = path.resolve('scripts/application-dr-archive.py');
const storageControlHelper = path.resolve('scripts/application-dr-storage-controls.py');
const awsCredentialBoundary = path.resolve('scripts/aws-credential-process-boundary.py');
const isolatedHarness = path.resolve('scripts/application-dr-isolated-harness.sh');
const migrationRoot = path.resolve('migrations');
const migrationLineagePolicy = path.resolve('config/production-migration-lineages.json');
const opsRoot = path.resolve('ops/application-dr');
const python = process.env.NEXUS_TEST_PYTHON ?? 'python3';
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(prefix: string) {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = fs.realpathSync(created);
  fs.chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

function runPython(args: string[]) {
  return spawnSync(python, args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function runtimeMigrationFiles() {
  return fs.readdirSync(migrationRoot)
    .filter((filename) => /^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(filename))
    .sort();
}

function migrationSetSha256(filenames: string[]) {
  return createHash('sha256').update(JSON.stringify(filenames)).digest('hex');
}

function writeMigrationLedger(database: string, filenames: string[]) {
  execFileSync(python, [
    '-c',
    [
      'import json,sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1])',
      "db.execute('CREATE TABLE _migrations(filename TEXT PRIMARY KEY)')",
      "db.executemany('INSERT INTO _migrations VALUES (?)', [(item,) for item in json.loads(sys.argv[2])])",
      'db.commit()',
      'db.close()',
    ].join(';'),
    database,
    JSON.stringify(filenames),
  ]);
  fs.chmodSync(database, 0o600);
}

describe('Nexus application disaster-recovery assets', () => {
  it('accepts only the exact Roles Anywhere credential_process boundary', () => {
    const root = privateRoot('nexus-app-dr-aws-boundary-');
    const helper = path.join(root, 'aws_signing_helper');
    const config = path.join(root, 'aws-config');
    const certificate = path.join(root, 'certificate.pem');
    const privateKey = path.join(root, 'private-key.pem');
    fs.writeFileSync(helper, 'reviewed-helper-fixture\n', { mode: 0o700 });
    fs.writeFileSync(certificate, 'reviewed-certificate-fixture\n', { mode: 0o644 });
    fs.writeFileSync(privateKey, 'reviewed-private-key-fixture\n', { mode: 0o600 });
    const helperSha256 = createHash('sha256')
      .update(fs.readFileSync(helper))
      .digest('hex');
    fs.writeFileSync(
      config,
      [
        '[profile nexus-application-dr-backup]',
        'region = eu-west-1',
        `credential_process = ${helper} credential-process `
          + `--certificate ${certificate} `
          + `--private-key ${privateKey} `
          + '--trust-anchor-arn arn:aws:rolesanywhere:eu-west-1:111122223333:trust-anchor/ta-1 '
          + '--profile-arn arn:aws:rolesanywhere:eu-west-1:111122223333:profile/profile-1 '
          + '--role-arn arn:aws:iam::111122223333:role/nexus-application-dr-backup '
          + '--session-duration 900',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_SECURITY_TOKEN',
      'AWS_CREDENTIAL_FILE',
      'AWS_DEFAULT_PROFILE',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'AWS_ROLE_SESSION_NAME',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    ]) {
      delete environment[key];
    }
    Object.assign(environment, {
      AWS_CONFIG_FILE: config,
      AWS_PROFILE: 'nexus-application-dr-backup',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    const args = [
      awsCredentialBoundary,
      '--config', config,
      '--profile', 'nexus-application-dr-backup',
      '--region', 'eu-west-1',
      '--helper', helper,
      '--helper-sha256', helperSha256,
      '--expected-role-arn',
      'arn:aws:iam::111122223333:role/nexus-application-dr-backup',
      '--expected-owner-uid', String(process.getuid?.() ?? 0),
      '--trust-boundary', root,
    ];
    const accepted = spawnSync(python, args, { encoding: 'utf8', env: environment });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      status: 'passed',
      credentialSource: 'iam-roles-anywhere-credential-process',
      longLivedEnvironmentRejected: true,
      sharedCredentialsDisabled: true,
    });

    const approvedConfig = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(
      config,
      approvedConfig.replace('--session-duration 900', '--session-duration 3600'),
      { mode: 0o600 },
    );
    const excessiveSession = spawnSync(python, args, {
      encoding: 'utf8',
      env: environment,
    });
    expect(excessiveSession.status).not.toBe(0);
    expect(excessiveSession.stderr).toContain(
      '--session-duration must equal the approved 900-second profile ceiling',
    );

    fs.writeFileSync(
      config,
      approvedConfig.replace(
        '--session-duration 900',
        '--role-session-name unapproved --session-duration 900',
      ),
      { mode: 0o600 },
    );
    const customSessionName = spawnSync(python, args, {
      encoding: 'utf8',
      env: environment,
    });
    expect(customSessionName.status).not.toBe(0);
    expect(customSessionName.stderr).toContain(
      'credential_process contains an unapproved option: --role-session-name',
    );
    fs.writeFileSync(config, approvedConfig, { mode: 0o600 });

    const longLived = spawnSync(python, args, {
      encoding: 'utf8',
      env: { ...environment, AWS_ACCESS_KEY_ID: 'forbidden-static-key' },
    });
    expect(longLived.status).not.toBe(0);
    expect(longLived.stderr).toContain(
      'alternate or long-lived AWS credential environment is forbidden',
    );

    fs.chmodSync(privateKey, 0o644);
    const exposedPrivateKey = spawnSync(python, args, {
      encoding: 'utf8',
      env: environment,
    });
    expect(exposedPrivateKey.status).not.toBe(0);
    expect(exposedPrivateKey.stderr).toContain(
      'Roles Anywhere private key mode is outside the trusted allowlist',
    );
    fs.chmodSync(privateKey, 0o600);

    fs.appendFileSync(config, 'aws_access_key_id = forbidden-in-profile\n');
    const selectedProfileStaticKey = spawnSync(python, args, {
      encoding: 'utf8',
      env: environment,
    });
    expect(selectedProfileStaticKey.status).not.toBe(0);
    expect(selectedProfileStaticKey.stderr).toContain(
      'selected AWS profile may contain only region and credential_process',
    );

    fs.writeFileSync(
      config,
      [
        '[profile nexus-application-dr-backup]',
        'region = eu-west-1',
        `credential_process = ${helper} credential-process `
          + `--certificate ${certificate} `
          + `--private-key ${privateKey} `
          + '--trust-anchor-arn arn:aws:rolesanywhere:eu-west-1:111122223333:trust-anchor/ta-1 '
          + '--profile-arn arn:aws:rolesanywhere:eu-west-1:111122223333:profile/profile-1 '
          + '--role-arn arn:aws:iam::111122223333:role/unexpected-writer '
          + '--session-duration 900',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const substitutedRole = spawnSync(python, args, {
      encoding: 'utf8',
      env: environment,
    });
    expect(substitutedRole.status).not.toBe(0);
    expect(substitutedRole.stderr).toContain(
      'credential_process role ARN differs from the exact expected role',
    );
  });

  it('takes and verifies a private SQLite recovery point through the online backup API', () => {
    const root = privateRoot('nexus-app-dr-sqlite-');
    const source = path.join(root, 'source.sqlite');
    const recoveryPoint = path.join(root, 'recovery.sqlite');
    execFileSync(
      python,
      [
        '-c',
        [
          'import sqlite3,sys',
          'db=sqlite3.connect(sys.argv[1])',
          "db.execute('PRAGMA journal_mode=WAL')",
          "db.execute('PRAGMA foreign_keys=ON')",
          "db.execute('CREATE TABLE parent(id INTEGER PRIMARY KEY)')",
          "db.execute('CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))')",
          "db.execute('INSERT INTO parent VALUES (1)')",
          "db.execute('INSERT INTO child VALUES (1,1)')",
          'db.commit()',
          'db.close()',
        ].join(';'),
        source,
      ],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );

    const snapshot = runPython([sqliteHelper, 'snapshot', source, recoveryPoint]);
    expect(snapshot.status, snapshot.stderr).toBe(0);
    expect(JSON.parse(snapshot.stdout)).toMatchObject({
      schemaVersion: 'NexusApplicationSqliteRecoveryPointV1',
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
    });
    expect(fs.statSync(recoveryPoint).mode & 0o777).toBe(0o600);
    const verify = runPython([sqliteHelper, 'verify', recoveryPoint]);
    expect(verify.status, verify.stderr).toBe(0);
    expect(JSON.parse(verify.stdout).sha256).toBe(JSON.parse(snapshot.stdout).sha256);

    const rows = execFileSync(
      python,
      ['-c', "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from child').fetchone()[0])", recoveryPoint],
      { encoding: 'utf8' },
    );
    expect(rows.trim()).toBe('1');
    expect(fs.readFileSync(sqliteHelper, 'utf8')).toContain('source_db.backup(destination_db');
  });

  it('rejects symlink inputs and non-private snapshot destinations', () => {
    const root = privateRoot('nexus-app-dr-path-');
    const source = path.join(root, 'source.sqlite');
    execFileSync(python, ['-c', 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).close()', source]);
    const link = path.join(root, 'source-link.sqlite');
    fs.symlinkSync(source, link);
    const linked = runPython([sqliteHelper, 'snapshot', link, path.join(root, 'linked.sqlite')]);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain('must not be a symlink');

    const publicParent = path.join(root, 'public');
    fs.mkdirSync(publicParent, { mode: 0o755 });
    fs.chmodSync(publicParent, 0o755);
    const publicResult = runPython([
      sqliteHelper,
      'snapshot',
      source,
      path.join(publicParent, 'recovery.sqlite'),
    ]);
    expect(publicResult.status).not.toBe(0);
    expect(publicResult.stderr).toContain('destination parent must have mode 0700');
  });

  it('rejects a database recovery point newer than the selected exact release', () => {
    const root = privateRoot('nexus-app-dr-compatibility-');
    const database = path.join(root, 'database.sqlite');
    const runtimeFiles = runtimeMigrationFiles();
    const runtimeMax = Math.max(...runtimeFiles.map((filename) => Number(filename.slice(0, 3))));
    const futureMigration = `${String(runtimeMax + 1).padStart(3, '0')}_future.sql`;
    writeMigrationLedger(database, runtimeFiles);

    const compatible = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
    ]);
    expect(compatible.status, compatible.stderr).toBe(0);
    expect(JSON.parse(compatible.stdout)).toMatchObject({
      schemaVersion: 'NexusApplicationRestoreCompatibilityV1',
      status: 'passed',
      databaseMaxMigration: runtimeMax,
      runtimeMaxMigration: runtimeMax,
      terminalLineageVerified: true,
      appliedMigrationCount: runtimeFiles.length,
      appliedMigrationSetSha256: migrationSetSha256(runtimeFiles),
      runtimeMigrationCount: runtimeFiles.length,
      runtimeMigrationSetSha256: migrationSetSha256(runtimeFiles),
      canonicalAppliedMigrationCount: runtimeFiles.length,
      migrationLineageId: 'canonical',
      retiredMigrationCount: 0,
    });
    const terminal = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
      '--require-terminal',
    ]);
    expect(terminal.status, terminal.stderr).toBe(0);
    expect(JSON.parse(terminal.stdout).terminalLineageVerified).toBe(true);

    execFileSync(python, [
      '-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("INSERT INTO _migrations VALUES (?)", (sys.argv[2],)); db.commit(); db.close()',
      database,
      futureMigration,
    ]);
    const incompatible = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
    ]);
    expect(incompatible.status).not.toBe(0);
    expect(incompatible.stderr).toContain(
      `database migration ${String(runtimeMax + 1).padStart(3, '0')} `
      + `exceeds runtime ${String(runtimeMax).padStart(3, '0')}`,
    );
  });

  it('rejects an unknown equal-or-lower migration instead of trusting only the maximum', () => {
    const root = privateRoot('nexus-app-dr-unknown-migration-');
    const database = path.join(root, 'database.sqlite');
    const runtimeFiles = runtimeMigrationFiles();
    writeMigrationLedger(database, [...runtimeFiles, '001_unknown_history.sql'].sort());

    const incompatible = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
    ]);
    expect(incompatible.status).not.toBe(0);
    expect(incompatible.stderr).toContain(
      'applied migrations are not an exact governed retired lineage: 001_unknown_history.sql',
    );
  });

  it('preserves prefix compatibility but rejects a partial terminal lineage', () => {
    const root = privateRoot('nexus-app-dr-partial-terminal-lineage-');
    const database = path.join(root, 'database.sqlite');
    const runtimeFiles = runtimeMigrationFiles();
    const partialFiles = runtimeFiles.slice(0, -1);
    writeMigrationLedger(database, partialFiles);

    const prefixCompatible = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
    ]);
    expect(prefixCompatible.status, prefixCompatible.stderr).toBe(0);
    expect(JSON.parse(prefixCompatible.stdout)).toMatchObject({
      status: 'passed',
      terminalLineageVerified: false,
      appliedMigrationCount: partialFiles.length,
      appliedMigrationSetSha256: migrationSetSha256(partialFiles),
      runtimeMigrationCount: runtimeFiles.length,
      runtimeMigrationSetSha256: migrationSetSha256(runtimeFiles),
      canonicalAppliedMigrationCount: partialFiles.length,
    });

    const terminal = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
      '--require-terminal',
    ]);
    expect(terminal.status).not.toBe(0);
    expect(terminal.stderr).toContain(
      `terminal runtime migration lineage is incomplete: applied ${partialFiles.length} `
      + `of ${runtimeFiles.length} canonical migrations`,
    );
  });

  it('rejects missing and no-op migration results in terminal mode', () => {
    const root = privateRoot('nexus-app-dr-terminal-failures-');
    const runtimeFiles = runtimeMigrationFiles();

    const missingDatabase = path.join(root, 'missing.sqlite');
    const missingIndex = Math.floor(runtimeFiles.length / 2);
    writeMigrationLedger(
      missingDatabase,
      runtimeFiles.filter((_, index) => index !== missingIndex),
    );
    const missing = runPython([
      sqliteHelper,
      'compatibility',
      missingDatabase,
      migrationRoot,
      migrationLineagePolicy,
      '--require-terminal',
    ]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(
      'canonical migration ledger is not an exact release prefix',
    );

    const noOpDatabase = path.join(root, 'no-op.sqlite');
    const beforeTarget = runtimeFiles.slice(0, -1);
    writeMigrationLedger(noOpDatabase, beforeTarget);
    execFileSync(python, [
      '-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("SELECT 1"); db.commit(); db.close()',
      noOpDatabase,
    ]);
    const noOp = runPython([
      sqliteHelper,
      'compatibility',
      noOpDatabase,
      migrationRoot,
      migrationLineagePolicy,
      '--require-terminal',
    ]);
    expect(noOp.status).not.toBe(0);
    expect(noOp.stderr).toContain(
      `terminal runtime migration lineage is incomplete: applied ${beforeTarget.length} `
      + `of ${runtimeFiles.length} canonical migrations`,
    );
  });

  it('accepts only the exact governed retired production lineage', () => {
    const root = privateRoot('nexus-app-dr-governed-lineage-');
    const database = path.join(root, 'database.sqlite');
    const runtimeFiles = runtimeMigrationFiles();
    const policy = JSON.parse(fs.readFileSync(migrationLineagePolicy, 'utf8'));
    const governed = policy.lineages[0];
    const retiredFiles = governed.migrations.map((entry: { file: string }) => entry.file);
    writeMigrationLedger(database, [...runtimeFiles, ...retiredFiles].sort());

    const compatible = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
      '--require-terminal',
    ]);
    expect(compatible.status, compatible.stderr).toBe(0);
    expect(JSON.parse(compatible.stdout)).toMatchObject({
      status: 'passed',
      terminalLineageVerified: true,
      appliedMigrationCount: runtimeFiles.length + retiredFiles.length,
      appliedMigrationSetSha256: migrationSetSha256(
        [...runtimeFiles, ...retiredFiles].sort(),
      ),
      runtimeMigrationCount: runtimeFiles.length,
      runtimeMigrationSetSha256: migrationSetSha256(runtimeFiles),
      canonicalAppliedMigrationCount: runtimeFiles.length,
      migrationLineageId: governed.id,
      retiredMigrationCount: retiredFiles.length,
      retiredMigrationPolicySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      retiredMigrationSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    execFileSync(python, [
      '-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM _migrations WHERE filename = ?", (sys.argv[2],)); db.commit(); db.close()',
      database,
      retiredFiles[0],
    ]);
    const partial = runPython([
      sqliteHelper,
      'compatibility',
      database,
      migrationRoot,
      migrationLineagePolicy,
    ]);
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain(
      'applied migrations are not an exact governed retired lineage',
    );
  });

  it('computes exact R2 visible-object pruning plans without touching unknown keys', () => {
    const root = privateRoot('nexus-app-dr-retention-');
    const prefix = 'nexus-hub/application';
    const hourlyListing = path.join(root, 'hourly.json');
    const hourlyOutput = path.join(root, 'hourly-delete.txt');
    const hourly = Array.from({ length: 30 }, (_, index) => ({
      Key: `${prefix}/database/hourly/nexus-db-202607${String(index + 1).padStart(2, '0')}T010000Z.sqlite.age`,
    }));
    hourly.push({ Key: `${prefix}/database/hourly/do-not-delete.txt` });
    fs.writeFileSync(hourlyListing, JSON.stringify({ Contents: hourly }));
    const count = runPython([
      retentionHelper,
      '--listing',
      hourlyListing,
      '--prefix',
      `${prefix}/database`,
      '--output',
      hourlyOutput,
      'count',
      '--tier',
      'hourly',
      '--retain',
      '24',
    ]);
    expect(count.status, count.stderr).toBe(0);
    const countKeys = fs.readFileSync(hourlyOutput, 'utf8').trim().split('\n');
    expect(countKeys).toHaveLength(6);
    expect(countKeys.some((key) => key.includes('do-not-delete'))).toBe(false);

    const releaseListing = path.join(root, 'release.json');
    const releaseOutput = path.join(root, 'release-delete.txt');
    const digest = 'a'.repeat(64);
    fs.writeFileSync(
      releaseListing,
      JSON.stringify({
        Contents: [
          {
            Key: `${prefix}/releases/v4.14.220_before-v4.14.221_20260101_000000.tar.gz.${digest}.age`,
            LastModified: '2026-01-01T00:00:00Z',
          },
          {
            Key: `${prefix}/releases/v4.14.221_before-v4.14.222_20260720_000000.tar.gz.${digest}.age`,
            LastModified: '2026-07-20T00:00:00Z',
          },
          {
            Key: `${prefix}/releases/operator-note.txt`,
            LastModified: '2020-01-01T00:00:00Z',
          },
        ],
      }),
    );
    const age = runPython([
      retentionHelper,
      '--listing',
      releaseListing,
      '--prefix',
      prefix,
      '--output',
      releaseOutput,
      'age',
      '--days',
      '90',
      '--now-epoch',
      String(Date.parse('2026-07-22T00:00:00Z') / 1000),
    ]);
    expect(age.status, age.stderr).toBe(0);
    expect(fs.readFileSync(releaseOutput, 'utf8').trim()).toContain('20260101');
    expect(fs.readFileSync(releaseOutput, 'utf8')).not.toContain('operator-note');
    expect(fs.statSync(releaseOutput).mode & 0o777).toBe(0o600);
  });

  it('keeps AWS retention read-only while preserving the explicit R2 pruning variance', () => {
    const backup = fs.readFileSync(backupScript, 'utf8');
    const retentionBlock = backup.match(
      /# BEGIN version-aware S3 retention functions\n([\s\S]*?)# END version-aware S3 retention functions/,
    )?.[1];

    expect(retentionBlock).toBeTruthy();
    expect(retentionBlock).toContain('list-object-versions');
    expect(retentionBlock).toContain('--no-paginate');
    expect(retentionBlock).toContain('--max-keys 1000');
    expect(retentionBlock).toContain('--key-marker "$key_marker"');
    expect(retentionBlock).toContain('"--version-id-marker=$version_id_marker"');
    expect(retentionBlock).toContain('collect_aws_retention_evidence');
    expect(retentionBlock).toContain(
      'aws-s3:versioned-s3)\n      collect_aws_retention_evidence',
    );
    const awsCollector = retentionBlock!.slice(
      retentionBlock!.indexOf('collect_aws_retention_evidence()'),
      retentionBlock!.indexOf('prune_visible_count_tier()'),
    );
    expect(awsCollector).toContain('"$VERSION_RETENTION_HELPER"');
    expect(awsCollector).not.toContain('delete-object');
    expect(awsCollector).not.toContain('DeletionPlan');

    const r2Count = retentionBlock!.slice(
      retentionBlock!.indexOf('prune_visible_count_tier()'),
      retentionBlock!.indexOf('apply_database_retention()'),
    );
    const r2Release = retentionBlock!.slice(
      retentionBlock!.indexOf('prune_visible_release_age()'),
      retentionBlock!.indexOf('prune_release_age()'),
    );
    for (const r2Path of [r2Count, r2Release]) {
      expect(r2Path).toContain('cloudflare-r2:r2-approved-variance');
      expect(r2Path).toContain('delete-object');
      expect(r2Path).not.toContain('--version-id');
    }
    const awsReleaseDispatch = retentionBlock!.slice(
      retentionBlock!.indexOf('prune_release_age()'),
    );
    expect(awsReleaseDispatch).toContain(
      'aws-s3:versioned-s3)\n'
      + '      # AWS expiry is owned exclusively by reviewed S3 Lifecycle rules.',
    );
    expect(awsReleaseDispatch).not.toContain('prune_versioned_release');
    expect(backup).not.toContain('execute_version_deletion_plan');
    expect(backup).not.toContain('NexusApplicationDrVersionDeletionPlanV1');
    expect(backup).not.toContain('--version-id "$version_id"');
  });

  it('preserves an opaque VersionId through explicit S3 pagination', () => {
    const backup = fs.readFileSync(backupScript, 'utf8');
    const decoderStart = backup.indexOf('aws_opaque_from_base64() {');
    const decoderEnd = backup.indexOf(
      '\naws_retain_until_from_json() {',
      decoderStart,
    );
    const listStart = backup.indexOf('list_versioned_objects() {');
    const listEnd = backup.indexOf('\naws_retention_evidence=""', listStart);
    expect(decoderStart).toBeGreaterThan(-1);
    expect(decoderEnd).toBeGreaterThan(decoderStart);
    expect(listStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);

    const root = privateRoot('nexus-app-dr-pagination-');
    const prefix = 'nexus-hub/application/database/';
    const markerKey = `${prefix}daily/nexus-db-20260724.sqlite.age`;
    const markerVersion = '--opaque-✓-%2F?generation=1|part';
    const firstPage = {
      Prefix: prefix,
      IsTruncated: true,
      NextKeyMarker: markerKey,
      NextVersionIdMarker: markerVersion,
      Versions: [],
      DeleteMarkers: [],
    };
    const secondPage = {
      Prefix: prefix,
      IsTruncated: false,
      KeyMarker: markerKey,
      VersionIdMarker: markerVersion,
      Versions: [],
      DeleteMarkers: [],
    };
    const listing = path.join(root, 'listing.json');
    const script = [
      `NEXUS_DR_PYTHON_BIN=${JSON.stringify(python)}`,
      'NEXUS_DR_S3_BUCKET=nexus-recovery',
      `tmp_dir=${JSON.stringify(root)}`,
      'die() { printf "%s\\n" "$*" >&2; exit 1; }',
      backup.slice(decoderStart, decoderEnd),
      backup.slice(listStart, listEnd),
      'page_count=0',
      'aws_s3api() {',
      '  operation="$1"; shift',
      '  [ "$operation" = list-object-versions ] || return 1',
      '  page_count=$((page_count + 1))',
      '  printf "<%s>\\n" "$@" >>"$tmp_dir/calls.log"',
      `  if [ "$page_count" -eq 1 ]; then printf '%s\\n' '${JSON.stringify(firstPage)}'`,
      `  else printf '%s\\n' '${JSON.stringify(secondPage)}'; fi`,
      '}',
      `list_versioned_objects ${JSON.stringify(prefix)} ${JSON.stringify(listing)} database`,
    ].join('\n');
    const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(fs.readFileSync(listing, 'utf8'));
    expect(value.pages).toHaveLength(2);
    expect(value.pages[0].NextVersionIdMarker).toBe(markerVersion);
    expect(fs.readFileSync(path.join(root, 'calls.log'), 'utf8')).toContain(
      `<--version-id-marker=${markerVersion}>`,
    );
  });

  it('uses conditional checksummed COMPLIANCE writes and exact post-write evidence', () => {
    const backup = fs.readFileSync(backupScript, 'utf8');
    const uploadStart = backup.indexOf('put_encrypted_object() {');
    const uploadEnd = backup.indexOf('created_epoch="$(date -u +%s)"', uploadStart);
    const upload = backup.slice(uploadStart, uploadEnd);
    const databaseStart = backup.indexOf('hourly_database_version_id=""');
    const databaseEnd = backup.indexOf(
      '# BEGIN version-aware S3 retention functions',
      databaseStart,
    );
    const databaseUpload = backup.slice(databaseStart, databaseEnd);

    expect(uploadStart).toBeGreaterThan(-1);
    expect(uploadEnd).toBeGreaterThan(uploadStart);
    expect(upload).toContain("--if-none-match '*'");
    expect(upload).toContain('--checksum-algorithm SHA256');
    expect(upload).toContain('--object-lock-mode COMPLIANCE');
    expect(upload).toContain('--object-lock-retain-until-date "$retain_until"');
    expect(upload).toContain('ConditionalRequestConflict');
    expect(upload).toContain('PreconditionFailed');
    expect(upload).toContain('[ "$attempt" -eq 1 ]');
    expect(upload).toContain('verify_existing_period_object');
    expect(upload).toContain('verify_existing_exact_object');
    expect(backup).toContain('--checksum-mode ENABLED');
    expect(backup).toContain('ChecksumSHA256');
    expect(backup).toContain('ObjectLockMode');
    expect(upload).toContain('VersionId');

    expect(databaseUpload).toContain('"" 2 fail');
    expect(databaseUpload).toContain('"" 8 period-daily');
    expect(databaseUpload).toContain('"" 35 period-weekly');
    expect(databaseUpload).toContain('"" 190 period-monthly');
    expect(backup).toContain(
      'required release escrow must be bound to a complete promotion recovery transaction',
    );
    expect(backup).toContain(
      '+rollback-escrow-${RECOVERY_ESCROW_ID}+phase-${RECOVERY_ESCROW_PHASE}.tar.gz',
    );
    expect(backup).toContain('(int(sys.argv[2]) + 1) * 86400');
    expect(backup).toContain('put-object-retention');
    expect(backup).toContain('--version-id="$existing_version_id"');
    expect(backup).toContain(
      'existing exact object retention does not cover this confirmation',
    );
    expect(databaseUpload).toContain(
      'hourly_database_version_id="$LAST_VERIFIED_VERSION_ID"',
    );
    expect(backup).toContain('"databaseRetentionEvidence": retention_evidence');
    expect(backup).toContain('NexusApplicationDrRetentionEvidenceV1');
    expect(backup).toContain('verify_aws_retention_evidence_objects');
    expect(backup).toContain('"selectedObjectsVerified"');
    expect(backup).toContain('databaseRetentionPolicy=24,7,4,6');
    expect(backup).toContain(
      'databaseRetentionMaturity=$database_retention_maturity',
    );
    expect(backup).not.toContain('databaseRetention=24,7,4,6');
    expect(backup).toContain('--maturity-seal "$maturity_seal"');
    expect(backup).toContain('confirm_database_after_retention');
    expect(backup).toContain(
      'get_args+=("--version-id=$hourly_database_version_id")',
    );
  });

  it('fails closed across governed AWS write-once collision outcomes', () => {
    const root = privateRoot('nexus-app-dr-write-once-');
    const backup = fs.readFileSync(backupScript, 'utf8');
    const functionsStart = backup.indexOf('aws_version_id_from_json() {');
    const functionsEnd = backup.indexOf(
      'created_epoch="$(date -u +%s)"',
      functionsStart,
    );
    expect(functionsStart).toBeGreaterThan(-1);
    expect(functionsEnd).toBeGreaterThan(functionsStart);
    const governedFunctions = backup.slice(functionsStart, functionsEnd);
    const rollover = spawnSync('/bin/bash', ['-c', [
      `NEXUS_DR_PYTHON_BIN=${JSON.stringify(python)}`,
      governedFunctions,
      'database_key_suffixes_from_epoch 1798761599',
      'database_key_suffixes_from_epoch 1798761600',
    ].join('\n')], { encoding: 'utf8' });
    expect(rollover.status, rollover.stderr).toBe(0);
    expect(rollover.stdout.trim().split('\n')).toEqual([
      '20261231T235959Z\t20261231\t2026-W53\t202612',
      '20270101T000000Z\t20270101\t2026-W53\t202701',
    ]);
    expect(backup).not.toContain('date -u +%Y%m%d');
    expect(backup).not.toContain('date -u +%G-W%V');
    const encrypted = path.join(root, 'recovery-point.age');
    fs.writeFileSync(encrypted, 'encrypted-recovery-point\n', { mode: 0o600 });
    const encryptedSha = createHash('sha256')
      .update(fs.readFileSync(encrypted))
      .digest('hex');
    const checksum = createHash('sha256')
      .update(fs.readFileSync(encrypted))
      .digest('base64');
    const plaintextSha = 'b'.repeat(64);
    const createdEpoch = Date.parse('2026-07-24T00:00:00Z') / 1000;
    const opaqueVersionId = '--opaque-✓-%2F?generation=1|part';
    const validHead = {
      ContentLength: fs.statSync(encrypted).size,
      ChecksumSHA256: checksum,
      VersionId: opaqueVersionId,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: '2026-08-02T00:00:00Z',
      Metadata: {
        'encrypted-sha256': encryptedSha,
        'plaintext-sha256': plaintextSha,
        'schema-version': 'NexusApplicationSqliteRecoveryPointV1',
        'created-epoch': String(createdEpoch),
      },
    };
    const harness = path.join(root, 'write-once-harness.sh');
    fs.writeFileSync(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -u',
        'scenario="$1"',
        'tmp_dir="$2"',
        'encrypted="$3"',
        'head_json="$4"',
        'counter_file="$5"',
        `NEXUS_DR_PYTHON_BIN=${JSON.stringify(python)}`,
        'NEXUS_DR_STORAGE_PROVIDER=aws-s3',
        'NEXUS_DR_S3_BUCKET=nexus-recovery',
        'NEXUS_DR_S3_PREFIX=nexus-hub/application',
        'database_root="$NEXUS_DR_S3_PREFIX/database"',
        'die() { printf "%s\\n" "$*" >&2; exit 1; }',
        'size_file() { wc -c <"$1" | tr -d "[:space:]"; }',
        governedFunctions,
        'aws_s3api() {',
        '  local operation="$1" count=0',
        '  shift',
        '  printf "%s\\n" "$operation" >>"$tmp_dir/operations.log"',
        '  {',
        '    printf "%s" "$operation"',
        '    printf " <%s>" "$@"',
        '    printf "\\n"',
        '  } >>"$tmp_dir/calls.log"',
        '  case "$operation" in',
        '    put-object)',
        '      [ ! -f "$counter_file" ] || count="$(<"$counter_file")"',
        '      count=$((count + 1))',
        '      printf "%s\\n" "$count" >"$counter_file"',
        '      case "$scenario" in',
        '        successful-put)',
        `          printf '%s\\n' '${JSON.stringify({ VersionId: opaqueVersionId })}'`,
        '          return 0',
        '          ;;',
        '        retry-then-success)',
        '          if [ "$count" -eq 1 ]; then',
        '            printf "An error occurred (ConditionalRequestConflict) when calling the PutObject operation\\n" >&2',
        '            return 1',
        '          fi',
        `          printf '%s\\n' '${JSON.stringify({ VersionId: opaqueVersionId })}'`,
        '          return 0',
        '          ;;',
        '        retry-exhausted)',
        '          printf "An error occurred (ConditionalRequestConflict) when calling the PutObject operation\\n" >&2',
        '          return 1',
        '          ;;',
        '        access-denied)',
        '          printf "An error occurred (AccessDenied) when calling the PutObject operation\\n" >&2',
        '          return 1',
        '          ;;',
        '        valid-period-412|invalid-period-412|exact-resume-412|exact-resume-stale-head|hourly-collision)',
        '          printf "An error occurred (PreconditionFailed) when calling the PutObject operation\\n" >&2',
        '          return 1',
        '          ;;',
        '      esac',
        '      ;;',
        '    put-object-retention)',
        '      if [ "$scenario" = exact-resume-412 ]; then',
        '        "$NEXUS_DR_PYTHON_BIN" - "$head_json" <<\'PY\'',
        'import json',
        'from pathlib import Path',
        'import sys',
        'path = Path(sys.argv[1])',
        'value = json.loads(path.read_text(encoding="utf-8"))',
        'value["ObjectLockRetainUntilDate"] = "2026-08-03T00:00:00Z"',
        'path.write_text(json.dumps(value), encoding="utf-8")',
        'PY',
        '      fi',
        '      return 0',
        '      ;;',
        '    head-object)',
        '      command cat "$head_json"',
        '      return 0',
        '      ;;',
        '  esac',
        '  printf "unexpected mocked S3 operation: %s\\n" "$operation" >&2',
        '  return 1',
        '}',
        'case "$scenario" in',
        '  valid-period-412|invalid-period-412)',
        '    key="$database_root/daily/nexus-db-20260724.sqlite.age"',
        '    collision_policy=period-daily',
        '    ;;',
        '  hourly-collision)',
        '    key="$database_root/hourly/nexus-db-20260724T000000Z.sqlite.age"',
        '    collision_policy=fail',
        '    ;;',
        '  *)',
        '    key="$NEXUS_DR_S3_PREFIX/releases/exact-recovery-point.age"',
        '    collision_policy=exact',
        '    ;;',
        'esac',
        'put_encrypted_object "$key" "$encrypted" "$6" "$7" \\',
        '  NexusApplicationSqliteRecoveryPointV1 "$8" "" 8 "$collision_policy"',
        'printf "verified=%s\\n" "$LAST_VERIFIED_VERSION_ID"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );

    const runScenario = (
      scenario: string,
      head: Record<string, unknown> = validHead,
      invocationEpoch = createdEpoch,
    ) => {
      const headPath = path.join(root, `${scenario}-head.json`);
      const counterPath = path.join(root, `${scenario}-count.txt`);
      fs.writeFileSync(headPath, JSON.stringify(head), { mode: 0o600 });
      const result = spawnSync('/bin/bash', [
        harness,
        scenario,
        root,
        encrypted,
        headPath,
        counterPath,
        encryptedSha,
        plaintextSha,
        String(invocationEpoch),
      ], { encoding: 'utf8' });
      const count = fs.existsSync(counterPath)
        ? Number(fs.readFileSync(counterPath, 'utf8').trim())
        : 0;
      const operationsPath = path.join(root, 'operations.log');
      const operations = fs.existsSync(operationsPath)
        ? fs.readFileSync(operationsPath, 'utf8').trim().split('\n')
        : [];
      const callsPath = path.join(root, 'calls.log');
      const calls = fs.existsSync(callsPath)
        ? fs.readFileSync(callsPath, 'utf8').trim().split('\n')
        : [];
      fs.rmSync(operationsPath, { force: true });
      fs.rmSync(callsPath, { force: true });
      return { ...result, count, operations, calls };
    };

    const successful = runScenario('successful-put');
    expect(successful.status, successful.stderr).toBe(0);
    expect(successful.stdout).toContain(`verified=${opaqueVersionId}`);
    expect(successful.count).toBe(1);
    const successfulPut = successful.calls.find(
      (call) => call.startsWith('put-object '),
    );
    expect(successfulPut).toContain('<--checksum-algorithm> <SHA256>');
    expect(successfulPut).toContain('<--if-none-match> <*>');
    expect(successfulPut).toContain('<--object-lock-mode> <COMPLIANCE>');
    expect(successfulPut).toContain('<--object-lock-retain-until-date>');
    expect(successfulPut).toContain('<--metadata>');
    const successfulHead = successful.calls.find(
      (call) => call.startsWith('head-object '),
    );
    expect(successfulHead).toContain('<--checksum-mode> <ENABLED>');
    expect(successfulHead).toContain(
      `<--version-id=${opaqueVersionId}>`,
    );

    const existingPeriod = runScenario('valid-period-412');
    expect(existingPeriod.status, existingPeriod.stderr).toBe(0);
    expect(existingPeriod.stdout).toContain(`verified=${opaqueVersionId}`);
    expect(existingPeriod.count).toBe(1);

    const exactByteLimit = runScenario('valid-period-412', {
      ...validHead,
      VersionId: 'é'.repeat(512),
    });
    expect(exactByteLimit.status, exactByteLimit.stderr).toBe(0);

    for (const invalidVersionId of [
      null,
      'null',
      'unsafe\nversion',
      'unsafe\u007fversion',
      `${'é'.repeat(512)}a`,
    ]) {
      const invalidVersion = runScenario('valid-period-412', {
        ...validHead,
        VersionId: invalidVersionId,
      });
      expect(invalidVersion.status).not.toBe(0);
      expect(invalidVersion.stderr).toContain(
        'existing daily recovery point did not verify',
      );
    }

    const invalidPeriod = runScenario('invalid-period-412', {
      ...validHead,
      ChecksumSHA256: Buffer.alloc(32).toString('base64'),
    });
    expect(invalidPeriod.status).not.toBe(0);
    expect(invalidPeriod.stderr).toContain(
      'existing daily recovery point did not verify',
    );

    const resumedExact = runScenario('exact-resume-412', {
      ...validHead,
      ObjectLockRetainUntilDate: '2026-08-01T00:00:00Z',
    }, createdEpoch + 86_400);
    expect(resumedExact.status, resumedExact.stderr).toBe(0);
    expect(resumedExact.operations).toContain('put-object-retention');
    expect(resumedExact.operations.filter(
      (operation) => operation === 'head-object',
    )).toHaveLength(2);

    const staleExtensionHead = runScenario('exact-resume-stale-head', {
      ...validHead,
      ObjectLockRetainUntilDate: '2026-08-01T00:00:00Z',
    }, createdEpoch + 86_400);
    expect(staleExtensionHead.status).not.toBe(0);
    expect(staleExtensionHead.stderr).toContain(
      'existing exact object retention does not cover this confirmation',
    );

    const retried = runScenario('retry-then-success');
    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.count).toBe(2);

    const retryExhausted = runScenario('retry-exhausted');
    expect(retryExhausted.status).not.toBe(0);
    expect(retryExhausted.count).toBe(2);
    expect(retryExhausted.stderr).toContain(
      'governed AWS put-object failed with code ConditionalRequestConflict',
    );

    const forbidden = runScenario('access-denied');
    expect(forbidden.status).not.toBe(0);
    expect(forbidden.count).toBe(1);
    expect(forbidden.stderr).toContain(
      'governed AWS put-object failed with code AccessDenied',
    );

    const hourlyCollision = runScenario('hourly-collision');
    expect(hourlyCollision.status).not.toBe(0);
    expect(hourlyCollision.stderr).toContain(
      'write-once object key already exists',
    );
  });

  it('requires provider-explicit versioned S3 or an approved R2 lock variance', () => {
    const root = privateRoot('nexus-app-dr-storage-controls-');
    const evidencePath = path.join(root, 'controls.json');
    const now = Date.parse('2026-07-23T12:00:00Z') / 1000;
    const common = {
      schema: 'nexus.application-dr-storage-controls.v1',
      endpoint: 'https://objects.example.invalid',
      bucket: 'nexus-recovery',
      prefix: 'nexus-hub/application',
      verifiedAt: '2026-07-23T11:00:00Z',
      verificationReference: 'private-evidence:storage-controls-20260723',
    };
    const args = [
      storageControlHelper,
      '--evidence',
      evidencePath,
      '--endpoint',
      common.endpoint,
      '--bucket',
      common.bucket,
      '--prefix',
      common.prefix,
      '--now-epoch',
      String(now),
    ];

    fs.writeFileSync(evidencePath, JSON.stringify({
      ...common,
      provider: 'aws-s3',
      controlMode: 'versioned-s3',
      versioning: { supported: true, status: 'enabled' },
      releasePrefixLock: {
        control: 's3-object-lock',
        status: 'enabled',
        prefix: 'nexus-hub/application/releases/',
        retentionDays: 90,
      },
    }));
    const s3 = runPython([
      ...args,
      '--provider',
      'aws-s3',
      '--control-mode',
      'versioned-s3',
    ]);
    expect(s3.status, s3.stderr).toBe(0);
    expect(JSON.parse(s3.stdout)).toMatchObject({
      status: 'passed',
      provider: 'aws-s3',
      versioningVerified: true,
      approvedVariance: false,
      releasePrefixLockVerified: true,
    });

    const r2Evidence = {
      ...common,
      provider: 'cloudflare-r2',
      controlMode: 'r2-approved-variance',
      versioning: { supported: false, status: 'not-supported' },
      releasePrefixLock: {
        control: 'cloudflare-r2-prefix-lock',
        status: 'enabled',
        prefix: 'nexus-hub/application/releases/',
        retentionDays: 90,
      },
      varianceApproval: {
        approvedBy: 'owner',
        approvedAt: '2026-07-23T10:00:00Z',
        reason: 'r2-has-no-s3-versioning',
      },
    };
    fs.writeFileSync(evidencePath, JSON.stringify(r2Evidence));
    const r2 = runPython([
      ...args,
      '--provider',
      'cloudflare-r2',
      '--control-mode',
      'r2-approved-variance',
    ]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(JSON.parse(r2.stdout)).toMatchObject({
      status: 'passed',
      provider: 'cloudflare-r2',
      versioningVerified: false,
      approvedVariance: true,
      releasePrefixLockVerified: true,
    });

    const unapprovedR2 = Object.fromEntries(
      Object.entries(r2Evidence).filter(([key]) => key !== 'varianceApproval'),
    );
    fs.writeFileSync(evidencePath, JSON.stringify(unapprovedR2));
    const missingApproval = runPython([
      ...args,
      '--provider',
      'cloudflare-r2',
      '--control-mode',
      'r2-approved-variance',
    ]);
    expect(missingApproval.status).not.toBe(0);
    expect(missingApproval.stderr).toContain('fields do not match the governed schema');

    fs.writeFileSync(evidencePath, JSON.stringify({
      ...r2Evidence,
      versioning: { supported: true, status: 'enabled' },
    }));
    const fakeR2Versioning = runPython([
      ...args,
      '--provider',
      'cloudflare-r2',
      '--control-mode',
      'r2-approved-variance',
    ]);
    expect(fakeR2Versioning.status).not.toBe(0);
    expect(fakeR2Versioning.stderr).toContain(
      'R2 variance must explicitly record unavailable S3 versioning',
    );
  });

  it('safely extracts the exact release fixture and rejects traversal archives', () => {
    const root = privateRoot('nexus-app-dr-archive-');
    const fixture = path.join(root, 'fixture');
    for (const directory of ['dist', 'migrations', 'prompts', 'content-engine', 'data', 'catalog']) {
      fs.mkdirSync(path.join(fixture, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(fixture, 'dist/index.js'), 'runtime');
    fs.writeFileSync(path.join(fixture, 'migrations/001.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(fixture, 'prompts/default.md'), 'prompt');
    fs.writeFileSync(path.join(fixture, 'content-engine/main.py'), 'print(1)');
    fs.writeFileSync(path.join(fixture, 'content-engine/config.py'), 'VALUE=1');
    fs.writeFileSync(path.join(fixture, 'content-engine/requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(fixture, 'data/bot.db'), 'fixture');
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '4.14.230' }));
    fs.writeFileSync(path.join(fixture, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(fixture, 'ecosystem.config.js'), 'module.exports={}');
    fs.writeFileSync(
      path.join(fixture, '.nexus-backup-manifest.json'),
      JSON.stringify({ schema: 'nexus.release-backup.v1', archivedVersion: '4.14.230' }),
    );
    const archive = path.join(root, 'release.tar.gz');
    execFileSync('tar', [
      'czf',
      archive,
      '-C',
      fixture,
      'dist',
      'migrations',
      'prompts',
      'content-engine',
      'data',
      'catalog',
      'package.json',
      'package-lock.json',
      'ecosystem.config.js',
      '.nexus-backup-manifest.json',
    ]);
    fs.chmodSync(archive, 0o600);
    const destination = path.join(root, 'restored');
    fs.mkdirSync(destination, { mode: 0o700 });
    const extracted = runPython([archiveHelper, archive, destination]);
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(JSON.parse(extracted.stdout)).toMatchObject({
      schemaVersion: 'NexusReleaseRollbackEscrowV1',
      archivedVersion: '4.14.230',
    });
    expect(fs.statSync(path.join(destination, 'package.json')).mode & 0o777).toBe(0o600);

    const hostile = path.join(root, 'hostile.tar.gz');
    execFileSync(
      python,
      [
        '-c',
        "import io,tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('../escape'); i.size=1; t.addfile(i,io.BytesIO(b'x')); t.close()",
        hostile,
      ],
    );
    fs.chmodSync(hostile, 0o600);
    const hostileDestination = path.join(root, 'hostile-restored');
    fs.mkdirSync(hostileDestination, { mode: 0o700 });
    const rejected = runPython([archiveHelper, hostile, hostileDestination]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('unsafe archive path');
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  });

  it('keeps encryption, retention, root-only scheduling, and drill targets fail closed', () => {
    const backup = fs.readFileSync(backupScript, 'utf8');
    const restore = fs.readFileSync(restoreScript, 'utf8');
    const harness = fs.readFileSync(isolatedHarness, 'utf8');
    const timer = fs.readFileSync(
      path.join(opsRoot, 'systemd/nexus-application-dr-backup.timer'),
      'utf8',
    );
    const service = fs.readFileSync(
      path.join(opsRoot, 'systemd/nexus-application-dr-backup.service'),
      'utf8',
    );
    const config = fs.readFileSync(path.join(opsRoot, 'backup.env.example'), 'utf8');
    const awsConfig = fs.readFileSync(path.join(opsRoot, 'aws-config.example'), 'utf8');
    const runbook = fs.readFileSync(path.join(opsRoot, 'OPERATIONS.txt'), 'utf8');
    const currentReleaseState = fs.readFileSync(
      path.resolve('docs/release/CURRENT_RELEASE_STATE.md'),
      'utf8',
    );
    const runtimeStandard = fs.readFileSync(
      path.resolve('docs/engineering/runtime-and-observability-standard.md'),
      'utf8',
    );
    const restoreReadiness = JSON.parse(fs.readFileSync(
      path.join(opsRoot, 'restore-readiness.json'),
      'utf8',
    ));
    const installLayout = fs.readFileSync(path.join(opsRoot, 'install-layout.tsv'), 'utf8');

    expect(backup).toContain('"$SQLITE_HELPER" snapshot');
    expect(backup).toContain('age --encrypt --recipient');
    expect(backup).toContain('apply_database_retention');
    expect(backup).toContain('prune_visible_count_tier hourly 24 "$hourly_key"');
    expect(backup).toContain('prune_visible_count_tier daily 7 "$daily_key"');
    expect(backup).toContain('prune_visible_count_tier weekly 4 "$weekly_key"');
    expect(backup).toContain('prune_visible_count_tier monthly 6 "$monthly_key"');
    expect(backup).toContain('age --days 90');
    expect(backup).toContain('"$VERSION_RETENTION_HELPER"');
    expect(backup).toContain('--recovery-escrow-id');
    expect(backup).toContain('--recovery-escrow-phase');
    expect(backup).toContain(
      '+escrow-${RECOVERY_ESCROW_ID}+phase-${RECOVERY_ESCROW_PHASE}.tar.gz',
    );
    expect(backup).toContain('"escrowId": recovery_escrow_id');
    expect(backup).toContain('"escrowPhase": recovery_escrow_phase');
    expect(backup).toContain('"retainUntil": recovery_retain_until or None');
    expect(backup).toContain('"objectVersionId": recovery_version_id or None');
    expect(backup).toContain(
      '"retentionVariance": (',
    );
    expect(backup).toContain(
      '"$required_release_key" "$required_release_version_id" \\\n'
      + '  "$required_recovery_key" "$required_recovery_version_id"',
    );
    expect(backup).toContain(
      'get_args+=("--version-id=$required_recovery_version_id")',
    );
    expect(backup).toContain('confirm_current_recovery_after_retention');
    expect(backup).not.toContain('execute_version_deletion_plan');
    expect(backup).not.toContain('--version-id "$version_id"');
    const releasePrune = backup.lastIndexOf(
      '\nprune_release_age \\\n',
    );
    const postPruneConfirmation = backup.lastIndexOf(
      '\n  confirm_current_recovery_after_retention\n',
    );
    expect(releasePrune).toBeGreaterThan(-1);
    expect(postPruneConfirmation).toBeGreaterThan(releasePrune);
    expect(backup).toContain('rollback_archives=("$NEXUS_DR_ROLLBACK_DIR"/v*.tar.gz)');
    expect(backup).toContain('private_root_file "$CONFIG" "configuration"');
    expect(backup).toContain('must be root:root mode 0600');
    expect(backup).toContain('S3 endpoint must be a credential-free HTTPS origin');
    expect(backup).toContain('NEXUS_DR_STORAGE_PROVIDER');
    expect(backup).toContain('"$STORAGE_CONTROL_HELPER"');
    expect(backup).toContain(
      '[ "$(dirname -- "$REQUIRED_RECOVERY_RUNTIME")" = '
      + '/srv/nexus-release/production/releases ]',
    );
    expect(backup).toContain(
      'required recovery runtime must be an exact governed production release directory',
    );
    expect(backup).not.toContain('/home/dominguez');
    expect(backup).not.toContain('remote-create-release-backup.sh');

    expect(timer).toContain('OnCalendar=*-*-* *:05:00 UTC');
    expect(timer).toContain('RandomizedDelaySec=0');
    expect(timer).toContain('Persistent=true');
    expect(service).toContain('User=root');
    expect(service).toContain('StateDirectoryMode=0700');
    expect(service).toContain('TimeoutStartSec=50min');
    expect(service).toContain('ProtectSystem=strict');

    expect(config).toContain('NEXUS_DR_S3_ENDPOINT=https://');
    expect(config).toContain('NEXUS_DR_RESTORE_HARNESS=');
    expect(config).toContain('NEXUS_DR_STORAGE_PROVIDER=aws-s3');
    expect(config).toContain('NEXUS_DR_STORAGE_CONTROL_MODE=versioned-s3');
    expect(config).toContain('NEXUS_DR_S3_PREFIX=nexus-hub/application');
    expect(config).toContain('AWS_SHARED_CREDENTIALS_FILE=/dev/null');
    expect(config).toContain('AWS_PROFILE=nexus-application-dr-backup');
    expect(config).toContain(
      'NEXUS_DR_AWS_BACKUP_ROLE_ARN=arn:aws:iam::111122223333:role/replace-with-backup-role-path-and-name',
    );
    expect(config).toContain(
      'NEXUS_DR_RESTORE_AWS_PROFILE=nexus-application-dr-restore',
    );
    expect(config).toContain(
      'NEXUS_DR_AWS_RESTORE_ROLE_ARN=arn:aws:iam::111122223333:role/replace-with-restore-role-path-and-name',
    );
    expect(config).not.toMatch(/^AWS_ACCESS_KEY_ID=/m);
    expect(config).not.toMatch(/^AWS_SECRET_ACCESS_KEY=/m);
    expect(awsConfig).toContain('[profile nexus-application-dr-backup]');
    expect(awsConfig).toContain('[profile nexus-application-dr-restore]');
    expect(awsConfig).toContain('aws_signing_helper credential-process');
    expect(backup).toContain('"$AWS_CREDENTIAL_BOUNDARY_HELPER"');
    expect(backup).toContain('--helper-sha256 "$NEXUS_DR_AWS_SIGNING_HELPER_SHA256"');
    expect(backup).toContain('--expected-role-arn "$NEXUS_DR_AWS_BACKUP_ROLE_ARN"');
    expect(backup).toContain(
      'expected_aws_s3_endpoint="https://s3.${AWS_REGION:-us-east-1}.amazonaws.com"',
    );
    expect(restore).toContain('export AWS_PROFILE="$NEXUS_DR_RESTORE_AWS_PROFILE"');
    expect(restore).toContain('"$AWS_CREDENTIAL_BOUNDARY_HELPER"');
    expect(restore).toContain('--expected-role-arn "$NEXUS_DR_AWS_RESTORE_ROLE_ARN"');
    expect(restore).toContain(
      '"$NEXUS_DR_AWS_BACKUP_ROLE_ARN" != "$NEXUS_DR_AWS_RESTORE_ROLE_ARN"',
    );
    expect(config).toContain('NEXUS_DR_DRILL_USER=nexus-drill');
    expect(config).toContain(
      'NEXUS_DR_DATABASE_PATH=/srv/nexus-release/production/data/bot.db',
    );
    expect(config).toContain(
      'NEXUS_DR_ROLLBACK_DIR=/home/dominguez/backups/nexushub',
    );
    expect(config).not.toContain(
      'NEXUS_DR_DATABASE_PATH=/home/dominguez/telegram-hub-bot/data/bot.db',
    );
    expect(config).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(restore).toContain('RPO breach');
    expect(restore).toContain('technical restore target breached');
    expect(restore).toContain('age < 0 or age > 3600');
    expect(restore).toContain('technical_elapsed_ns <= 1800000000000');
    expect(restore).toContain('--database-version-id');
    expect(restore).toContain('--release-version-id');
    expect(restore).toContain(
      '\\+phase-(pre-mutation|post-soak)\\.tar\\.gz',
    );
    expect(restore).toContain(
      '\\+phase-(?:pre-mutation|post-soak)\\.tar\\.gz',
    );
    expect(restore).toContain('database_head_args+=("--version-id=$DATABASE_VERSION_ID")');
    expect(restore).toContain('release_head_args+=("--version-id=$RELEASE_VERSION_ID")');
    expect(restore).toContain('release key does not match its bound plaintext identity');
    expect(restore).toContain('--range "bytes=0-$database_range_end"');
    expect(restore).toContain('downloaded encrypted recovery runtime size differs from exact HEAD');
    expect(restore).toContain('run_harness boot');
    expect(restore).toContain('run_harness smoke >"$tmp_dir/application-smoke.json"');
    expect(restore).toContain('run_harness stop');
    expect(restore).toContain('run_dependency_helper install');
    expect(restore).toContain('unshare --mount --net --fork');
    expect(restore).toContain('--kill-child=TERM');
    expect(restore).toContain('isolated process cleanup failed; preserved manual-cleanup target');
    expect(restore).toContain('trusted_root_path_chain');
    expect(restore).toContain('NEXUS_DRILL_USER="$NEXUS_DR_DRILL_USER"');
    expect(restore).toContain('"networkIndependentDependenciesVerified": True');
    expect(restore).toContain('release-database-compatibility.json');
    expect(restore).toContain(
      'MIGRATION_LINEAGE_POLICY="$SCRIPT_DIR/production-migration-lineages.json"',
    );
    expect(restore).toContain(
      '"$database_plain" "$runtime/migrations" "$MIGRATION_LINEAGE_POLICY"',
    );
    expect(restore).toContain('"$SQLITE_HELPER" snapshot');
    expect(restore).toContain('--require-terminal');
    expect(restore).toContain('"postMigrationWalStateCapturedByOnlineBackup": True');
    expect(installLayout).toContain(
      'config/production-migration-lineages.json\t'
      + '/usr/local/libexec/nexus-application-dr/production-migration-lineages.json'
      + '\troot:root\t0644',
    );
    expect(installLayout).toContain(
      'scripts/application-dr-version-retention.py\t'
      + '/usr/local/libexec/nexus-application-dr/application-dr-version-retention.py'
      + '\troot:root\t0644',
    );
    expect(restore).toContain(
      'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN',
    );
    expect(restore).toContain('unset AWS_PROFILE AWS_DEFAULT_PROFILE');
    expect(harness).toContain('unshare --mount --net --pid --fork --mount-proc');
    expect(harness).toContain('mount -o remount,ro /');
    expect(harness).toContain('--bounding-set=-all');
    expect(harness).toContain('env -i');
    expect(harness).toContain('CONTENT_ENGINE_ENABLED=true');
    expect(harness).not.toContain('CONTENT_ENGINE_ENABLED=false');
    expect(harness).toContain('"$MOUNTPOINT/content-engine/.venv/bin/python3.12"');
    expect(harness).toContain('"http://127.0.0.1:$CONTENT_PORT/health"');
    expect(harness).toContain('"http://127.0.0.1:$CONTENT_PORT/ready"');
    expect(harness).toContain('"NexusApplicationDrillSmokeV1"');
    expect(restore).toContain('"contentEngineBootVerified": True');
    expect(restore).toContain('"processIdentities": application_smoke["processIdentities"]');
    expect(harness).toContain('invalid drill credential was not rejected');
    expect(harness).toContain('representative["totalUsers"] != expected_user_count');
    expect(harness).not.toContain('/home/dominguez');
    expect(runbook).toContain('Adding them to the repository does not');
    expect(runbook).toContain('The drill is not a production restore command');
    expect(runbook).toContain('latest ten bundles');
    expect(runbook).toContain('Quarterly restore-drill readiness is MANUAL_REQUIRED');
    expect(runbook).toContain('AWS_SHARED_CREDENTIALS_FILE=/dev/null');
    expect(runbook).toContain('NEXUS_DR_AWS_SIGNING_HELPER_SHA256');
    expect(runbook).toContain('nexus-application-dr-restore');
    expect(runbook).toContain('RolesAnywhereActivation=DISABLED');
    expect(runbook).toContain('application-dr-crl-parameters.mjs');
    expect(runbook).toContain('300,000-byte');
    expect(runbook).toContain('UsePreviousValue');
    expect(runbook).toContain('--operation rotate');
    expect(runbook).toContain('superset of every previously');
    expect(runbook).toContain('900-second credentials');
    expect(runbook).toContain('does not consult OCSP or CRL distribution points');
    expect(runbook).toContain('cloudflare-r2:r2-approved-variance');
    expect(runbook).toContain('s3:ListBucketVersions');
    expect(runbook).toContain('DeleteObjectVersion');
    expect(runbook).toMatch(/S3\s+Lifecycle is the only AWS cleanup actor/u);
    expect(runbook).toContain('auto-pagination is disabled');
    expect(runbook).toContain('private network, mount, and PID namespaces');
    expect(currentReleaseState).toContain(
      'signed root-owned promotion transaction is the sole runtime or',
    );
    expect(currentReleaseState).toContain(
      '`scripts/rollback.sh` and `scripts/restore.sh` commands remain available only',
    );
    expect(currentReleaseState).toContain('read-only dry-run inventory');
    expect(runtimeStandard).toContain(
      'signed root-owned promotion transaction is the sole path that',
    );
    expect(runtimeStandard).toContain(
      '`scripts/restore.sh` retain read-only dry-run inventory only',
    );
    expect(runtimeStandard).not.toContain(
      'restore tooling remain available\n   for emergency predecessor recovery',
    );
    expect(restoreReadiness).toEqual({
      schema: 'nexus.application-dr-restore-readiness.v1',
      status: 'MANUAL_REQUIRED',
      repositoryHarnessImplemented: true,
      quarterlyRestoreDrillReady: false,
      reason: 'server_provisioning_storage_control_evidence_and_first_retained_restore_drill_required',
      harness: 'scripts/application-dr-isolated-harness.sh',
      manualEvidenceRequired: [
        'root_installed_application_dr_assets_and_dedicated_nologin_user',
        'provider_control_plane_storage_evidence',
        'off_host_age_identity',
        'successful_retained_quarterly_restore_evidence',
      ],
    });
  });

  it('accepts safe opaque UTF-8 restore VersionIds and enforces their byte limit', () => {
    const source = fs.readFileSync(restoreScript, 'utf8');
    const start = source.indexOf('aws_version_id_is_safe() {');
    const end = source.indexOf(
      '\nif [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then',
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const helper = source.slice(start, end);
    const run = (value: string) => spawnSync('/bin/bash', [
      '-c',
      [
        `NEXUS_DR_PYTHON_BIN=${JSON.stringify(python)}`,
        helper,
        'aws_version_id_is_safe "$1"',
      ].join('\n'),
      'restore-version-id-test',
      value,
    ], { encoding: 'utf8' });

    for (const value of [
      '--opaque-✓-%2F?generation=1|part',
      'é'.repeat(512),
    ]) {
      const accepted = run(value);
      expect(accepted.status, accepted.stderr).toBe(0);
    }
    for (const value of [
      '',
      'null',
      'unsafe\nversion',
      'unsafe\u007fversion',
      `${'é'.repeat(512)}a`,
    ]) {
      expect(run(value).status).not.toBe(0);
    }

    expect(source).toContain('len(encoded_version_id)');
    expect(source).not.toContain('[A-Za-z0-9._~+=:/-]{1,1024}');
  });
});
