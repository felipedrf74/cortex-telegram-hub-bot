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

  it('exhausts AWS version pages and deletes exact versions sequentially', () => {
    const backup = fs.readFileSync(backupScript, 'utf8');
    const retentionBlock = backup.match(
      /# BEGIN version-aware S3 retention functions\n([\s\S]*?)# END version-aware S3 retention functions/,
    )?.[1];
    expect(retentionBlock).toBeTruthy();
    expect(retentionBlock).toContain('list-object-versions');
    expect(retentionBlock).toContain('--no-paginate');
    expect(retentionBlock).toContain('--max-keys 1000');
    expect(retentionBlock).toContain('--key-marker "$key_marker"');
    expect(retentionBlock).toContain('--version-id-marker "$version_id_marker"');

    const exactDelete = retentionBlock!.slice(
      retentionBlock!.indexOf('execute_version_deletion_plan()'),
      retentionBlock!.indexOf('prune_versioned_count_tier()'),
    );
    expect(exactDelete.match(/aws_s3api delete-object/g)).toHaveLength(1);
    expect(exactDelete).toContain('--version-id "$version_id"');
    expect(exactDelete).toContain('if ! aws_s3api delete-object');

    const visibleCount = retentionBlock!.slice(
      retentionBlock!.indexOf('prune_visible_count_tier()'),
      retentionBlock!.indexOf('prune_count_tier()'),
    );
    const visibleRelease = retentionBlock!.slice(
      retentionBlock!.indexOf('prune_visible_release_age()'),
      retentionBlock!.indexOf('prune_release_age()'),
    );
    for (const visiblePath of [visibleCount, visibleRelease]) {
      expect(visiblePath).toContain('cloudflare-r2:r2-approved-variance');
      expect(visiblePath).toContain('list-objects-v2');
      expect(visiblePath).toContain('delete-object');
      expect(visiblePath).not.toContain('--version-id');
    }
    expect(retentionBlock).toContain(
      'aws-s3:versioned-s3) prune_versioned_count_tier "$@"',
    );
    expect(retentionBlock).toContain(
      'cloudflare-r2:r2-approved-variance) prune_visible_count_tier "$@"',
    );

    const prefix = 'nexus-hub/application/database';
    const oldKeyOne = `${prefix}/daily/nexus-db-20260720.sqlite.age`;
    const oldKeyTwo = `${prefix}/daily/nexus-db-20260721.sqlite.age`;
    const newestKey = `${prefix}/daily/nexus-db-20260723.sqlite.age`;
    const firstPage = JSON.stringify({
      Prefix: `${prefix}/daily/`,
      IsTruncated: true,
      NextKeyMarker: oldKeyTwo,
      NextVersionIdMarker: 'old-version-two',
      Versions: [
        {
          Key: oldKeyOne,
          VersionId: 'old-version-one',
          LastModified: '2026-07-20T00:00:00Z',
          IsLatest: true,
        },
        {
          Key: oldKeyTwo,
          VersionId: 'old-version-two',
          LastModified: '2026-07-21T00:00:00Z',
          IsLatest: true,
        },
      ],
      DeleteMarkers: [],
    });
    const finalPage = JSON.stringify({
      Prefix: `${prefix}/daily/`,
      KeyMarker: oldKeyTwo,
      VersionIdMarker: 'old-version-two',
      IsTruncated: false,
      Versions: [{
        Key: newestKey,
        VersionId: 'newest-version',
        LastModified: '2026-07-23T00:00:00Z',
        IsLatest: true,
      }],
      DeleteMarkers: [],
    });
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

    const runMock = (mode: 'success' | 'fail-first') => {
      const root = privateRoot(`nexus-app-dr-version-pages-${mode}-`);
      const harness = path.join(root, 'retention-harness.sh');
      const log = path.join(root, 'aws.log');
      const source = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `tmp_dir=${shellQuote(root)}`,
        `mock_log=${shellQuote(log)}`,
        `mock_mode=${shellQuote(mode)}`,
        'NEXUS_DR_S3_BUCKET=nexus-recovery',
        'NEXUS_DR_STORAGE_PROVIDER=aws-s3',
        'NEXUS_DR_STORAGE_CONTROL_MODE=versioned-s3',
        `NEXUS_DR_PYTHON_BIN=${shellQuote(python)}`,
        `VERSION_RETENTION_HELPER=${shellQuote(path.resolve(
          'scripts/application-dr-version-retention.py',
        ))}`,
        `RETENTION_HELPER=${shellQuote(retentionHelper)}`,
        `database_root=${shellQuote(prefix)}`,
        'NEXUS_DR_S3_PREFIX=nexus-hub/application',
        'created_epoch=1784808000',
        'die() { echo "mock retention: $*" >&2; exit 1; }',
        'aws_s3api() {',
        '  local action="$1" argument key="" version_id="" key_marker="" version_marker=""',
        '  shift',
        '  case "$action" in',
        '    list-object-versions)',
        '      printf "LIST" >>"$mock_log"',
        '      for argument in "$@"; do printf "\\t%s" "$argument" >>"$mock_log"; done',
        '      printf "\\n" >>"$mock_log"',
        '      while [ $# -gt 0 ]; do',
        '        case "$1" in',
        '          --key-marker) key_marker="$2"; shift 2 ;;',
        '          --version-id-marker) version_marker="$2"; shift 2 ;;',
        '          *) shift ;;',
        '        esac',
        '      done',
        '      if [ -z "$key_marker" ] && [ -z "$version_marker" ]; then',
        `        printf "%s\\n" ${shellQuote(firstPage)}`,
        '      else',
        `        [ "$key_marker" = ${shellQuote(oldKeyTwo)} ]`,
        '        [ "$version_marker" = old-version-two ]',
        `        printf "%s\\n" ${shellQuote(finalPage)}`,
        '      fi',
        '      ;;',
        '    delete-object)',
        '      while [ $# -gt 0 ]; do',
        '        case "$1" in',
        '          --key) key="$2"; shift 2 ;;',
        '          --version-id) version_id="$2"; shift 2 ;;',
        '          *) shift ;;',
        '        esac',
        '      done',
        '      [ -n "$key" ] && [ -n "$version_id" ]',
        '      printf "DELETE\\t%s\\t%s\\n" "$key" "$version_id" >>"$mock_log"',
        '      [ "$mock_mode" != fail-first ] || return 42',
        '      printf "{}\\n"',
        '      ;;',
        '    *) return 64 ;;',
        '  esac',
        '}',
        retentionBlock!,
        'prune_versioned_count_tier daily 1',
        '',
      ].join('\n');
      fs.writeFileSync(harness, source, { mode: 0o700 });
      const result = spawnSync('bash', [harness], { encoding: 'utf8' });
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
      return { result, calls };
    };

    const succeeded = runMock('success');
    expect(succeeded.result.status, succeeded.result.stderr).toBe(0);
    const listCalls = succeeded.calls.filter((line) => line.startsWith('LIST\t'));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toContain('\t--no-paginate');
    expect(listCalls[0]).toContain('\t--max-keys\t1000');
    expect(listCalls[0]).not.toContain('--key-marker');
    expect(listCalls[1]).toContain(`\t--key-marker\t${oldKeyTwo}`);
    expect(listCalls[1]).toContain('\t--version-id-marker\told-version-two');
    const deleteCalls = succeeded.calls.filter((line) => line.startsWith('DELETE\t'));
    expect(deleteCalls).toEqual([
      `DELETE\t${oldKeyOne}\told-version-one`,
      `DELETE\t${oldKeyTwo}\told-version-two`,
    ]);

    const failed = runMock('fail-first');
    expect(failed.result.status).not.toBe(0);
    expect(failed.result.stderr).toContain('versioned retention deletion failed');
    expect(failed.calls.filter((line) => line.startsWith('DELETE\t'))).toEqual([
      `DELETE\t${oldKeyOne}\told-version-one`,
    ]);
  });

  it('captures and re-confirms the exact hourly database object after retention', () => {
    const backup = fs.readFileSync(backupScript, 'utf8');
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const sourceSlice = (start: string, end: string) => {
      const startIndex = backup.indexOf(start);
      const endIndex = backup.indexOf(end, startIndex);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      return backup.slice(startIndex, endIndex);
    };
    const versionParser = sourceSlice(
      'aws_version_id_from_json() {',
      'aws_retain_until_from_json() {',
    );
    const uploadFunctions = sourceSlice(
      'LAST_VERIFIED_VERSION_ID=""',
      'created_epoch="$(date -u +%s)"',
    );
    const databaseUpload = sourceSlice(
      'hourly_database_version_id=""',
      '# BEGIN version-aware S3 retention functions',
    );
    // Darwin's Bash 3.2 regex engine caps interval bounds at 255. Production
    // uses Ubuntu 24.04/glibc and deliberately permits opaque IDs up to 1024.
    const portableDatabaseUpload = databaseUpload.replace(
      '{1,1024}',
      '{1,255}',
    );
    expect(portableDatabaseUpload).not.toBe(databaseUpload);
    const postRetentionConfirmation = sourceSlice(
      'confirm_database_after_retention() {',
      'prune_versioned_release_age() {',
    );

    const runMock = (
      provider: 'aws-s3' | 'cloudflare-r2',
      mode: 'success' | 'missing-put-version' | 'mismatched-post-retention',
    ) => {
      const root = privateRoot(`nexus-app-dr-database-version-${provider}-${mode}-`);
      const harness = path.join(root, 'database-version-harness.sh');
      const log = path.join(root, 'aws.log');
      const encrypted = path.join(root, 'database.sqlite.age');
      fs.writeFileSync(encrypted, 'encrypted-database-recovery-point');
      const source = [
        '#!/usr/bin/env bash',
        // macOS ships Bash 3.2, where expanding a declared empty array under
        // nounset fails even though the Ubuntu 24.04 production Bash accepts it.
        'set -eo pipefail',
        `tmp_dir=${shellQuote(root)}`,
        `mock_log=${shellQuote(log)}`,
        `mock_mode=${shellQuote(mode)}`,
        `NEXUS_DR_STORAGE_PROVIDER=${shellQuote(provider)}`,
        'NEXUS_DR_S3_BUCKET=nexus-recovery',
        `NEXUS_DR_PYTHON_BIN=${shellQuote(python)}`,
        `encrypted=${shellQuote(encrypted)}`,
        'plaintext_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'created_epoch=1784808000',
        'database_root=nexus-hub/application/database',
        'hourly_key="$database_root/hourly/nexus-db-20260723T120000Z.sqlite.age"',
        'daily_key="$database_root/daily/nexus-db-20260723.sqlite.age"',
        'weekly_key="$database_root/weekly/nexus-db-2026-W30.sqlite.age"',
        'monthly_key="$database_root/monthly/nexus-db-202607.sqlite.age"',
        'encrypted_sha="$(sha256sum -- "$encrypted" | awk \'{print $1}\')"',
        'hourly_head_count=0',
        'die() { echo "mock database backup: $*" >&2; exit 1; }',
        'sha256_file() { sha256sum -- "$1" | awk \'{print $1}\'; }',
        'size_file() { wc -c <"$1" | awk \'{print $1}\'; }',
        'version_for_key() {',
        '  case "$1" in',
        '    "$hourly_key") printf "hourly-version-123\\n" ;;',
        '    "$daily_key") printf "daily-version-123\\n" ;;',
        '    "$weekly_key") printf "weekly-version-123\\n" ;;',
        '    "$monthly_key") printf "monthly-version-123\\n" ;;',
        '    *) return 64 ;;',
        '  esac',
        '}',
        'aws_s3api() {',
        '  local action="$1" argument key="" requested_version="" output="" actual_version=""',
        '  shift',
        '  printf "%s" "$action" >>"$mock_log"',
        '  for argument in "$@"; do printf "\\t%s" "$argument" >>"$mock_log"; done',
        '  printf "\\n" >>"$mock_log"',
        '  case "$action" in',
        '    put-object)',
        '      while [ $# -gt 0 ]; do',
        '        case "$1" in',
        '          --key) key="$2"; shift 2 ;;',
        '          *) shift ;;',
        '        esac',
        '      done',
        '      actual_version="$(version_for_key "$key")"',
        '      if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then',
        '        if [ "$mock_mode" = missing-put-version ] && [ "$key" = "$hourly_key" ]; then',
        '          printf "{}\\n"',
        '        else',
        '          printf \'{"VersionId":"%s"}\\n\' "$actual_version"',
        '        fi',
        '      else',
        '        printf "{}\\n"',
        '      fi',
        '      ;;',
        '    head-object)',
        '      while [ $# -gt 0 ]; do',
        '        case "$1" in',
        '          --key) key="$2"; shift 2 ;;',
        '          --version-id) requested_version="$2"; shift 2 ;;',
        '          *) shift ;;',
        '        esac',
        '      done',
        '      actual_version="$(version_for_key "$key")"',
        '      if [ "$key" = "$hourly_key" ]; then',
        '        hourly_head_count=$((hourly_head_count + 1))',
        '        if [ "$mock_mode" = mismatched-post-retention ] \\',
        '            && [ "$hourly_head_count" -eq 2 ]; then',
        '          actual_version=wrong-hourly-version',
        '        fi',
        '      fi',
        '      if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then',
        '        printf \'{"ContentLength":%s,"VersionId":"%s","Metadata":{"encrypted-sha256":"%s","plaintext-sha256":"%s","schema-version":"NexusApplicationSqliteRecoveryPointV1","created-epoch":"%s"}}\\n\' \\',
        '          "$(size_file "$encrypted")" "$actual_version" "$encrypted_sha" "$plaintext_sha" "$created_epoch"',
        '      else',
        '        [ -z "$requested_version" ]',
        '        printf \'{"ContentLength":%s,"Metadata":{"encrypted-sha256":"%s","plaintext-sha256":"%s","schema-version":"NexusApplicationSqliteRecoveryPointV1","created-epoch":"%s"}}\\n\' \\',
        '          "$(size_file "$encrypted")" "$encrypted_sha" "$plaintext_sha" "$created_epoch"',
        '      fi',
        '      ;;',
        '    get-object)',
        '      output="${@: -1}"',
        '      while [ $# -gt 0 ]; do',
        '        case "$1" in',
        '          --key) key="$2"; shift 2 ;;',
        '          --version-id) requested_version="$2"; shift 2 ;;',
        '          *) shift ;;',
        '        esac',
        '      done',
        '      if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then',
        '        [ "$requested_version" = "$(version_for_key "$key")" ]',
        '      else',
        '        [ -z "$requested_version" ]',
        '      fi',
        '      cp -- "$encrypted" "$output"',
        '      printf "{}\\n"',
        '      ;;',
        '    *) return 64 ;;',
        '  esac',
        '}',
        versionParser,
        uploadFunctions,
        portableDatabaseUpload,
        postRetentionConfirmation,
        'confirm_database_after_retention',
        'printf "RESULT\\t%s\\t%s\\t%s\\n" \\',
        '  "$NEXUS_DR_STORAGE_PROVIDER" "$hourly_database_version_id" "$database_confirmed_at"',
        '',
      ].join('\n');
      fs.writeFileSync(harness, source, { mode: 0o700 });
      const result = spawnSync('bash', [harness], { encoding: 'utf8' });
      const calls = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      return { result, calls };
    };

    const aws = runMock('aws-s3', 'success');
    expect(aws.result.status, aws.result.stderr).toBe(0);
    expect(aws.result.stdout).toMatch(
      /^RESULT\taws-s3\thourly-version-123\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m,
    );
    const hourlyPrefix = '\tnexus-hub/application/database/hourly/';
    const awsHourlyHeads = aws.calls.filter(
      (line) => line.startsWith('head-object\t') && line.includes(hourlyPrefix),
    );
    expect(awsHourlyHeads).toHaveLength(2);
    for (const call of awsHourlyHeads) {
      expect(call).toContain('\t--version-id\thourly-version-123');
    }
    const awsGet = aws.calls.find((line) => line.startsWith('get-object\t'));
    expect(awsGet).toContain('\t--version-id\thourly-version-123');

    const r2 = runMock('cloudflare-r2', 'success');
    expect(r2.result.status, r2.result.stderr).toBe(0);
    expect(r2.result.stdout).toMatch(
      /^RESULT\tcloudflare-r2\t\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m,
    );
    for (const call of r2.calls.filter(
      (line) => line.startsWith('head-object\t') || line.startsWith('get-object\t'),
    )) {
      expect(call).not.toContain('\t--version-id\t');
    }
    expect(backup).toContain('"databaseObjectVersionId": database_version_id or None');
    expect(backup).toContain(
      '"databaseRetentionVariance": (\n'
      + '        "r2-approved-variance"\n'
      + '        if provider == "cloudflare-r2"',
    );
    expect(backup).toContain(
      '"databaseApprovedUnversionedVariance": provider == "cloudflare-r2"',
    );

    const missing = runMock('aws-s3', 'missing-put-version');
    expect(missing.result.status).not.toBe(0);
    expect(missing.result.stderr).toContain(
      'put-object response has no valid exact VersionId',
    );
    expect(missing.result.stderr).toContain(
      'put-object did not return an exact S3 VersionId',
    );

    const mismatched = runMock('aws-s3', 'mismatched-post-retention');
    expect(mismatched.result.status).not.toBe(0);
    expect(mismatched.result.stderr).toContain(
      'uploaded object exact VersionId did not verify',
    );
    expect(mismatched.result.stderr).toContain(
      'uploaded object verification failed: nexus-hub/application/database/hourly/',
    );
    expect(mismatched.calls.filter(
      (line) => line.startsWith('head-object\t')
        && line.includes(hourlyPrefix),
    )).toHaveLength(2);
    expect(mismatched.calls.some((line) => line.startsWith('get-object\t'))).toBe(false);

    const hourlyPrune = backup.indexOf(
      'prune_count_tier hourly 24 "$hourly_key" "$hourly_database_version_id"',
    );
    const monthlyPrune = backup.indexOf('prune_count_tier monthly 6', hourlyPrune);
    const postRetentionCall = backup.indexOf(
      '\nconfirm_database_after_retention\n',
      monthlyPrune,
    );
    expect(hourlyPrune).toBeGreaterThan(-1);
    expect(monthlyPrune).toBeGreaterThan(hourlyPrune);
    expect(postRetentionCall).toBeGreaterThan(monthlyPrune);
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
    const installLayout = fs.readFileSync(path.join(opsRoot, 'install-layout.tsv'), 'utf8');

    expect(backup).toContain('"$SQLITE_HELPER" snapshot');
    expect(backup).toContain('age --encrypt --recipient');
    expect(backup).toContain('prune_count_tier hourly 24');
    expect(backup).toContain('prune_count_tier daily 7');
    expect(backup).toContain('prune_count_tier weekly 4');
    expect(backup).toContain('prune_count_tier monthly 6');
    expect(backup).toContain('age --days 90');
    expect(backup).toContain('--grace-seconds 3600');
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
      'get_args+=(--version-id "$required_recovery_version_id")',
    );
    expect(backup).toContain('confirm_current_recovery_after_retention');
    expect(backup).toContain('[ "$key" = "${protected_keys[0]}" ]');
    expect(backup).toContain('[ "$key" = "${protected_keys[1]}" ]');
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
    expect(restore).toContain('technical restore target breached');
    expect(restore).toContain('age < 0 or age > 3600');
    expect(restore).toContain('technical_elapsed_ns <= 1800000000000');
    expect(restore).toContain('--database-version-id');
    expect(restore).toContain('--release-version-id');
    expect(restore).toContain('database_head_args+=(--version-id "$DATABASE_VERSION_ID")');
    expect(restore).toContain('release_head_args+=(--version-id "$RELEASE_VERSION_ID")');
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
    expect(runbook).toContain('cloudflare-r2:r2-approved-variance');
    expect(runbook).toContain('s3:ListBucketVersions');
    expect(runbook).toContain('s3:DeleteObjectVersion');
    expect(runbook).toContain('auto-pagination is disabled');
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
