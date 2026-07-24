import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const PREFLIGHT = join(ROOT, 'scripts', 'remote-release-preflight.sh');
const READINESS = join(ROOT, 'scripts', 'remote-release-readiness.sh');
const ENV_PARITY = join(ROOT, 'scripts', 'env-parity-check.sh');
const roots: string[] = [];
const runtimeSha = 'a'.repeat(40);

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function executable(file: string, body: string) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function baseEnv(role: 'staging' | 'production', overrides: string[] = []) {
  const lines = [
    `NODE_ENV=${role}`,
    'DATABASE_PATH=./data/bot.db',
    `CONTENT_ENGINE_PORT=${role === 'staging' ? 8101 : 8100}`,
    ...(role === 'staging' ? ['PORTAL_PORT=8201'] : []),
    'NEXUS_BACKEND_PORT=8200',
    'OAUTH_ENCRYPTION_KEY=do-not-print-oauth',
    'INTERNAL_API_SECRET=do-not-print-internal',
    'AI_CALL_TIMEOUT_MS=30',
    'OPENAI_API_KEY=do-not-print-provider',
    'PORTAL_REQUIRE_SESSION_AUTH=true',
    'PORTAL_SESSION_SECRET=do-not-print-portal',
    ...(role === 'production' ? [
      'BACKUP_ENCRYPT=true',
      'BACKUP_KEY=do-not-print-backup',
      'CONTENT_WORKSPACE_V1_MODE=write',
      'CONTENT_WORKSPACE_V1_GLOBAL_WRITE=false',
      'CONTENT_WORKSPACE_V1_USER_IDS=41',
      'CONTENT_WORKSPACE_V1_TENANT_IDS=',
      'CONTENT_WORKSPACE_V1_CORE_WRITES=true',
      'CONTENT_WORKSPACE_V1_REVISION_WRITES=true',
      'CONTENT_WORKSPACE_V1_LINEAGE_WRITES=true',
      'CONTENT_WORKSPACE_V1_AGENT_WRITES=true',
      'CONTENT_WORKSPACE_V1_SCHEDULE_WRITES=true',
      'CONTENT_WORKSPACE_V1_RECOVERY_WRITES=true',
    ] : []),
    ...overrides,
  ];
  return `${lines.join('\n')}\n`;
}

function releaseFixture(role: 'staging' | 'production') {
  const root = mkdtempSync(join(tmpdir(), 'nexus-release-safeguards-'));
  roots.push(root);
  const base = join(root, role);
  const release = join(base, 'releases', 'candidate');
  const data = join(base, 'data');
  mkdirSync(join(release, 'dist', 'tools'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(base, '.env'), baseEnv(role), { mode: 0o600 });
  symlinkSync(join(base, '.env'), join(release, '.env'));
  symlinkSync(join(ROOT, 'node_modules'), join(release, 'node_modules'), 'dir');
  writeFileSync(join(release, 'dist', 'tools', 'owner-bootstrap-preflight.js'), `
if (process.env.FAIL_OWNER_PREFLIGHT === '1') process.exit(9);
console.log('fixture owner=' + (process.env.OWNER_TELEGRAM_USER_IDS || 'private-owner'));
console.log('fixture database=' + process.env.DATABASE_PATH);
`);
  writeFileSync(join(release, 'dist', 'tools', 'content-workspace-rollout-preflight.js'), `
if (process.env.CONTENT_WORKSPACE_V1_MODE !== 'write'
  || process.env.CONTENT_WORKSPACE_V1_USER_IDS !== '41'
  || process.env.CONTENT_WORKSPACE_V1_GLOBAL_WRITE !== 'false') {
  console.error('fixture-private-rollout-value=' + process.env.CONTENT_WORKSPACE_V1_USER_IDS);
  process.exit(8);
}
console.log('fixture-private-owner=41');
`);
  const db = new Database(join(data, 'bot.db'));
  db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
  db.close();
  return { root, base, release, data };
}

function runPreflight(
  fixture: ReturnType<typeof releaseFixture>,
  role: 'staging' | 'production',
  env = process.env,
  requireContentWorkspaceOwnerWrite = false,
) {
  const args = [
    PREFLIGHT,
    '--role', role,
    '--base-dir', fixture.base,
    '--release-dir', fixture.release,
    '--node-bin', process.execPath,
  ];
  if (requireContentWorkspaceOwnerWrite) args.push('--require-content-workspace-owner-write');
  return spawnSync('bash', args, { cwd: ROOT, encoding: 'utf8', env: { ...env } });
}

function writeCurl(bin: string, fixture: ReturnType<typeof releaseFixture>) {
  const counter = join(fixture.root, 'curl-backend-counter');
  executable(bin, `#!/usr/bin/env bash
set -euo pipefail
output=''; url=''; header=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -H) header="$2"; shift 2 ;;
    http://*) url="$1"; shift ;;
    --connect-timeout|--max-time) shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ]
case "$url" in
  *:8200/health|*:8201/health)
    count=0
    [ ! -f '${counter}' ] || count=$(cat '${counter}')
    count=$((count + 1)); printf '%s' "$count" > '${counter}'
    delay="\${CURL_DELAY_BACKEND_ATTEMPTS:-0}"
    [ "$count" -gt "$delay" ] || exit 7
    printf '%s\n' '{"status":"healthy","server":{"status":"online"},"database":"connected"}' > "$output"
    ;;
  *:8100/ready|*:8101/ready)
    [ -n "$header" ] && grep -q 'x-internal-secret: do-not-print-internal' "\${header#@}"
    printf '%s\n' '{"status":"ready","internalAuthConfigured":true}' > "$output"
    ;;
  *) exit 22 ;;
esac
`);
}

function writePm2(bin: string, fixture: ReturnType<typeof releaseFixture>, role: 'staging' | 'production') {
  const backend = role === 'staging' ? 'nexus-hub-staging' : 'nexus-hub';
  const content = role === 'staging' ? 'content-engine-staging' : 'content-engine';
  const counter = join(fixture.root, 'pm2-counter');
  executable(bin, `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = jlist ] || exit 2
count=0
[ ! -f '${counter}' ] || count=$(cat '${counter}')
count=$((count + 1)); printf '%s' "$count" > '${counter}'
restart=3
if [ "\${PM2_MUTATE_RESTART:-0}" = 1 ] && [ "$count" -gt 1 ]; then restart=4; fi
observed_sha='${runtimeSha}'
if [ "\${PM2_WRONG_SHA:-0}" = 1 ]; then observed_sha='${'b'.repeat(40)}'; fi
cat <<JSON
[
  {"name":"${backend}","pid":101,"pm2_env":{"status":"online","pm_cwd":"${fixture.release}","pm_exec_path":"${fixture.release}/dist/index.js","exec_interpreter":"node","NEXUS_RELEASE_SHA":"$observed_sha","SENTRY_RELEASE":"$observed_sha","restart_time":$restart,"unstable_restarts":0,"pm_uptime":1000}},
  {"name":"${content}","pid":102,"pm2_env":{"status":"online","pm_cwd":"${fixture.release}/content-engine","pm_exec_path":"${fixture.release}/content-engine/.venv/bin/python3.12","exec_interpreter":"none","NEXUS_RELEASE_SHA":"$observed_sha","SENTRY_RELEASE":"$observed_sha","restart_time":2,"unstable_restarts":0,"pm_uptime":1000}}
]
JSON
`);
}

function runReadiness(
  fixture: ReturnType<typeof releaseFixture>,
  role: 'staging' | 'production',
  env: NodeJS.ProcessEnv = process.env,
) {
  const bin = join(fixture.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, 'curl');
  const pm2 = join(bin, 'pm2');
  writeCurl(curl, fixture);
  writePm2(pm2, fixture, role);
  return spawnSync('bash', [
    READINESS,
    '--role', role,
    '--base-dir', fixture.base,
    '--release-dir', fixture.release,
    '--runtime-sha', runtimeSha,
    '--pm2-bin', pm2,
    '--node-bin', process.execPath,
    '--curl-bin', curl,
    '--output', join(fixture.root, 'readiness.json'),
    '--readiness-attempts', '4',
    '--poll-seconds', '0',
    '--stability-seconds', '0',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...env } });
}

describe('exact release remote preflight', () => {
  it('enforces private env ownership/mode and required keys without printing values', () => {
    const fixture = releaseFixture('production');
    const accepted = runPreflight(fixture, 'production');
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain('release_preflight_ok role=production');
    expect(accepted.stdout).toContain('envOwnership=validated');
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain('do-not-print');
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain('private-owner');
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain(fixture.base);

    chmodSync(join(fixture.base, '.env'), 0o644);
    const unsafeMode = runPreflight(fixture, 'production');
    expect(unsafeMode.status).not.toBe(0);
    expect(unsafeMode.stderr).toContain('mode must be 400 or 600');
  });

  it('warns for a staging owner-bootstrap failure but blocks production', () => {
    const staging = releaseFixture('staging');
    const stagingResult = runPreflight(staging, 'staging', { ...process.env, FAIL_OWNER_PREFLIGHT: '1' });
    expect(stagingResult.status, stagingResult.stderr).toBe(0);
    expect(stagingResult.stderr).toContain('warning: staging owner bootstrap preflight');

    const production = releaseFixture('production');
    const productionResult = runPreflight(production, 'production', { ...process.env, FAIL_OWNER_PREFLIGHT: '1' });
    expect(productionResult.status).toBe(9);
    expect(productionResult.stderr).toContain('production owner bootstrap preflight failed');
  });

  it('fails closed on missing conditional credentials and a tampered env link', () => {
    const fixture = releaseFixture('production');
    writeFileSync(join(fixture.base, '.env'), baseEnv('production', ['PORTAL_SESSION_SECRET=']), { mode: 0o600 });
    const missing = runPreflight(fixture, 'production');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('PORTAL_SESSION_SECRET');
    expect(missing.stderr).not.toContain('do-not-print');

    rmSync(join(fixture.release, '.env'));
    const other = join(fixture.root, 'other.env');
    writeFileSync(other, baseEnv('production'), { mode: 0o600 });
    symlinkSync(other, join(fixture.release, '.env'));
    const tampered = runPreflight(fixture, 'production');
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('does not resolve to the canonical');
  });

  it('requires a privacy-safe scoped owner cohort when the canonical Content cutover asks for it', () => {
    const fixture = releaseFixture('production');
    const accepted = runPreflight(fixture, 'production', process.env, true);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain('contentWorkspace=scoped_owner_write');
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain('fixture-private-owner');
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain('41');

    writeFileSync(join(fixture.base, '.env'), baseEnv('production', [
      'CONTENT_WORKSPACE_V1_USER_IDS=99',
    ]), { mode: 0o600 });
    const rejected = runPreflight(fixture, 'production', process.env, true);
    expect(rejected.status).toBe(8);
    expect(rejected.stderr).toContain('scoped-owner write preflight failed');
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain('99');
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain('fixture-private-rollout-value');
  });
});

describe('exact release extended readiness', () => {
  it('proves native SQLite, authenticated Content Engine, and stable exact PM2 identity', () => {
    const fixture = releaseFixture('staging');
    const result = runReadiness(fixture, 'staging');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const evidence = JSON.parse(readFileSync(join(fixture.root, 'readiness.json'), 'utf8'));
    expect(evidence).toMatchObject({
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha,
      stabilitySeconds: 0,
      stabilityObservedSeconds: expect.any(Number),
      checks: {
        nativeBinding: true,
        sqliteIntegrity: true,
        authenticatedContentEngine: true,
        pm2ExactIdentity: true,
        pm2RestartStable: true,
      },
    });
    expect(evidence.stabilityObservedSeconds).toBeGreaterThanOrEqual(0);
    expect(Date.parse(evidence.stabilityCompletedAt)).toBeGreaterThanOrEqual(
      Date.parse(evidence.stabilityStartedAt),
    );
  });

  it('writes evidence only through an inherited root-broker descriptor when requested', () => {
    const fixture = releaseFixture('staging');
    const bin = join(fixture.root, 'bin');
    mkdirSync(bin, { recursive: true });
    const curl = join(bin, 'curl');
    const pm2 = join(bin, 'pm2');
    writeCurl(curl, fixture);
    writePm2(pm2, fixture, 'staging');
    const output = join(fixture.root, 'readiness-fd.json');
    const descriptor = openSync(output, 'w+', 0o600);
    let result;
    try {
      result = spawnSync('bash', [
        READINESS,
        '--role', 'staging',
        '--base-dir', fixture.base,
        '--release-dir', fixture.release,
        '--runtime-sha', runtimeSha,
        '--pm2-bin', pm2,
        '--node-bin', process.execPath,
        '--curl-bin', curl,
        '--output-fd', '3',
        '--readiness-attempts', '4',
        '--poll-seconds', '0',
        '--stability-seconds', '0',
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
      });
    } finally {
      closeSync(descriptor);
    }
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha,
    });

    const conflicting = spawnSync('bash', [
      READINESS,
      '--role', 'staging',
      '--base-dir', fixture.base,
      '--release-dir', fixture.release,
      '--runtime-sha', runtimeSha,
      '--pm2-bin', pm2,
      '--node-bin', process.execPath,
      '--curl-bin', curl,
      '--output', output,
      '--output-fd', '3',
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
    expect(conflicting.status).toBe(64);
    expect(conflicting.stderr).toContain('mutually exclusive');
  });

  it('rejects a PM2 restart between independent samples', () => {
    const fixture = releaseFixture('production');
    const result = runReadiness(fixture, 'production', { ...process.env, PM2_MUTATE_RESTART: '1' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('PM2 restart stability failed: nexus-hub');
  });

  it('polls boundedly until delayed listening sockets are ready', () => {
    const fixture = releaseFixture('staging');
    const result = runReadiness(fixture, 'staging', {
      ...process.env,
      CURL_DELAY_BACKEND_ATTEMPTS: '2',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const evidence = JSON.parse(readFileSync(join(fixture.root, 'readiness.json'), 'utf8'));
    expect(evidence.readinessAttempts).toBe(3);
    expect(result.stdout).toContain('readinessAttempts=3');
  });

  it('never accepts healthy endpoints when the bounded PM2 identity proof is wrong', () => {
    const fixture = releaseFixture('production');
    const result = runReadiness(fixture, 'production', { ...process.env, PM2_WRONG_SHA: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not converge after 4 attempts');
    expect(() => readFileSync(join(fixture.root, 'readiness.json'))).toThrow();
  });

  it('rejects database tampering before it can emit readiness evidence', () => {
    const fixture = releaseFixture('production');
    writeFileSync(join(fixture.data, 'bot.db'), 'not sqlite');
    const result = runReadiness(fixture, 'production');
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(fixture.root, 'readiness.json'))).toThrow();
  });
});

describe('canonical environment parity', () => {
  function parityFixture() {
    const root = mkdtempSync(join(tmpdir(), 'nexus-env-parity-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const staging = join(root, 'staging');
    const production = join(root, 'production');
    mkdirSync(bin); mkdirSync(staging); mkdirSync(production);
    executable(join(bin, 'ssh'), '#!/usr/bin/env bash\nset -euo pipefail\nshift\nexec "$@"\n');
    writeFileSync(join(staging, '.env'), [
      'NODE_ENV=staging', 'AI_CALL_TIMEOUT_MS=60', 'OAUTH_ENCRYPTION_KEY=stage',
      'INTERNAL_API_SECRET=stage',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(join(production, '.env'), [
      'NODE_ENV=production', 'BACKUP_ENCRYPT=true', 'BACKUP_KEY=prod',
      'AI_CALL_TIMEOUT_MS=30', 'OAUTH_ENCRYPTION_KEY=prod', 'INTERNAL_API_SECRET=prod',
    ].join('\n'), { mode: 0o600 });
    return { root, bin, staging, production };
  }

  it('compares configuration shape without comparing or exposing secret values', () => {
    const fixture = parityFixture();
    const output = execFileSync('bash', [
      ENV_PARITY, '--server', 'fixture', '--staging-dir', fixture.staging, '--prod-dir', fixture.production,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` } });
    expect(output).toContain('env_parity_ok');
    expect(output).not.toContain('stage');
    expect(output).not.toContain('prod');
  });

  it('fails on unsafe env permissions and missing production backup keys', () => {
    const fixture = parityFixture();
    chmodSync(join(fixture.production, '.env'), 0o644);
    const unsafe = spawnSync('bash', [
      ENV_PARITY, '--server', 'fixture', '--staging-dir', fixture.staging, '--prod-dir', fixture.production,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` } });
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stdout).toContain('unsafe_env_mode');

    chmodSync(join(fixture.production, '.env'), 0o600);
    writeFileSync(join(fixture.production, '.env'), [
      'NODE_ENV=production', 'BACKUP_ENCRYPT=true', 'AI_CALL_TIMEOUT_MS=30',
      'OAUTH_ENCRYPTION_KEY=prod', 'INTERNAL_API_SECRET=prod',
    ].join('\n'), { mode: 0o600 });
    const missing = spawnSync('bash', [
      ENV_PARITY, '--server', 'fixture', '--staging-dir', fixture.staging, '--prod-dir', fixture.production,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` } });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('BACKUP_KEY:prod_required_missing');
  });
});

describe('release shell entrypoints', () => {
  it('keeps the sandbox local-only and routes its harness to exact-release tests', () => {
    const up = readFileSync(join(ROOT, 'scripts', 'release-sandbox-up.sh'), 'utf8');
    const smoke = readFileSync(join(ROOT, 'scripts', 'release-sandbox-smoke.sh'), 'utf8');
    const harness = readFileSync(join(ROOT, 'scripts', 'release-sandbox-deploy-harness.sh'), 'utf8');
    expect(harness).toContain('release-runtime-safeguards.test.ts');
    expect(harness).toContain('exact-promotion-operational-safety.test.ts');
    expect(up + smoke + harness).not.toContain('dominguez@serverdominguez');
    expect(up + smoke + harness).not.toContain('rsync ');
  });
});
