import { execFileSync, spawnSync } from 'node:child_process';
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
const isolatedHarness = path.resolve('scripts/application-dr-isolated-harness.sh');
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

describe('Nexus application disaster-recovery assets', () => {
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
    const migrations = path.join(root, 'migrations');
    fs.mkdirSync(migrations, { mode: 0o700 });
    fs.writeFileSync(path.join(migrations, '001_initial.sql'), 'SELECT 1;\n');
    fs.writeFileSync(path.join(migrations, '002_current.sql'), 'SELECT 2;\n');
    execFileSync(python, ['-c', [
      'import sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1])',
      "db.execute('CREATE TABLE _migrations(filename TEXT PRIMARY KEY)')",
      "db.executemany('INSERT INTO _migrations VALUES (?)', [('001_initial.sql',),('002_current.sql',)])",
      'db.commit()',
      'db.close()',
    ].join(';'), database]);
    fs.chmodSync(database, 0o600);

    const compatible = runPython([sqliteHelper, 'compatibility', database, migrations]);
    expect(compatible.status, compatible.stderr).toBe(0);
    expect(JSON.parse(compatible.stdout)).toMatchObject({
      schemaVersion: 'NexusApplicationRestoreCompatibilityV1',
      status: 'passed',
      databaseMaxMigration: 2,
      runtimeMaxMigration: 2,
    });

    fs.rmSync(path.join(migrations, '002_current.sql'));
    const incompatible = runPython([sqliteHelper, 'compatibility', database, migrations]);
    expect(incompatible.status).not.toBe(0);
    expect(incompatible.stderr).toContain('database migration 002 exceeds runtime 001');
  });

  it('computes exact count and 90-day deletion plans without touching unknown keys', () => {
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
    const runbook = fs.readFileSync(path.join(opsRoot, 'OPERATIONS.txt'), 'utf8');
    const restoreReadiness = JSON.parse(fs.readFileSync(
      path.join(opsRoot, 'restore-readiness.json'),
      'utf8',
    ));

    expect(backup).toContain('"$SQLITE_HELPER" snapshot');
    expect(backup).toContain('age --encrypt --recipient');
    expect(backup).toContain('prune_count_tier hourly 24');
    expect(backup).toContain('prune_count_tier daily 7');
    expect(backup).toContain('prune_count_tier weekly 4');
    expect(backup).toContain('prune_count_tier monthly 6');
    expect(backup).toContain('age --days 90');
    expect(backup).toContain('rollback_archives=("$NEXUS_DR_ROLLBACK_DIR"/v*.tar.gz)');
    expect(backup).toContain('private_root_file "$CONFIG" "configuration"');
    expect(backup).toContain('must be root:root mode 0600');
    expect(backup).toContain('S3 endpoint must be a credential-free HTTPS origin');
    expect(backup).toContain('NEXUS_DR_STORAGE_PROVIDER');
    expect(backup).toContain('"$STORAGE_CONTROL_HELPER"');
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
    expect(config).toContain('NEXUS_DR_DRILL_USER=nexus-drill');
    expect(config).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(restore).toContain('RPO breach');
    expect(restore).toContain('RTO breach');
    expect(restore).toContain('age < 0 or age > 3600');
    expect(restore).toContain('elapsed < 1800');
    expect(restore).toContain('run_harness boot');
    expect(restore).toContain('run_harness smoke >"$tmp_dir/application-smoke.json"');
    expect(restore).toContain('run_harness stop');
    expect(restore).toContain('run_dependency_helper install');
    expect(restore).toContain('unshare --net');
    expect(restore).toContain('NEXUS_DRILL_USER="$NEXUS_DR_DRILL_USER"');
    expect(restore).toContain('"networkIndependentDependenciesVerified": True');
    expect(restore).toContain('release-database-compatibility.json');
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
    expect(runbook).toContain('cloudflare-r2:r2-approved-variance');
    expect(runbook).toContain('private network, mount, and PID namespaces');
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
});
