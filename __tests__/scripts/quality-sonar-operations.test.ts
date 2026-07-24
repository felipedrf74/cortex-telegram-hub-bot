import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
    expect(stack).not.toMatch(/docker\s+(system\s+prune|volume\s+prune|image\s+prune)/);
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
      expect(JSON.parse(readFileSync(join(temp, 'result.json'), 'utf8')).dockerEngineCaptured).toBe(true);
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

    expect(backup).toContain('age --encrypt');
    expect(backup.indexOf('age --encrypt')).toBeLessThan(backup.indexOf('s3api put-object'));
    expect(backup).toContain('prune_tier daily 7');
    expect(backup).toContain('prune_tier weekly 4');
    expect(backup).toContain('pg_restore --list');
    expect(restore).toContain('age --decrypt');
    expect(restore).toContain('Refusing restore drill while the live advisory Sonar stack is running');
    expect(restore).toContain('freshElasticsearchVolume: true');
    expect(restore).toContain('reindexStartupVerified: true');
    expect(restore).toContain('down --volumes --remove-orphans');
    expect(drillCompose).toContain('127.0.0.1:19000:9000');
    expect(drillCompose).toContain('drill_sonarqube_data');
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
