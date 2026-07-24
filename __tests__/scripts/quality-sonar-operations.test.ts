import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createObservationFixture,
  OLLAMA_DELETE,
  OLLAMA_DIGESTS,
  OLLAMA_RETAINED,
} from './helpers/ollama-observation-fixture';

const read = (path: string) => readFileSync(path, 'utf8');

describe('advisory SonarQube operational assets', () => {
  it('transactionally binds installation to the exact root bootstrap and reviewed layouts', () => {
    const installer = resolve('scripts/quality-sonar-systemd-install.sh');
    const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const script = read(installer);
    const declaredInstall = read('ops/sonarqube/install-layout.tsv')
      .split('\n').slice(1).join('\n').trim();
    const declaredData = read('ops/sonarqube/data-layout.tsv')
      .split('\n').slice(1).join('\n').trim();
    const installMatch = script.match(/cat <<'LAYOUT'\n([\s\S]*?)\nLAYOUT/);
    const dataMatch = script.match(/cat <<'DATA_LAYOUT'\n([\s\S]*?)\nDATA_LAYOUT/);

    expect(installMatch?.[1]).toBe(declaredInstall);
    expect(dataMatch?.[1]).toBe(declaredData);
    expect(script).toContain('BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap');
    expect(script).toContain('EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"');
    expect(script).toContain(
      '[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ]',
    );
    expect(script).toContain(
      '[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ]',
    );
    expect(script).toContain('archive.pax_headers.get("comment") != source_sha');
    expect(script).toContain('required member is not regular');
    expect(script).toContain('source drift for');
    expect(script).toContain('install target is outside the exact allowlist');
    expect(script).toContain('component is group/world writable');
    expect(script).toContain(
      'installer must execute from the exact reviewed bootstrap source path',
    );
    expect(script).toContain(
      'managed directory parent must already exist and be canonical',
    );
  });

  it('behaviorally rejects an installed source asset that drifted from the Git archive', () => {
    const installer = read('scripts/quality-sonar-systemd-install.sh');
    const verifier = installer.match(
      /# Prove that the reviewed archive[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\nsources=\(\)/,
    )?.[1];
    expect(verifier).toBeTruthy();

    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-installer-'));
    const sourceRoot = join(temp, 'source');
    const sourceScripts = join(sourceRoot, 'scripts');
    const sourceOps = join(sourceRoot, 'ops', 'sonarqube');
    const archive = join(temp, 'source.tar.gz');
    const verifierPath = join(temp, 'verify.py');
    const sha = 'a'.repeat(40);
    const layoutPath = join(sourceOps, 'install-layout.tsv');
    const dataLayoutPath = join(sourceOps, 'data-layout.tsv');
    const installerPath = join(sourceScripts, 'quality-sonar-systemd-install.sh');
    const assetPath = join(sourceScripts, 'asset.sh');

    try {
      mkdirSync(sourceScripts, { recursive: true });
      mkdirSync(sourceOps, { recursive: true });
      writeFileSync(
        layoutPath,
        '# source<TAB>absolute target<TAB>owner<TAB>mode\n' +
          'scripts/asset.sh\t/usr/local/sbin/asset\troot:root\t0755\n',
      );
      writeFileSync(dataLayoutPath, '# data layout\n');
      writeFileSync(installerPath, '#!/usr/bin/env bash\n');
      writeFileSync(assetPath, '#!/usr/bin/env bash\necho reviewed\n');
      writeFileSync(verifierPath, verifier!);

      const createArchive = spawnSync(
        'python3',
        [
          '-c',
          [
            'import pathlib,sys,tarfile',
            'archive,root,sha=sys.argv[1:]',
            'with tarfile.open(archive,"w:gz",format=tarfile.PAX_FORMAT,pax_headers={"comment":sha}) as output:',
            '  for item in sorted(pathlib.Path(root).rglob("*")):',
            '    output.add(item,arcname="source/"+item.relative_to(root).as_posix(),recursive=False)',
          ].join('\n'),
          archive,
          sourceRoot,
          sha,
        ],
        { encoding: 'utf8' },
      );
      expect(createArchive.status, createArchive.stderr).toBe(0);

      const verify = () =>
        spawnSync(
          'python3',
          [
            verifierPath,
            archive,
            sourceRoot,
            sha,
            layoutPath,
            dataLayoutPath,
            installerPath,
          ],
          { encoding: 'utf8' },
        );

      const accepted = verify();
      expect(accepted.status, accepted.stderr).toBe(0);
      writeFileSync(assetPath, '#!/usr/bin/env bash\necho drifted\n');
      const rejected = verify();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('source drift for scripts/asset.sh');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('serializes, prevalidates, atomically installs, and rolls back without runtime mutation', () => {
    const script = read('scripts/quality-sonar-systemd-install.sh');
    const lock = script.indexOf('exec 9<>"$SHARED_MUTEX"');
    const prevalidate = script.indexOf(
      '# Complete every source-only validation before creating a directory',
    );
    const firstDirectory = script.indexOf(
      'ensure_directory /usr/local/sbin/lib root root 0755',
    );
    const journalWrite = script.indexOf(
      'mv -fT -- "$journal_tmp" "$INSTALL_JOURNAL"',
    );
    const stage = script.indexOf(
      'stage="$(mktemp -p "$target_parent" ".nexus-sonarqube.stage.XXXXXX")"',
    );
    const firstCommit = script.indexOf('commit_asset "$service_index"');
    const receipt = script.indexOf(
      'mv -fT -- "$receipt_stage" "$INSTALL_RECEIPT"',
    );
    const receiptCommitted = script.indexOf(
      'receipt_committed=true',
      receipt,
    );
    const receiptDirectoryFsync = script.indexOf(
      'fsync_path "$STATE_DIR"',
      receipt,
    );

    expect(script).toContain('flock -n 9');
    expect(script).toContain('bash -n "$source_path"');
    expect(script).toContain('node --check "$source_path"');
    expect(script).toContain('--verify-lock-only');
    expect(script).toContain('visudo -cf');
    expect(script).toContain('Sonar Compose prevalidation');
    expect(lock).toBeGreaterThan(-1);
    expect(prevalidate).toBeGreaterThan(lock);
    expect(firstDirectory).toBeGreaterThan(prevalidate);
    expect(journalWrite).toBeGreaterThan(firstDirectory);
    expect(stage).toBeGreaterThan(journalWrite);
    expect(firstCommit).toBeGreaterThan(stage);
    expect(receipt).toBeGreaterThan(firstCommit);
    expect(receiptCommitted).toBeGreaterThan(receipt);
    expect(receiptDirectoryFsync).toBeGreaterThan(receiptCommitted);
    expect(script.slice(receipt, receiptCommitted)).not.toContain('fsync_path');
    expect(script).toContain('ln -- "$target" "$backup"');
    expect(script).toContain('mv -fT -- "${stage_paths[$index]}" "$target"');
    expect(script).toContain(
      'for ((position=${#committed_indices[@]} - 1; position >= 0; position -= 1)); do',
    );
    expect(script).toContain('mv -fT -- "$backup" "$target"');
    expect(script).toContain('failed to reload systemd after rollback');
    expect(script).toContain('inactive:3|failed:3|unknown:4|not-found:4');
    expect(script).not.toContain('! systemctl is-active "$unit"');
    expect(script).toContain('"configurationWritten":false');
    expect(script).toContain('"dockerTouched":false');
    expect(script).toContain('"servicesEnabled":false');
    expect(script).toContain('"applicationDataWritten":false');
    expect(script).not.toMatch(/^\s*(?:sudo\s+)?(?:apt|apt-get|docker)\b/m);
    expect(script).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable)\b/);
  });

  it('rejects an unknown systemctl transport result instead of assuming inactivity', () => {
    const installer = read('scripts/quality-sonar-systemd-install.sh');
    const helper = installer.match(
      /assert_unit_inactive\(\) \{\n[\s\S]*?\n\}/,
    )?.[0];
    expect(helper).toBeTruthy();

    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-unit-state-'));
    const systemctl = join(temp, 'systemctl');
    try {
      writeFileSync(
        systemctl,
        '#!/bin/sh\nprintf "%s\\n" "${MOCK_SYSTEMCTL_STATE:-}"\nexit "${MOCK_SYSTEMCTL_RC:-1}"\n',
        { mode: 0o755 },
      );
      chmodSync(systemctl, 0o755);
      const harness = [
        'set -euo pipefail',
        'die() { echo "$*" >&2; exit 1; }',
        helper!,
        'assert_unit_inactive nexus-sonarqube.service',
      ].join('\n');
      const run = (state: string, rc: number) =>
        spawnSync('bash', ['-c', harness], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH ?? ''}`,
            MOCK_SYSTEMCTL_STATE: state,
            MOCK_SYSTEMCTL_RC: String(rc),
          },
        });

      expect(run('inactive', 3).status).toBe(0);
      expect(run('failed', 3).status).toBe(0);
      expect(run('unknown', 4).status).toBe(0);
      expect(run('active', 0).status).not.toBe(0);
      expect(run('activating', 3).status).not.toBe(0);
      const transportError = run('', 1);
      expect(transportError.status).not.toBe(0);
      expect(transportError.stderr).toContain(
        'unable to prove unit is safely inactive',
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('guards stack and backup startup after an interrupted asset install', () => {
    const condition =
      'ConditionPathExists=!/var/lib/nexus-sonarqube/install-in-progress.v1';
    expect(read('ops/sonarqube/systemd/nexus-sonarqube.service')).toContain(condition);
    expect(read('ops/sonarqube/systemd/nexus-sonarqube-backup.service')).toContain(condition);
    expect(read('ops/sonarqube/systemd/nexus-sonarqube-backup.timer')).toContain(condition);
    expect(read('scripts/quality-sonar-stack.sh')).toContain(
      'Sonar asset installation is incomplete',
    );
  });

  it('rejects incomplete installer identity before any mutation', () => {
    const result = spawnSync(
      'bash',
      ['scripts/quality-sonar-systemd-install.sh'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      '<root-owned-source-root> <40-hex-source-sha>',
    );
    expect(result.stderr).toContain(
      '<root-owned-source-archive> <64-hex-archive-sha256>',
    );
  });

  it('pins the reviewed Community Build and PostgreSQL tags by immutable manifest digest', () => {
    const lock = read('ops/sonarqube/images.lock.env');
    const resolver = read('scripts/quality-sonar-resolve-images.sh');

    expect(lock).toContain('SONARQUBE_IMAGE_TAG=26.7.0.124771-community');
    expect(lock).toMatch(/SONARQUBE_IMAGE=sonarqube:26\.7\.0\.124771-community@sha256:[0-9a-f]{64}/);
    expect(lock).toContain('POSTGRES_IMAGE_TAG=17');
    expect(lock).toMatch(/POSTGRES_IMAGE=postgres:17@sha256:[0-9a-f]{64}/);
    expect(lock).not.toMatch(/:(latest|community)(?:\s|$)/);
    expect(resolver).toContain('--verify-lock-only');
    expect(resolver).toContain('Docker Hub returned an empty registry token');

    const output = execFileSync('bash', [
      'scripts/quality-sonar-resolve-images.sh',
      '--verify-lock-only',
    ], { encoding: 'utf8' });
    expect(output).toContain('sonar_image_lock_ok mode=offline');
  });

  it('keeps the database internal and publishes Sonar only on IPv4 loopback with bounded resources', () => {
    const compose = read('ops/sonarqube/compose.yaml');
    const postgresBlock = compose.slice(compose.indexOf('  postgres:'), compose.indexOf('  sonarqube:'));

    expect(compose).toContain('127.0.0.1:9000:9000');
    expect(compose).not.toContain('0.0.0.0:9000');
    expect(postgresBlock).not.toContain('ports:');
    expect(compose).toContain('internal: true');
    expect(postgresBlock).toContain('cpus: 1.0');
    expect(postgresBlock).toContain('mem_limit: 2g');
    expect(compose).toContain('cpus: 2.0');
    expect(compose).toContain('mem_limit: 6g');
    expect(compose).toContain('soft: 131072');
    expect(compose).toContain('soft: 8192');
    expect(compose).toContain('source: /srv/sonarqube/data/postgresql');
    expect(compose).toContain('source: /srv/sonarqube/data/sonarqube');
    expect(compose).toContain('create_host_path: false');
    expect(compose.match(/restart: "no"/g)).toHaveLength(2);
    expect(compose).not.toContain('restart: unless-stopped');
    expect(compose).not.toMatch(/^volumes:\s*$/m);
    expect(compose.toLowerCase()).not.toContain('watchtower');
  });

  it('declares a root-owned layout and external mode-0600 secrets without Docker-group authority', () => {
    const layout = read('ops/sonarqube/install-layout.tsv');
    const runbook = read('ops/sonarqube/README.md');
    const stack = read('scripts/quality-sonar-stack.sh');

    expect(layout).toContain('/srv/sonarqube/compose.yaml\troot:root\t0644');
    expect(layout).toContain('/usr/local/sbin/quality-sonar-stack\troot:root\t0755');
    expect(layout).toContain('/usr/local/sbin/nexus-ollama-observation-collector.mjs\troot:root\t0700');
    expect(layout).toContain('/usr/local/sbin/ollama-soak-evidence.mjs\troot:root\t0700');
    expect(layout).toContain('/usr/local/sbin/quality-sonar-start-evidence.mjs\troot:root\t0755');
    const dataLayout = read('ops/sonarqube/data-layout.tsv');
    expect(dataLayout).toContain('/srv/sonarqube\t0:0\t0750');
    expect(dataLayout).toContain('/srv/sonarqube/data/postgresql\t999:999\t0700');
    expect(dataLayout).toContain('/srv/sonarqube/data/sonarqube\t1000:1000\t0750');
    expect(runbook).toContain('/etc/sonarqube/sonarqube.env');
    expect(runbook).toContain('mode 0600');
    expect(runbook).toContain('Do not add the application or deploy account to the docker group');
    expect(runbook).toContain('not a release, signing, application-health, or');
    expect(stack).toContain('Sonar secrets file must have mode 0600');
    expect(stack).toContain('validate_data_layout');
    expect(stack).toContain('verify_prepulled_images');
    expect(stack).toContain('"$DOCKER_BIN" image inspect "$image"');
    expect(stack).toContain('"${compose[@]}" up -d --pull never');
    expect(stack).toContain('verify_runtime_limits');
    expect(stack).toContain('Number(postgres.NanoCpus) !== 1_000_000_000');
    expect(stack).toContain('Number(postgres.Memory) !== 2 * 1024 * 1024 * 1024');
    expect(stack).toContain('Number(sonar.NanoCpus) !== 2_000_000_000');
    expect(stack).toContain('Number(sonar.Memory) !== 6 * 1024 * 1024 * 1024');
    expect(stack).toContain(
      'rendered service image differs from the immutable image lock',
    );
    expect(stack).toContain(
      'Sonar secrets file must not override immutable image references',
    );
    expect(stack.indexOf('verify_prepulled_images')).toBeLessThan(
      stack.indexOf('"${compose[@]}" up -d --pull never'),
    );
    expect(stack).not.toMatch(/docker\s+(system\s+prune|volume\s+prune|image\s+prune)/);
  });

  it('rejects duplicate lock identities and rendered image overrides', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-image-binding-'));
    const stackDir = join(temp, 'stack');
    const bin = join(temp, 'bin');
    const secrets = join(temp, 'sonarqube.env');
    const lockPath = join(stackDir, 'images.lock.env');
    const dockerPath = join(bin, 'docker');
    const lock = read('ops/sonarqube/images.lock.env');
    const values = Object.fromEntries(
      lock
        .split('\n')
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => {
          const equals = line.indexOf('=');
          return [line.slice(0, equals), line.slice(equals + 1)];
        }),
    );
    const rendered = (postgresImage: string, sonarImage: string) => ({
      services: {
        postgres: {
          image: postgresImage,
          restart: 'no',
          cpus: 1,
          mem_limit: String(2 * 1024 * 1024 * 1024),
          ports: [],
          volumes: [{
            type: 'bind',
            source: '/srv/sonarqube/data/postgresql',
            target: '/var/lib/postgresql/data',
            bind: { create_host_path: false },
          }],
        },
        sonarqube: {
          image: sonarImage,
          restart: 'no',
          cpus: 2,
          mem_limit: String(6 * 1024 * 1024 * 1024),
          ports: [{
            host_ip: '127.0.0.1',
            published: '9000',
            target: 9000,
          }],
          volumes: [
            ['/srv/sonarqube/data/sonarqube', '/opt/sonarqube/data'],
            ['/srv/sonarqube/data/extensions', '/opt/sonarqube/extensions'],
            ['/srv/sonarqube/data/logs', '/opt/sonarqube/logs'],
            ['/srv/sonarqube/data/temp', '/opt/sonarqube/temp'],
          ].map(([source, target]) => ({
            type: 'bind',
            source,
            target,
            bind: { create_host_path: false },
          })),
        },
      },
      networks: { sonar_backend: { internal: true } },
    });
    const writeDocker = (
      postgresImage: string,
      sonarImage: string,
      resourceLimits: 'approved' | 'missing' | 'expanded' = 'approved',
    ) => {
      const value = rendered(postgresImage, sonarImage);
      if (resourceLimits === 'missing') {
        Reflect.deleteProperty(value.services.postgres, 'cpus');
        Reflect.deleteProperty(value.services.postgres, 'mem_limit');
        Reflect.deleteProperty(value.services.sonarqube, 'cpus');
        Reflect.deleteProperty(value.services.sonarqube, 'mem_limit');
      } else if (resourceLimits === 'expanded') {
        value.services.sonarqube.cpus = 4;
        value.services.sonarqube.mem_limit = String(12 * 1024 * 1024 * 1024);
      }
      writeFileSync(
        dockerPath,
        `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(value)}\nJSON\n`,
        { mode: 0o755 },
      );
      chmodSync(dockerPath, 0o755);
    };

    try {
      mkdirSync(stackDir, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(stackDir, 'compose.yaml'), 'services: {}\n');
      writeFileSync(lockPath, lock);
      writeFileSync(secrets, 'SONAR_JDBC_USERNAME=sonar\n', { mode: 0o600 });
      chmodSync(secrets, 0o600);
      writeFileSync(
        join(bin, 'id'),
        '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'stat'),
        '#!/bin/sh\ncase "$*" in *%a*|*%Lp*) echo 600 ;; *%U*|*%Su*) echo root ;; *) exec /usr/bin/stat "$@" ;; esac\n',
        { mode: 0o755 },
      );
      chmodSync(join(bin, 'id'), 0o755);
      chmodSync(join(bin, 'stat'), 0o755);

      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SONAR_STACK_DIR: stackDir,
        SONAR_SECRETS_FILE: secrets,
      };
      const run = () =>
        spawnSync('bash', ['scripts/quality-sonar-stack.sh', 'config'], {
          encoding: 'utf8',
          env,
        });

      writeDocker(values.POSTGRES_IMAGE, values.SONARQUBE_IMAGE);
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('sonarqube_compose_config_ok');

      writeDocker(values.POSTGRES_IMAGE, values.SONARQUBE_IMAGE, 'missing');
      const missingLimits = run();
      expect(missingLimits.status).not.toBe(0);
      expect(missingLimits.stderr).toContain(
        'rendered CPU or memory limits differ from the approved Sonar envelope',
      );

      writeDocker(values.POSTGRES_IMAGE, values.SONARQUBE_IMAGE, 'expanded');
      const expandedLimits = run();
      expect(expandedLimits.status).not.toBe(0);
      expect(expandedLimits.stderr).toContain(
        'rendered CPU or memory limits differ from the approved Sonar envelope',
      );

      writeDocker(values.POSTGRES_IMAGE, 'evil-local:latest');
      const renderedOverride = run();
      expect(renderedOverride.status).not.toBe(0);
      expect(renderedOverride.stderr).toContain(
        'rendered service image differs from the immutable image lock',
      );

      writeFileSync(
        secrets,
        'SONAR_JDBC_USERNAME=sonar\nSONARQUBE_IMAGE=evil-local:latest\n',
        { mode: 0o600 },
      );
      const secretOverride = run();
      expect(secretOverride.status).not.toBe(0);
      expect(secretOverride.stderr).toContain(
        'Sonar secrets file must not override immutable image references',
      );

      writeFileSync(secrets, 'SONAR_JDBC_USERNAME=sonar\n', { mode: 0o600 });
      writeFileSync(
        lockPath,
        `${lock}SONARQUBE_IMAGE=${values.SONARQUBE_IMAGE}\n`,
      );
      const duplicateLock = run();
      expect(duplicateLock.status).not.toBe(0);
      expect(duplicateLock.stderr).toContain(
        'Sonar image lock must contain exactly one SONARQUBE_IMAGE',
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps host preflight read-only while proving capacity and capturing private snapshots', () => {
    const preflight = read('scripts/quality-sonar-preflight.sh');

    expect(preflight).toContain('MIN_AVAILABLE_GIB=16');
    expect(preflight).toContain('MIN_DISK_FREE_PERCENT=20');
    expect(preflight).toContain('active_swap_io');
    expect(preflight).toContain('kernel_oom_events_last_24h');
    expect(preflight).toContain('pm2_restart_or_status_regression');
    expect(preflight).toContain('load_15_at_or_above_6');
    expect(preflight).toContain('backend=not_installed');
    expect(preflight).toContain('no_authoritative_firewall_backend_snapshot');
    expect(preflight).toContain('quality-sonar-start-evidence');
    expect(preflight).toContain('/proc/sys/kernel/random/boot_id');
    expect(preflight).toContain('PM2_USER=dominguez');
    expect(preflight).toContain('PM2_HOME=/home/dominguez/.pm2');
    expect(preflight).toContain('PM2_BIN=/usr/local/bin/pm2');
    expect(preflight).toContain('PM2_VERSION=6.0.14');
    expect(preflight).toContain('ROOT_NODE_BIN=/usr/bin/node');
    expect(preflight).toContain('NODE_BIN="$ROOT_NODE_BIN"');
    expect(preflight).toContain(
      'PM2_CONTROL=/usr/local/sbin/nexus-release-promotion-control',
    );
    expect(preflight).toContain('verify_root_pm2_identity');
    expect(preflight).toContain('"$PM2_CONTROL" assert-root-pm2-ready');
    expect(preflight).toContain("value.schema !== 'nexus.pm2-root-install.v1'");
    expect(preflight).toContain('value.version !== expectedVersion');
    expect(preflight).toContain('value.closureDigest');
    expect(preflight).toContain('value.payloadDigest');
    expect(preflight).not.toContain('/home/dominguez/.npm-global/bin/pm2');
    expect(preflight).toContain('RUNUSER_BIN=/usr/sbin/runuser');
    expect(preflight).toContain('CLOUDFLARED_UNIT=nexus-cloudflared.service');
    expect(preflight).toContain('"$RUNUSER_BIN" -u "$PM2_USER" --');
    expect(preflight).toContain('/usr/bin/env -i');
    expect(preflight).toContain('PM2_HOME="$PM2_HOME"');
    expect(preflight).toContain('systemctl show "$CLOUDFLARED_UNIT"');
    expect(preflight).not.toContain('pm2_snapshot() {\n  "$PM2_BIN" jlist');
    expect(preflight).not.toMatch(/systemctl show (?:cloudflared|cloudflared\.service)\b/);
    for (const evidence of [
      'firewall-ufw.txt',
      'firewall-nft.txt',
      'firewall-iptables.txt',
      'listeners.txt',
      'routes.txt',
      'sysctl.txt',
      'tailscale.txt',
      'cloudflare.txt',
      'health.tsv',
    ]) expect(preflight).toContain(evidence);
    expect(preflight).not.toMatch(/systemctl\s+(restart|stop|start|enable)|apt(?:-get)?\s+(install|remove)|docker\s+(run|pull|compose\s+up)/);
  });

  it('blocks Sonar preflight when the governed root PM2 authority rejects its closure', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-pm2-authority-'));
    const bin = join(temp, 'bin');
    const control = join(temp, 'nexus-release-promotion-control');
    mkdirSync(bin);
    chmodSync(temp, 0o700);
    try {
      writeFileSync(
        join(bin, 'id'),
        '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'stat'),
        '#!/bin/sh\ncase "$*" in *%U:%G:%a:%h*) echo root:root:755:1 ;; *) exec /usr/bin/stat "$@" ;; esac\n',
        { mode: 0o755 },
      );
      chmodSync(join(bin, 'id'), 0o755);
      chmodSync(join(bin, 'stat'), 0o755);
      const run = () => spawnSync(
        'bash',
        ['scripts/quality-sonar-preflight.sh', '--verify-pm2-only'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            NEXUS_RELEASE_TEST_MODE: '1',
            NEXUS_SONAR_PM2_CONTROL: control,
            NEXUS_SONAR_ROOT_NODE_BIN: process.execPath,
          },
        },
      );

      writeFileSync(control, '#!/bin/sh\nexit 75\n', { mode: 0o755 });
      chmodSync(control, 0o755);
      const rejected = run();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'Governed root PM2 authority rejected the installed closure',
      );

      const identity = {
        ok: true,
        schema: 'nexus.pm2-root-install.v1',
        version: '6.0.14',
        closureDigest: 'a'.repeat(64),
        payloadDigest: 'b'.repeat(64),
        packageLockSha256: 'c'.repeat(64),
        launcher: '/usr/local/bin/pm2',
        launcherSha256: 'd'.repeat(64),
        node: {
          path: process.execPath,
          version: 'v22.23.1',
          sha256: 'e'.repeat(64),
        },
        entrypoint: '/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2',
      };
      writeFileSync(
        control,
        `#!/bin/sh\n[ "\${1:-}" = assert-root-pm2-ready ] || exit 64\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
        { mode: 0o755 },
      );
      chmodSync(control, 0o755);
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('root_pm2_identity_ok version=6.0.14');

      identity.version = '6.0.15';
      writeFileSync(
        control,
        `#!/bin/sh\n[ "\${1:-}" = assert-root-pm2-ready ] || exit 64\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
        { mode: 0o755 },
      );
      chmodSync(control, 0o755);
      expect(run().status).not.toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('requires fresh same-boot preflight evidence and the exact completed small-model soak/cleanup chain before stack start', () => {
    const stack = read('scripts/quality-sonar-stack.sh');
    const validator = read('scripts/quality-sonar-start-evidence.mjs');
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-sonar-start-evidence-')));
    chmodSync(temp, 0o700);
    try {
      const capacity = [
        'MEM_AVAILABLE_KIB=20971520',
        'MIN_AVAILABLE_GIB=16',
        'DISK_FREE_PERCENT=70',
        'MIN_DISK_FREE_PERCENT=20',
        'VM_MAX_MAP_COUNT=524288',
        'FS_FILE_MAX=131072',
        'LOAD_15_MILLI=1000',
        'SWAP_IN_DELTA_PAGES=0',
        'SWAP_OUT_DELTA_PAGES=0',
        'OOM_EVENTS_LAST_24H=0',
        'SAMPLE_SECONDS=10',
      ].join('\n') + '\n';
      const snapshots: Record<string, string> = {
        'capacity.env': capacity,
        'cloudflare.txt': 'ActiveState=active\n',
        'docker.txt': 'client=27.0.0 server=27.0.0\n',
        'failures.txt': '',
        'firewall-iptables.txt': 'baseline\n',
        'firewall-nft.txt': 'baseline\n',
        'firewall-ufw.txt': 'baseline\n',
        'health.tsv': 'http://127.0.0.1:8200/health\t200\t2\tdigest\n',
        'listeners.txt': 'baseline\n',
        'pm2-after.json': '{"services":[]}\n',
        'pm2-before.json': '{"services":[]}\n',
        'routes.txt': 'baseline\n',
        'sysctl.txt': 'baseline\n',
        'tailscale.txt': 'ActiveState=active\n',
      };
      for (const [name, contents] of Object.entries(snapshots)) {
        const path = join(temp, name);
        writeFileSync(path, contents, { mode: 0o600 });
        chmodSync(path, 0o600);
      }
      const checksumLines = Object.keys(snapshots).sort().map((name) => {
        const digest = createHash('sha256').update(readFileSync(join(temp, name))).digest('hex');
        return `${digest}  ${join(temp, name)}`;
      });
      writeFileSync(join(temp, 'checksums.sha256'), `${checksumLines.join('\n')}\n`, { mode: 0o600 });
      chmodSync(join(temp, 'checksums.sha256'), 0o600);

      const bootId = '11111111-2222-3333-4444-555555555555';
      execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs',
        'record-preflight', '--directory', temp, '--host', 'serverdominguez', '--boot-id', bootId,
      ]);

      const retained = { tag: OLLAMA_RETAINED, digest: OLLAMA_DIGESTS.get(OLLAMA_RETAINED)! };
      const deleted = OLLAMA_DELETE.map((tag) => ({ tag, digest: OLLAMA_DIGESTS.get(tag)! }));
      const now = Date.now();
      const iso = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
      const staging = createObservationFixture({
        root: temp,
        phase: 'staging',
        startedAt: iso(48.3),
        intervalSeconds: 60 * 60,
      });
      const production = createObservationFixture({
        root: temp,
        phase: 'production',
        startedAt: iso(24.2),
        intervalSeconds: 60 * 60,
        previousObservation: staging,
      });
      const soakPath = production.resultPath;
      const soakRaw = readFileSync(soakPath);
      const resultPath = join(temp, 'ollama-cleanup.json');
      writeFileSync(resultPath, `${JSON.stringify({
        schema: 'nexus.ollama-large-model-cleanup-result.v1',
        host: 'serverdominguez',
        status: 'complete',
        startedAt: iso(0.09),
        completedAt: iso(0.08),
        plan: {
          schema: 'nexus.ollama-large-model-cleanup-plan.v1',
          host: 'serverdominguez',
          evidenceDigest: `sha256:${createHash('sha256').update(soakRaw).digest('hex')}`,
          inventoryFingerprint: `sha256:${'e'.repeat(64)}`,
          observationControl: {
            staging: staging.controlRequest,
            production: production.controlRequest,
          },
          retained,
          delete: deleted,
          ackPlan: `sha256:${'f'.repeat(64)}`,
        },
        finalInventory: [retained],
        retainedDigestVerifiedBeforeAndAfter: true,
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(resultPath, 0o600);

      const collectorTestEnv = { ...process.env, NEXUS_OLLAMA_COLLECTOR_TEST_MODE: '1' };
      const output = execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', bootId,
      ], { encoding: 'utf8', env: collectorTestEnv });
      expect(JSON.parse(output).status).toBe('passed');
      expect(JSON.parse(output).observationControl).toEqual({
        staging: staging.controlRequest,
        production: production.controlRequest,
      });
      expect(JSON.parse(readFileSync(join(temp, 'result.json'), 'utf8')).dockerEngineCaptured).toBe(true);
      const exactCleanup = readFileSync(resultPath);
      const tamperedCleanup = JSON.parse(exactCleanup.toString('utf8'));
      tamperedCleanup.plan.observationControl.production.requestSha256 =
        `sha256:${'9'.repeat(64)}`;
      writeFileSync(resultPath, `${JSON.stringify(tamperedCleanup)}\n`, { mode: 0o600 });
      chmodSync(resultPath, 0o600);
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', bootId,
      ], { stdio: 'pipe', env: collectorTestEnv })).toThrow();
      writeFileSync(resultPath, exactCleanup, { mode: 0o600 });
      chmodSync(resultPath, 0o600);
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ], { stdio: 'pipe', env: collectorTestEnv })).toThrow();
      writeFileSync(
        production.requestPath,
        `${readFileSync(production.requestPath, 'utf8')} `,
        { mode: 0o600 },
      );
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', bootId,
      ], { stdio: 'pipe', env: collectorTestEnv })).toThrow();
      expect(stack).toContain('/run/lock/nexus-release-sonar.lock');
      expect(stack).toContain('verify_start_evidence');
      expect(stack.indexOf('verify_start_evidence')).toBeLessThan(stack.indexOf('"${compose[@]}" up -d'));
      expect(validator).toContain('PREFLIGHT_TTL_MS = 2 * 60 * 60 * 1000');
      expect(validator).toContain("from './ollama-soak-evidence.mjs'");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('scans a clean exact origin/main, reuses only SHA-bound coverage, and never runs tests', () => {
    const scan = read('scripts/quality-sonar-scan.sh');

    expect(scan).toContain("fetch --quiet origin main");
    expect(scan).toContain("worktree add --quiet --detach");
    expect(scan).toContain('show "$runtime_sha:ops/sonarqube/sonar-project.properties"');
    expect(scan).toContain("status --porcelain=v1 --untracked-files=all");
    expect(scan).toContain("value.schemaVersion !== 'SonarCoverageEvidenceV1'");
    expect(scan).toContain('value.runtimeSha !== runtimeSha');
    expect(scan).toContain('coverage digest mismatch');
    expect(scan).toContain("crypto.createHash('sha256')");
    expect(read('ops/sonarqube/coverage-manifest.example.json')).toContain('SonarCoverageEvidenceV1');
    expect(scan).toContain('prod-deploy.lock');
    expect(scan).toContain('staging-deploy.lock');
    expect(scan).toContain('/run/lock/nexus-release-sonar.lock');
    expect(scan).toContain('exec 8<>"$mutex"');
    expect(scan).toContain('flock -n 8');
    expect(scan).toContain('exec 9<>"$fifo"');
    expect(scan).toContain('remote_mutex_pid');
    expect(scan).toContain('report-task.txt');
    expect(scan).toContain('/api/ce/task?id=');
    expect(scan).toContain('-Dsonar.qualitygate.wait=false');
    expect(scan).toContain("advisory: true");
    expect(scan).toContain("releaseGate: false");
    expect(scan).not.toMatch(/\b(?:npm|npx)\s+(?:test|run\s+test)|\bvitest\b|\bpytest\b|\bjest\b/);
  });

  it('uses one shared release/Sonar mutex and exposes only an exact least-privilege project CE aggregate', () => {
    const scan = read('scripts/quality-sonar-scan.sh');
    const stack = read('scripts/quality-sonar-stack.sh');
    const monitor = read('scripts/quality-sonar-release-state.sh');
    const sudoers = read('ops/sonarqube/nexus-sonar-release-monitor.sudoers');

    expect(scan).toContain('/run/lock/nexus-release-sonar.lock');
    expect(stack).toContain('/run/lock/nexus-release-sonar.lock');
    expect(stack).toContain('flock -n 8');
    expect(stack).toContain('exec 8<>"$SHARED_MUTEX"');
    expect(read('ops/sonarqube/nexus-release-sonar-lock.conf')).toContain('0660 root dominguez');
    expect(read('ops/sonarqube/install-layout.tsv')).toContain('/etc/tmpfiles.d/nexus-release-sonar-lock.conf');
    expect(read('scripts/quality-sonar-backup.sh')).toContain('/run/lock/nexus-release-sonar.lock');
    expect(read('scripts/quality-sonar-restore-drill.sh')).toContain('/run/lock/nexus-release-sonar.lock');
    expect(sudoers).toContain('/usr/local/sbin/quality-sonar-release-state --project nexus-hub-backend --json');
    expect(sudoers).toContain('NOPASSWD: NEXUS_SONAR_RELEASE_STATE');
    expect(monitor).toContain('/etc/sonarqube/release-monitor.token');
    expect(monitor).toContain('Sonar release-monitor token must have mode 0600');
    expect(monitor).toContain('--data-urlencode "component=$PROJECT_KEY"');
    expect(monitor).toContain('"$SONAR_URL/api/ce/component"');
    expect(monitor).toContain('Array.isArray(x.queue)');
    expect(monitor).not.toContain('/api/ce/activity');
    expect(monitor).toContain('nexus.sonarqube-release-state.v1');
    expect(monitor).toContain('printf \'Authorization: Bearer %s\\n\' "$token" >"$auth_header"');
    expect(monitor).not.toMatch(/echo\s+[^\n]*\$token/);
  });

  it('records a sequential before/after rollout comparison and fails above 5 percent p50 or p95 regression', () => {
    const script = resolve('scripts/quality-sonar-latency-gate.mjs');
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-latency-'));
    chmodSync(temp, 0o700);
    const writeSample = (path: string, phase: 'before' | 'after', latency: number, capturedAt: string) => {
      const samplesMs = Array.from({ length: 50 }, () => latency);
      writeFileSync(path, `${JSON.stringify({
        schema: 'nexus.sonarqube-app-latency-sample.v1',
        phase,
        runtimeSha: 'a'.repeat(40),
        service: 'nexus-hub',
        url: 'http://127.0.0.1:8200/health',
        sampleCount: 50,
        warmupCount: 5,
        timeoutMs: 5000,
        p50Ms: latency,
        p95Ms: latency,
        maxMs: latency,
        samplesMs,
        capturedAt,
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    };
    try {
      const before = join(temp, 'before.json');
      const after = join(temp, 'after.json');
      const now = Date.now();
      writeSample(before, 'before', 100, new Date(now - 3 * 60_000).toISOString());
      writeSample(after, 'after', 104, new Date(now - 60_000).toISOString());
      const scan = join(temp, 'scan.json');
      writeFileSync(scan, `${JSON.stringify({
        schemaVersion: 'SonarAdvisoryScanV1',
        advisory: true,
        releaseGate: false,
        runtimeSha: 'a'.repeat(40),
        ceTaskId: 'ce-task-001',
        analysisId: 'analysis-001',
        ceStatus: 'SUCCESS',
        qualityGateStatus: 'OK',
        coverageImported: true,
        completedAt: new Date(now - 2 * 60_000).toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(scan, 0o600);
      const pass = join(temp, 'pass.json');
      execFileSync(process.execPath, [script, 'compare', '--before', before, '--after', after, '--sonar-scan-evidence', scan, '--output', pass]);
      expect(JSON.parse(readFileSync(pass, 'utf8'))).toMatchObject({
        status: 'passed',
        rolloutGate: true,
        releaseGate: false,
        maximumRegressionPercent: 5,
        p50RegressionPercent: 4,
        p95RegressionPercent: 4,
      });

      const regressed = join(temp, 'regressed.json');
      writeSample(regressed, 'after', 106, new Date(now - 30_000).toISOString());
      const failure = join(temp, 'failure.json');
      expect(() => execFileSync(process.execPath, [script, 'compare', '--before', before, '--after', regressed, '--sonar-scan-evidence', scan, '--output', failure], { stdio: 'pipe' })).toThrow();
      expect(JSON.parse(readFileSync(failure, 'utf8')).status).toBe('failed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('encrypts database backups before S3 upload, retains 7/4, and restores into fresh drill volumes', () => {
    const backup = read('scripts/quality-sonar-backup.sh');
    const restore = read('scripts/quality-sonar-restore-drill.sh');
    const drillCompose = read('ops/sonarqube/compose.drill.yaml');
    const backupService = read(
      'ops/sonarqube/systemd/nexus-sonarqube-backup.service',
    );
    const runbook = read('ops/sonarqube/README.md');

    expect(backup).toContain('age --encrypt');
    expect(backup.indexOf('age --encrypt')).toBeLessThan(backup.indexOf('s3api put-object'));
    expect(backup).toContain('prune_tier daily 7');
    expect(backup).toContain('prune_tier weekly 4');
    expect(backup).toContain('pg_restore --list');
    expect(backup).toContain('--enable-timer');
    expect(backup).toContain('--verify-freshness');
    expect(backup).toContain("schemaVersion: 'SonarBackupSuccessV1'");
    expect(backup).toContain('remoteObjectVerified: true');
    expect(backup).toContain('systemctl enable --now "$BACKUP_TIMER"');
    expect(backupService).toContain('Restart=on-failure');
    expect(backupService).toContain('RestartSec=15min');
    expect(backupService).toContain('TimeoutStartSec=30min');
    expect(runbook).toContain(
      'installation alone intentionally leaves the timer disabled',
    );
    expect(runbook).toContain('--max-age-hours 26');
    expect(restore).toContain('age --decrypt');
    expect(restore).toContain('Refusing restore drill while the live advisory Sonar stack is running');
    expect(restore).toContain('freshElasticsearchVolume: true');
    expect(restore).toContain('reindexStartupVerified: true');
    expect(restore).toContain('down --volumes --remove-orphans');
    expect(drillCompose).toContain('127.0.0.1:19000:9000');
    expect(drillCompose).toContain('drill_sonarqube_data');
  });

  it('fails closed when the remote Sonar backup success receipt is stale or invalid', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-backup-freshness-'));
    const bin = join(temp, 'bin');
    const receipt = join(temp, 'last-backup-success.v1.json');
    mkdirSync(bin);
    chmodSync(temp, 0o700);
    const writeReceipt = (completedAt: string, remoteObjectVerified = true) => {
      writeFileSync(receipt, `${JSON.stringify({
        schemaVersion: 'SonarBackupSuccessV1',
        encrypted: true,
        remoteObjectVerified,
        dailyKey: 'nexus-hub/sonarqube/daily/nexus-sonarqube-20260724T120000Z.dump.age',
        encryptedSha256: 'a'.repeat(64),
        weeklyUploaded: false,
        retention: { daily: 7, weekly: 4 },
        completedAt,
      })}\n`, { mode: 0o600 });
      chmodSync(receipt, 0o600);
    };
    try {
      writeFileSync(
        join(bin, 'id'),
        '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'stat'),
        '#!/bin/sh\ncase "$*" in *%U:%G:%a:%h*) echo root:root:600:1 ;; *) exec /usr/bin/stat "$@" ;; esac\n',
        { mode: 0o755 },
      );
      chmodSync(join(bin, 'id'), 0o755);
      chmodSync(join(bin, 'stat'), 0o755);
      const run = () => spawnSync(
        'bash',
        [
          'scripts/quality-sonar-backup.sh',
          '--verify-freshness',
          '--max-age-hours',
          '26',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            NEXUS_RELEASE_TEST_MODE: '1',
            SONAR_BACKUP_SUCCESS_RECEIPT: receipt,
          },
        },
      );

      writeReceipt(new Date().toISOString());
      const fresh = run();
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(fresh.stdout).toContain('sonar_backup_fresh');

      writeReceipt(new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString());
      expect(run().status).not.toBe(0);

      writeReceipt(new Date().toISOString(), false);
      expect(run().status).not.toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps every shell asset syntactically valid', () => {
    const scripts = [
      'quality-sonar-backup.sh',
      'quality-sonar-health.sh',
      'quality-sonar-preflight.sh',
      'quality-sonar-resolve-images.sh',
      'quality-sonar-release-state.sh',
      'quality-sonar-restore-drill.sh',
      'quality-sonar-scan.sh',
      'quality-sonar-stack.sh',
      'quality-sonar-systemd-install.sh',
    ];
    for (const script of scripts) {
      expect(() => execFileSync('bash', ['-n', `scripts/${script}`])).not.toThrow();
    }
    for (const script of [
      'ollama-observation-collector.mjs',
      'ollama-soak-evidence.mjs',
      'quality-sonar-start-evidence.mjs',
      'quality-sonar-latency-gate.mjs',
    ]) {
      expect(() => execFileSync(process.execPath, ['--check', `scripts/${script}`])).not.toThrow();
    }
  });
});
