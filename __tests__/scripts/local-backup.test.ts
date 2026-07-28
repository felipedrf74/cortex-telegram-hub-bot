import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const utility = resolve('scripts/local-backup.py');

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-local-backup-'));
  chmodSync(root, 0o700);
  const database = join(root, 'bot.db');
  execFileSync('python3', [
    '-c',
    [
      'import sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1])',
      'db.execute("PRAGMA foreign_keys=ON")',
      'db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)")',
      'db.execute("INSERT INTO users(name) VALUES (?)", ("Felipe",))',
      'db.commit()',
      'db.close()',
    ].join(';'),
    database,
  ]);
  const backupRoot = join(root, 'backups');
  const identity = join(root, 'age-identity.txt');
  writeFileSync(identity, 'AGE-SECRET-KEY-TEST\n', { mode: 0o600 });
  chmodSync(identity, 0o600);
  const config = join(root, 'backup.env');
  writeFileSync(
    config,
    [
      `NEXUS_LOCAL_BACKUP_DATABASE_PATH=${database}`,
      `NEXUS_LOCAL_BACKUP_ROOT=${backupRoot}`,
      'NEXUS_LOCAL_BACKUP_AGE_RECIPIENT=age1testrecipient',
      `NEXUS_LOCAL_BACKUP_AGE_IDENTITY=${identity}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(config, 0o600);
  const fakeAge = join(root, 'age');
  writeFileSync(
    fakeAge,
    [
      '#!/bin/sh',
      'set -eu',
      'output=""',
      'input=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --encrypt|--decrypt) shift ;;',
      '    --recipient|--identity) shift 2 ;;',
      '    --output) output="$2"; shift 2 ;;',
      '    *) input="$1"; shift ;;',
      '  esac',
      'done',
      'cp "$input" "$output"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(fakeAge, 0o755);
  return { root, database, backupRoot, identity, config, fakeAge };
}

function run(
  fixture: ReturnType<typeof createFixture>,
  ...args: string[]
) {
  return spawnSync(
    'python3',
    [utility, '--config', fixture.config, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_LOCAL_BACKUP_TEST_MODE: '1',
        NEXUS_LOCAL_BACKUP_AGE_BIN: fixture.fakeAge,
      },
    },
  );
}

describe('same-host Nexus backups', () => {
  it('creates encrypted tier points and verifies a plaintext-free restore', () => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const receipt = JSON.parse(created.stdout);
      expect(receipt).toMatchObject({
        schema: 'nexus.local-backup.v1',
        status: 'passed',
        kind: 'backup',
        integrityCheck: 'ok',
        foreignKeyCheck: 'ok',
        retention: {
          hourly: 24,
          daily: 30,
          weekly: 4,
          'pre-promotion': 10,
        },
      });
      for (const tier of ['hourly', 'daily', 'weekly']) {
        const files = readdirSync(join(fixture.backupRoot, tier));
        expect(files.filter((file) => file.endsWith('.age'))).toHaveLength(1);
        expect(files.filter((file) => file.endsWith('.sha256'))).toHaveLength(1);
      }

      const verified = run(fixture, 'restore-verify');
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        schema: 'nexus.local-backup-restore-verification.v1',
        status: 'passed',
        integrityCheck: 'ok',
        foreignKeyCheck: 'ok',
      });
      expect(readdirSync(fixture.backupRoot)).not.toContain('restored.sqlite');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('creates a separate pre-promotion point and rejects checksum drift', () => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'pre-promotion');
      expect(created.status, created.stderr).toBe(0);
      const receipt = JSON.parse(created.stdout);
      const backup = receipt.installed['pre-promotion'] as string;
      writeFileSync(`${backup}.sha256`, `${'0'.repeat(64)}  ${backup.split('/').at(-1)}\n`);

      const verify = run(fixture, 'restore-verify', '--backup', backup);
      expect(verify.status).not.toBe(0);
      expect(verify.stderr).toContain('selected backup checksum mismatch');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('prunes every local tier to its explicit count limit', () => {
    const fixture = createFixture();
    try {
      const seed = (tier: string, names: string[]) => {
        const directory = join(fixture.backupRoot, tier);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (const name of names) {
          writeFileSync(join(directory, name), 'encrypted', { mode: 0o600 });
          writeFileSync(
            join(directory, `${name}.sha256`),
            `954d1bb83d80bb6f6e746b28f0de3ec4c4ed980cfe67ed23a9159cd464ff339a  ${name}\n`,
            { mode: 0o600 },
          );
        }
      };
      seed(
        'hourly',
        Array.from(
          { length: 30 },
          (_, index) => `nexus-db-20260101T${String(index).padStart(2, '0')}0000Z.sqlite.age`,
        ),
      );
      seed(
        'daily',
        Array.from(
          { length: 35 },
          (_, index) => `nexus-db-202601${String(index + 1).padStart(2, '0')}.sqlite.age`,
        ),
      );
      seed(
        'weekly',
        Array.from(
          { length: 6 },
          (_, index) => `nexus-db-2025-W${String(index + 1).padStart(2, '0')}.sqlite.age`,
        ),
      );

      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const count = (tier: string) =>
        readdirSync(join(fixture.backupRoot, tier))
          .filter((file) => file.endsWith('.age')).length;
      expect(count('hourly')).toBe(24);
      expect(count('daily')).toBe(30);
      expect(count('weekly')).toBe(4);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('ships narrow inactive systemd assets for backup and restore verification', () => {
    const installer = readFileSync('scripts/local-backup-systemd-install.sh', 'utf8');
    const sudoers = readFileSync('ops/local-backup/nexus-local-backup.sudoers', 'utf8');
    const prePromotion = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service',
      'utf8',
    );
    const timer = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup.timer',
      'utf8',
    );
    const hourly = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup.service',
      'utf8',
    );
    const restoreVerify = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.service',
      'utf8',
    );
    const verifyTimer = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer',
      'utf8',
    );

    expect(() => execFileSync('bash', ['-n', 'scripts/local-backup-systemd-install.sh']))
      .not.toThrow();
    expect(installer).toContain(
      'validate_root_path_chain "$SOURCE_ROOT" "local backup source root"',
    );
    expect(installer).toContain(
      'validate_root_path_chain "$SOURCE_ROOT/$source" "local backup asset ($source)"',
    );
    expect(installer).toContain(
      'visudo -cf "$SOURCE_ROOT/ops/local-backup/nexus-local-backup.sudoers"',
    );
    expect(installer).toContain('installed local backup executable is unsafe');
    expect(installer).toContain('visudo -cf /etc/sudoers.d/nexus-local-backup');
    expect(installer).not.toMatch(/systemctl\s+enable/);
    expect(sudoers).toContain(
      '/usr/bin/systemctl start nexus-local-backup-pre-promotion.service',
    );
    expect(sudoers).not.toContain('/usr/local/libexec/nexus-local-backup/local-backup.py');
    expect(prePromotion).toContain('local-backup.py pre-promotion');
    expect(prePromotion).not.toContain('ConditionPathExists');
    expect(hourly).not.toContain('ConditionPathExists');
    expect(restoreVerify).not.toContain('ConditionPathExists');
    expect(timer).toContain('OnCalendar=hourly');
    expect(verifyTimer).toContain('OnCalendar=Sun *-*-* 04:30:00 UTC');
  });

  it('does not retain AWS, object-store, or long-lived credential interfaces', () => {
    const files = [
      'scripts/local-backup.py',
      'scripts/local-backup-systemd-install.sh',
      'ops/local-backup/backup.env.example',
      'scripts/quality-sonar-backup.sh',
      'scripts/quality-sonar-restore-drill.sh',
      'ops/sonarqube/backup.env.example',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(
      /AWS_|s3api|Roles Anywhere|CloudFormation|MINIO_|access[_-]?key|secret[_-]?access/i,
    );
  });
});
