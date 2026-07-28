import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('lean advisory SonarQube operations', () => {
  it('updates the existing named-volume stack in place with immutable images', () => {
    const compose = read('ops/sonarqube/compose.yaml');
    const lock = read('ops/sonarqube/images.lock.env');
    const config = read('ops/sonarqube/backup.env.example');

    expect(compose).toContain('name: sonarqube');
    expect(compose).toContain('db:');
    expect(compose).toContain(
      'postgres:16@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777',
    );
    expect(compose).toContain(
      'sonarqube:26.7.0.124771-community@sha256:160bd2f6a3485bd09b655ef22dd63c02bd1fa7ba82aa5d9973fd010b8bcca0b3',
    );
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('"127.0.0.1:9000:9000"');
    expect(compose).not.toMatch(/5432:5432|\/srv\/sonarqube/);
    expect(compose).toContain('cpus: 1.0');
    expect(compose).toContain('mem_limit: 2g');
    expect(compose).toContain('cpus: 2.0');
    expect(compose).toContain('mem_limit: 6g');
    for (const volume of [
      'postgresql_data',
      'sonarqube_data',
      'sonarqube_extensions',
      'sonarqube_logs',
    ]) {
      expect(compose).toContain(volume);
    }
    expect(lock).toContain('POSTGRES_IMAGE_TAG=16');
    expect(config).toContain(
      'SONAR_STACK_DIR=/home/dominguez/sonarqube',
    );
    expect(config).toContain(
      'SONAR_COMPOSE_FILE=/home/dominguez/sonarqube/docker-compose.yml',
    );
    expect(config).toContain(
      'SONAR_SECRETS_FILE=/home/dominguez/sonarqube/.env',
    );
  });

  it('backs up the existing db service locally and keeps seven copies', () => {
    const backup = read('scripts/quality-sonar-backup.sh');
    const restore = read('scripts/quality-sonar-restore-drill.sh');
    const service = read(
      'ops/sonarqube/systemd/nexus-sonarqube-backup.service',
    );

    expect(() => execFileSync('bash', ['-n', 'scripts/quality-sonar-backup.sh']))
      .not.toThrow();
    expect(() => execFileSync('bash', ['-n', 'scripts/quality-sonar-restore-drill.sh']))
      .not.toThrow();
    expect(backup).toContain('config_value SONAR_COMPOSE_FILE');
    expect(backup).toContain('exec -T db');
    expect(backup).toContain('pg_dump --format=custom');
    expect(backup).toContain('pg_restore --list');
    expect(backup).toContain('"${backups[@]:7}"');
    expect(backup).toContain('/run/lock/nexus-release-sonar.lock');
    expect(restore).toContain('get("db", {}).get("image")');
    expect(restore).toContain('docker run --detach');
    expect(restore).toContain('docker rm --force --volumes');
    expect(restore).toContain('publicTableCount');
    expect(service).toContain('After=docker.service');
    expect(service).not.toMatch(
      /nexus-sonarqube-(?:install-recovery|service)|asset-install-in-progress/,
    );
    expect(service).not.toContain('ConditionPathExists');
    expect(service).toContain(
      'ExecStart=/usr/local/sbin/quality-sonar-backup --config /etc/nexus-sonarqube-backup.env',
    );
    expect(service).toContain(
      'ReadWritePaths=/srv/nexus-backups/sonarqube /run/lock/nexus-release-sonar.lock',
    );
  });

  it('installs in place without restarting the stack or enabling timers', () => {
    const installer = read('scripts/quality-sonar-local-install.sh');
    expect(() => execFileSync('bash', ['-n', 'scripts/quality-sonar-local-install.sh']))
      .not.toThrow();
    expect(installer).toContain(
      'validate_root_path_chain "$SOURCE_ROOT" "Sonar source root"',
    );
    expect(installer).toContain(
      'validate_root_path_chain "$CANDIDATE" "Sonar Compose candidate"',
    );
    expect(installer).toContain("current_services\" = $'db\\nsonarqube'");
    expect(installer).toContain('candidate must preserve the existing named volumes');
    expect(installer).toContain('config --format json');
    expect(installer).toContain("docker inspect --format '{{json .Mounts}}'");
    expect(installer).toContain('quality-sonar-volume-identity.mjs');
    expect(installer).toContain(
      '/srv/nexus-backups/sonarqube/restore-evidence',
    );
    expect(installer).toContain('installed Sonar release monitor is unsafe');
    expect(installer).toContain('docker-compose.yml.pre-lean');
    expect(installer).toContain('if cmp -s "$LIVE_COMPOSE" "$CANDIDATE"');
    expect(installer).toContain('existing pre-lean Compose backup is unsafe');
    expect(installer).not.toMatch(
      /docker compose[^\n]*(?:up|down|restart)|systemctl\s+enable/,
    );
  });

  it('rejects candidate or running-container volume identity drift', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-sonar-volume-'));
    const helper = path.resolve('scripts/quality-sonar-volume-identity.mjs');
    const current = {
      name: 'sonarqube',
      services: {
        db: {
          volumes: [
            {
              type: 'volume',
              source: 'postgresql_data',
              target: '/var/lib/postgresql/data',
              volume: {},
            },
          ],
        },
        sonarqube: {
          volumes: [
            { type: 'volume', source: 'sonarqube_data', target: '/opt/sonarqube/data', volume: {} },
            { type: 'volume', source: 'sonarqube_extensions', target: '/opt/sonarqube/extensions', volume: {} },
            { type: 'volume', source: 'sonarqube_logs', target: '/opt/sonarqube/logs', volume: {} },
          ],
        },
      },
      volumes: {
        postgresql_data: { name: 'sonarqube_postgresql_data' },
        sonarqube_data: { name: 'sonarqube_sonarqube_data' },
        sonarqube_extensions: { name: 'sonarqube_sonarqube_extensions' },
        sonarqube_logs: { name: 'sonarqube_sonarqube_logs' },
      },
    };
    const dbMounts = [
      {
        Type: 'volume',
        Name: 'sonarqube_postgresql_data',
        Destination: '/var/lib/postgresql/data',
      },
    ];
    const sonarMounts = [
      { Type: 'volume', Name: 'sonarqube_sonarqube_data', Destination: '/opt/sonarqube/data' },
      { Type: 'volume', Name: 'sonarqube_sonarqube_extensions', Destination: '/opt/sonarqube/extensions' },
      { Type: 'volume', Name: 'sonarqube_sonarqube_logs', Destination: '/opt/sonarqube/logs' },
    ];
    const run = (candidate: unknown, mounts = sonarMounts) => {
      const files = {
        current: path.join(directory, 'current.json'),
        candidate: path.join(directory, 'candidate.json'),
        db: path.join(directory, 'db.json'),
        sonar: path.join(directory, 'sonar.json'),
      };
      writeFileSync(files.current, JSON.stringify(current));
      writeFileSync(files.candidate, JSON.stringify(candidate));
      writeFileSync(files.db, JSON.stringify(dbMounts));
      writeFileSync(files.sonar, JSON.stringify(mounts));
      return () => execFileSync(process.execPath, [
        helper,
        '--current-config', files.current,
        '--candidate-config', files.candidate,
        '--db-mounts', files.db,
        '--sonarqube-mounts', files.sonar,
      ]);
    };
    try {
      expect(run(structuredClone(current))).not.toThrow();

      const renamed = structuredClone(current);
      renamed.volumes.postgresql_data.name = 'fresh_empty_database';
      expect(run(renamed)).toThrow();

      const wrongRunningMounts = structuredClone(sonarMounts);
      wrongRunningMounts[0].Name = 'fresh_empty_sonar_data';
      expect(run(structuredClone(current), wrongRunningMounts)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('contains no AWS backup or duplicate-stack machinery', () => {
    const source = [
      read('scripts/quality-sonar-backup.sh'),
      read('scripts/quality-sonar-restore-drill.sh'),
      read('ops/sonarqube/backup.env.example'),
      read('ops/sonarqube/README.md'),
    ].join('\n');
    expect(source).not.toMatch(
      /AWS_|s3api|Roles Anywhere|CloudFormation|\/srv\/sonarqube|off-host/i,
    );
  });

  it('binds existing selected-test LCOV to the exact SHA without rerunning tests', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-sonar-coverage-'));
    try {
      const lcov = path.join(directory, 'lcov.info');
      const output = path.join(directory, 'sonar-coverage-evidence.json');
      const body = 'TN:\nSF:src/example.ts\nDA:1,1\nend_of_record\n';
      writeFileSync(lcov, body);
      execFileSync(process.execPath, [
        'scripts/quality-sonar-coverage-manifest.mjs',
        '--runtime-sha', 'a'.repeat(40),
        '--coverage-dir', directory,
        '--output', output,
      ]);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        schemaVersion: 'SonarCoverageEvidenceV1',
        runtimeSha: 'a'.repeat(40),
        reports: {
          javascriptLcov: {
            path: 'lcov.info',
            sha256: createHash('sha256').update(body).digest('hex'),
          },
          pythonXml: null,
        },
      });
      expect(read('scripts/quality-sonar-coverage-manifest.mjs')).not.toMatch(
        /\b(?:vitest|npm test|pytest)\b/,
      );
      const workflow = read('.github/workflows/ci.yml');
      expect(workflow).toContain(
        'node scripts/quality-sonar-coverage-manifest.mjs',
      );
      expect(workflow).toContain(
        '--runtime-sha "$GITHUB_SHA"',
      );
      expect(workflow).toContain(
        'if [ -s .local/coverage/selected/lcov.info ]; then',
      );
      expect(workflow).toContain(
        'advisory Sonar coverage is unavailable for this SHA',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
