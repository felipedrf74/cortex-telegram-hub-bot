import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const control = path.resolve('scripts/remote-promotion-control.sh');
const broker = path.resolve('scripts/remote-promotion-worker-control.sh');
const runner = path.resolve('scripts/remote-promotion-transaction.sh');
const authorization = path.resolve('scripts/promotion-authorization.mjs');
const promotion = path.resolve('scripts/promote-exact-release.sh');
const installer = path.resolve('scripts/remote-promotion-systemd-install.sh');
const trustedAttestor = path.resolve('scripts/trusted-release-runtime-attestation.mjs');
const unit = path.resolve('scripts/systemd/nexus-release-promotion@.service');
const recoveryUnit = path.resolve('scripts/systemd/nexus-release-promotion-recovery.service');
const migrationGate = path.resolve('scripts/complete-promotion-migration-gate.mjs');

const canonicalJson = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

describe('persistent systemd promotion transaction v2', () => {
  let root: string;
  let stateRoot: string;
  let requestPath: string;
  let envelopePath: string;
  let publicKeyPath: string;
  let privateKeyPath: string;
  let authWrapper: string;
  let systemctlLog: string;
  let systemctlActive: string;
  const id = '20260722T120000Z-1234-abcdef123456';

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-promotion-control-')));
    stateRoot = path.join(root, 'state');
    requestPath = path.join(root, 'request.json');
    envelopePath = path.join(root, 'request.envelope.json');
    publicKeyPath = path.join(root, 'owner-public.pem');
    privateKeyPath = path.join(root, 'owner-private.pem');
    systemctlLog = path.join(root, 'systemctl.log');
    systemctlActive = path.join(root, 'systemctl.active');
    fs.writeFileSync(path.join(root, 'release-sonar.lock'), '', { mode: 0o660 });
    const pair = generateKeyPairSync('ed25519');
    fs.writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    authWrapper = path.join(bin, 'promotion-auth');
    fs.writeFileSync(authWrapper, `#!/usr/bin/env bash\nexec node ${JSON.stringify(authorization)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = is-active ]; then [ -f "$SYSTEMCTL_ACTIVE" ] && exit 0 || exit 3; fi
if [ "\${1:-}" = start ]; then
  : > "$SYSTEMCTL_ACTIVE"
  if [[ " $* " != *" --no-block "* ]]; then
    unit="\${!#}"; transaction="\${unit#nexus-release-promotion@}"; transaction="\${transaction%.service}"
    journal="$NEXUS_PROMOTION_STATE_ROOT/transactions/$transaction/state/journal.json"
    authority="$NEXUS_PROMOTION_STATE_ROOT/transactions/$transaction/authority.json"
    request_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.requestSha256)' "$authority")"
    mkdir -p "\${journal%/*}"
    printf '{"schema":"nexus.promotion-transaction-journal.v1","transactionId":"%s","requestSha256":"%s","phase":"recovery_complete","status":"recovered"}\n' "$transaction" "$request_sha" > "$journal"
  fi
fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'timeout'), `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) break ;; esac; done
exec "$@"
`, { mode: 0o755 });
    writeRequest();
    signRequest();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function request(overrides: Record<string, unknown> = {}) {
    const createdAt = new Date();
    return {
      schema: 'nexus.promotion-transaction-request.v1',
      transactionId: id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
      ownerAuthorization: 'explicit',
      productionBase: '/home/dominguez/telegram-hub-bot',
      predecessor: {
        runtime: '/home/dominguez/telegram-hub-bot/releases/previous-aaaaaaaaaaaa',
        sha: 'a'.repeat(40),
        artifactDigest: 'e'.repeat(64),
        installedRuntimeDigest: 'f'.repeat(64),
      },
      target: {
        runtime: '/home/dominguez/telegram-hub-bot/releases/target-bbbbbbbbbbbb',
        sha: 'b'.repeat(40),
        sentryRelease: 'b'.repeat(40),
        artifactDigest: 'c'.repeat(64),
        installedRuntimeDigest: 'd'.repeat(64),
        version: '4.14.231',
      },
      backupDir: '/home/dominguez/backups/nexushub',
      preparedRuntimeDir: '/home/dominguez/backups/nexushub/.runtime-stage-Ab12',
      pm2Bin: '/usr/local/bin/pm2',
      publicBaseUrl: 'https://api.nexushub.me',
      stabilitySeconds: 60,
      gateTimeoutSeconds: 60,
      migration: { required: false },
      ...overrides,
    };
  }

  function writeRequest(overrides: Record<string, unknown> = {}) {
    fs.writeFileSync(requestPath, `${JSON.stringify(request(overrides), null, 2)}\n`, { mode: 0o600 });
  }

  function signRequest() {
    fs.rmSync(envelopePath, { force: true });
    const result = spawnSync('node', [authorization, 'sign-request', '--input', requestPath,
      '--private-key', privateKeyPath, '--output', envelopePath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }

  function writeRawEnvelope(payload: Record<string, unknown>) {
    const privateKey = fs.readFileSync(privateKeyPath);
    const envelope = {
      schema: 'nexus.promotion-transaction-request-envelope.v1',
      keyId: 'nexus-owner-promotion-2026',
      signatureAlgorithm: 'ed25519',
      payload,
      signature: cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
    };
    fs.writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  }

  function env(extra: NodeJS.ProcessEnv = {}) {
    return {
      ...process.env,
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_PROMOTION_SYSTEMCTL_BIN: path.join(root, 'bin', 'systemctl'),
      NEXUS_PROMOTION_AUTH_BIN: authWrapper,
      NEXUS_PROMOTION_OWNER_PUBLIC_KEY: publicKeyPath,
      NEXUS_PROMOTION_FLOCK_BIN: path.join(root, 'bin', 'flock'),
      NEXUS_PROMOTION_TIMEOUT_BIN: path.join(root, 'bin', 'timeout'),
      NEXUS_PROMOTION_RELEASE_SONAR_LOCK: path.join(root, 'release-sonar.lock'),
      SYSTEMCTL_LOG: systemctlLog,
      SYSTEMCTL_ACTIVE: systemctlActive,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      ...extra,
    };
  }

  function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [control, ...args], { encoding: 'utf8', env: env(extra) });
  }

  it('launches one signed immutable request atomically and reconciles an identical retry', () => {
    const first = run(['launch', envelopePath]);
    expect(first.status, first.stderr).toBe(0);
    const firstBody = JSON.parse(first.stdout);
    expect(firstBody.transactionId).toBe(id);
    expect(firstBody.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fs.statSync(path.join(stateRoot, 'requests', `${id}.json`)).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(stateRoot, 'active.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(stateRoot, 'transactions', id)).mode & 0o777).toBe(0o711);
    expect(fs.statSync(path.join(stateRoot, 'transactions', id, 'state')).mode & 0o777).toBe(0o700);

    const second = run(['launch', envelopePath]);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).requestSha256).toBe(firstBody.requestSha256);
    const starts = fs.readFileSync(systemctlLog, 'utf8').split('\n').filter((line) => line.includes('start --no-block'));
    expect(starts).toEqual([`start --no-block nexus-release-promotion@${id}.service`]);
    expect(run(['assert-idle']).status).toBe(73);
  });

  it('rejects forged, expired, unsigned, and non-exact-soak owner authority', () => {
    const forged = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    forged.payload.target.version = '9.9.9';
    fs.writeFileSync(envelopePath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    expect(run(['launch', envelopePath]).status).toBe(77);

    const expired = request({
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    writeRawEnvelope(expired);
    const expiredResult = run(['launch', envelopePath]);
    expect(expiredResult.status).toBe(77);
    expect(expiredResult.stderr).toContain('verification failed');

    writeRequest({ stabilitySeconds: 59 });
    writeRawEnvelope(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
    expect(run(['launch', envelopePath]).status).toBe(77);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(false);

    const missingPredecessorIdentity = request();
    delete (missingPredecessorIdentity.predecessor as { artifactDigest?: string }).artifactDigest;
    writeRawEnvelope(missingPredecessorIdentity);
    const missingIdentity = run(['launch', envelopePath]);
    expect(missingIdentity.status).toBe(77);
    expect(missingIdentity.stderr).toContain('verification failed');
  });

  it('does not let deploy-writable artifacts forge terminal authority or clear the active transaction', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const worker = path.join(stateRoot, 'transactions', id, 'worker');
    // Simulate everything the dominguez application account can mutate.
    fs.writeFileSync(path.join(worker, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1', transactionId: id,
      phase: 'completed', status: 'completed',
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'worker-progress.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1', transactionId: id,
      phase: 'completed', status: 'completed',
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'result.env'), `NEXUS_TRANSACTION_ID=${id}\n`, { mode: 0o600 });

    const status = run(['status', id]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).status).toBe('pending');
    expect(run(['assert-idle']).status).toBe(73);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(true);
    expect(run(['fetch', id, 'result']).status).toBe(75);
    expect(run(['launch', envelopePath]).status).toBe(0);
  });

  it('recovers only the authoritative active ID synchronously before PM2 boot ordering', () => {
    expect(run(['launch', envelopePath]).status).toBe(0);
    const stray = '20260722T120001Z-1235-fedcba654321';
    fs.writeFileSync(path.join(stateRoot, 'requests', `${stray}.json`), '{}\n');
    const worker = path.join(stateRoot, 'transactions', id, 'worker');
    fs.writeFileSync(path.join(worker, 'recovery-armed'), 'armed\n');
    fs.writeFileSync(path.join(worker, 'journal.json'), `${JSON.stringify({ transactionId: id, phase: 'recovery_required', status: 'recovery_required' })}\n`);

    const recovered = run(['recover-all']);
    expect(recovered.status, recovered.stderr).toBe(0);
    const lines = fs.readFileSync(systemctlLog, 'utf8').trim().split('\n');
    expect(lines).toContain(`start nexus-release-promotion@${id}.service`);
    expect(lines.some((line) => line.includes(stray))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(false);
  });

  it('fails closed before worker execution when the durable release/Sonar flock is unavailable', () => {
    expect(run(['launch', envelopePath]).status).toBe(0);
    const deniedFlock = path.join(root, 'bin', 'flock-denied');
    fs.writeFileSync(deniedFlock, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({ NEXUS_PROMOTION_FLOCK_BIN: deniedFlock }),
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('shared release/Sonar mutex is unavailable');
    expect(fs.existsSync(path.join(stateRoot, 'transactions', id, 'worker', 'journal.json'))).toBe(false);
  });

  it('fails staging mutex acquisition closed before its capacity gate', () => {
    const deniedBin = path.join(root, 'denied-bin');
    fs.mkdirSync(deniedBin);
    fs.writeFileSync(path.join(deniedBin, 'ssh'), '#!/usr/bin/env bash\nexit 75\n', { mode: 0o755 });
    const gates = path.resolve('scripts/lib/release-gates.sh');

    const result = spawnSync('bash', ['-c', 'source "$1"; release_acquire_remote_sonar_lock fixture-host', 'bash', gates], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${deniedBin}:${process.env.PATH ?? ''}`, TMPDIR: root },
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('shared remote release/Sonar mutex is unavailable');
  });

  it('blocks local rollback pruning until the exact encrypted off-host escrow is confirmed', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'escrow-fixture');
    const backupDir = path.join(fixture, 'backups');
    const production = path.join(fixture, 'production');
    const target = path.join(production, 'releases', 'target-runtime');
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'bin'), { recursive: true });
    fs.mkdirSync(backupDir);
    fs.symlinkSync(target, path.join(production, 'current'));
    fs.writeFileSync(path.join(fixture, 'bin', 'pm2'), `#!/usr/bin/env bash
if [ "\${1:-}" = jlist ]; then printf '%s\n' '${JSON.stringify([
  { name: 'nexus-hub', pm2_env: { status: 'online', pm_cwd: target, NEXUS_RELEASE_SHA: 'b'.repeat(40), SENTRY_RELEASE: 'b'.repeat(40) } },
  { name: 'content-engine', pm2_env: { status: 'online', pm_cwd: `${target}/content-engine`, NEXUS_RELEASE_SHA: 'b'.repeat(40), SENTRY_RELEASE: 'b'.repeat(40) } },
])}'; fi
`, { mode: 0o755 });
    const backups: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const file = path.join(backupDir, `v4.14.${200 + index}.tar.gz`);
      fs.writeFileSync(file, `rollback-${index}\n`, { mode: 0o600 });
      fs.utimesSync(file, new Date(1_700_000_000_000 + index * 1000), new Date(1_700_000_000_000 + index * 1000));
      backups.push(file);
    }
    const exact = backups.at(-1)!;
    const exactSha = spawnSync('node', ['-e',
      'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))', exact],
    { encoding: 'utf8' }).stdout;
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const requestSha256 = JSON.parse(launch.stdout).requestSha256;
    fs.writeFileSync(path.join(authoritative, 'result.env'), [
      `NEXUS_TRANSACTION_ID=${id}`,
      `NEXUS_RUNTIME_SHA=${'b'.repeat(40)}`,
      `NEXUS_SENTRY_RELEASE=${'b'.repeat(40)}`,
      `NEXUS_ARTIFACT_DIGEST=${'c'.repeat(64)}`,
      `NEXUS_INSTALLED_RUNTIME_DIGEST=${'d'.repeat(64)}`,
      'NEXUS_CUTOVER_STARTED_AT=2026-07-22T12:00:00Z',
      'NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=2026-07-22T12:00:01Z',
      'NEXUS_CANDIDATE_AVAILABLE_AT=2026-07-22T12:00:08Z',
      'NEXUS_CUTOVER_SECONDS=68',
      'NEXUS_BACKUP_WINDOW_SECONDS=4',
      'NEXUS_BACKUP_OUTAGE_SECONDS=4',
      'NEXUS_FINAL_UNAVAILABILITY_SECONDS=8',
      'NEXUS_TOTAL_UNAVAILABILITY_SECONDS=8',
      'NEXUS_VERIFICATION_SOAK_SECONDS=60',
      'NEXUS_SOAK_STARTED_AT=2026-07-22T12:00:08Z',
      'NEXUS_SOAK_COMPLETED_AT=2026-07-22T12:01:08Z',
      'NEXUS_SOAK_OBSERVED_SECONDS=60',
      `NEXUS_BACKUP_FILE=${exact}`,
      `NEXUS_BACKUP_SHA256=${exactSha}`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1', transactionId: id, requestSha256,
      phase: 'awaiting_rollback_escrow', status: 'escrow_pending',
    })}\n`, { mode: 0o600 });
    const drConfig = path.join(root, 'dr.env');
    fs.writeFileSync(drConfig, 'fixture=true\n', { mode: 0o600 });
    const dr = path.join(root, 'bin', 'dr-backup');
    fs.writeFileSync(dr, '#!/usr/bin/env bash\nexit 42\n', { mode: 0o755 });
    const escrowEnv = {
      NEXUS_PROMOTION_DR_BACKUP_BIN: dr,
      NEXUS_PROMOTION_DR_CONFIG: drConfig,
      NEXUS_PROMOTION_TRANSACTION_SCRIPT: runner,
      NEXUS_PROMOTION_TEST_ROOT: fixture,
    };

    const blocked = spawnSync('bash', [broker, 'run', id], { encoding: 'utf8', env: env(escrowEnv) });
    expect(blocked.status).toBe(1);
    expect(fs.readdirSync(backupDir)).toHaveLength(11);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')).status).toBe('escrow_pending');

    fs.writeFileSync(dr, `#!/usr/bin/env bash
set -euo pipefail
required=""
while [ $# -gt 0 ]; do case "$1" in --require-release) required="$2"; shift 2 ;; *) shift ;; esac; done
node - "$required" <<'NODE'
const fs=require('fs'),c=require('crypto');const file=process.argv[2];
const sha=c.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
process.stdout.write(JSON.stringify({schema:'nexus.application-dr-backup-result.v1',status:'passed',encrypted:true,
  requiredRelease:{path:file,plaintextSha256:sha,objectKey:'nexus/releases/'+file.split('/').pop()+'.'+sha+'.age',confirmed:true}})+'\\n');
NODE
`, { mode: 0o755 });
    const confirmed = spawnSync('bash', [broker, 'run', id], { encoding: 'utf8', env: env(escrowEnv) });
    expect(confirmed.status, confirmed.stderr).toBe(0);
    expect(fs.readdirSync(backupDir)).toHaveLength(10);
    expect(fs.existsSync(exact)).toBe(true);
    expect(fs.existsSync(path.join(authoritative, 'escrow-confirmation.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')).status).toBe('completed');
  });

  it('persists recovery intent before the first PM2 stop and automatically restores after an injected stop failure', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'worker-fixture');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    const bin = path.join(fixture, 'bin');
    fs.mkdirSync(path.join(production, 'data'), { recursive: true });
    fs.mkdirSync(path.join(previous, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'backups'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(previous, '.complete.json'), `${JSON.stringify({ runtimeSha: 'a'.repeat(40) })}\n`);
    fs.writeFileSync(path.join(previous, 'ecosystem.release.config.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(target, 'scripts', 'remote-release-capacity.sh'), '#!/usr/bin/env bash\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
    fs.symlinkSync(previous, path.join(production, 'current'));
    const armed = path.join(stateRoot, 'transactions', id, 'worker', 'recovery-armed');
    const authoritativeArmed = path.join(stateRoot, 'transactions', id, 'state', 'recovery-armed');
    const pm2Log = path.join(fixture, 'pm2.log');
    const pm2Rows = JSON.stringify([
      { name: 'nexus-hub', pid: 1, pm2_env: { status: 'online', pm_cwd: previous, NEXUS_RELEASE_SHA: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
      { name: 'content-engine', pid: 2, pm2_env: { status: 'online', pm_cwd: `${previous}/content-engine`, NEXUS_RELEASE_SHA: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
    ]);
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(pm2Log)}
case "\${1:-}" in
  jlist) printf '%s\n' ${JSON.stringify(pm2Rows)} ;;
  describe) exit 0 ;;
  stop) [ -f ${JSON.stringify(armed)} ] || exit 99; exit 42 ;;
  delete|start|save) exit 0 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
if [[ " $* " == *"8200/health"* ]]; then printf '{"status":"healthy","server":{"status":"online"},"database":"connected"}\n'; else printf '{}\n'; fi
`, { mode: 0o755 });
    const timeoutShim = path.join(bin, 'timeout');
    fs.writeFileSync(timeoutShim, `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) break ;; esac; done
exec "$@"
`, { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: runner,
        NEXUS_PROMOTION_TIMEOUT_BIN: timeoutShim,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        PATH: `${bin}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.existsSync(pm2Log) ? fs.readFileSync(pm2Log, 'utf8') : '<no-pm2-log>';
    const diagnosticJournal = fs.existsSync(path.join(stateRoot, 'transactions', id, 'worker', 'worker-progress.json'))
      ? fs.readFileSync(path.join(stateRoot, 'transactions', id, 'worker', 'worker-progress.json'), 'utf8') : '<no-journal>';
    expect(fs.existsSync(armed), `${result.stderr}\n${calls}\n${diagnosticJournal}`).toBe(true);
    expect(fs.existsSync(authoritativeArmed)).toBe(false);
    expect(calls).toContain('stop nexus-hub');
    expect(calls).toContain('start');
    const journal = JSON.parse(fs.readFileSync(path.join(stateRoot, 'transactions', id, 'state', 'journal.json'), 'utf8'));
    expect(journal.status).toBe('recovered');
  });

  it('rejects an exact-digest archive containing a symlink instead of extracting it during recovery', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256 as string;
    const fixture = path.join(root, 'unsafe-archive-fixture');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    const backupDir = path.join(fixture, 'backups');
    const archiveSource = path.join(fixture, 'archive-source');
    const bin = path.join(fixture, 'bin');
    fs.mkdirSync(path.join(production, 'data'), { recursive: true });
    fs.mkdirSync(path.join(previous, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(archiveSource, 'data'), { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync('/etc/passwd', path.join(archiveSource, 'data', 'bot.db'));
    const backup = path.join(backupDir, 'v4.14.231.tar.gz');
    const packed = spawnSync('/usr/bin/tar', ['-czf', backup, '-C', archiveSource, 'data'], {
      encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    expect(packed.status, packed.stderr).toBe(0);
    const bytes = fs.readFileSync(backup);
    const worker = path.join(stateRoot, 'transactions', id, 'worker');
    fs.writeFileSync(path.join(worker, 'backup.env'), [
      `NEXUS_BACKUP_FILE=${backup}`,
      `NEXUS_BACKUP_SHA256=${createHash('sha256').update(bytes).digest('hex')}`,
      `NEXUS_BACKUP_SIZE_BYTES=${bytes.length}`,
      `NEXUS_BACKUP_DATABASE_SHA256=${'a'.repeat(64)}`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'candidate-mutated'), 'yes\n', { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'recovery-armed'), 'yes\n', { mode: 0o600 });
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/usr/bin/env bash
case "\${1:-}" in describe|stop|delete|start|save) exit 0 ;; jlist) printf '[]\\n' ;; esac
`, { mode: 0o755 });

    const recovered = spawnSync('bash', [runner, 'worker-recover', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_REQUEST_SHA256: requestSha256,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        PATH: `${bin}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      }),
    });
    expect(recovered.status, `${recovered.stderr}\n${recovered.stdout}`).toBe(1);
    expect(recovered.stderr).toContain('unsupported rollback archive entry');
    const journal = JSON.parse(fs.readFileSync(path.join(worker, 'worker-progress.json'), 'utf8'));
    expect(journal.status).toBe('recovery_failed');
  });

  it('wires the dedicated identity, finite bounds, signed client, and strict migration approval', () => {
    const clientSource = fs.readFileSync(promotion, 'utf8');
    const runnerSource = fs.readFileSync(runner, 'utf8');
    const brokerSource = fs.readFileSync(broker, 'utf8');
    const installSource = fs.readFileSync(installer, 'utf8');
    const attestorSource = fs.readFileSync(trustedAttestor, 'utf8');
    const service = fs.readFileSync(unit, 'utf8');
    const recovery = fs.readFileSync(recoveryUnit, 'utf8');
    const gate = fs.readFileSync(migrationGate, 'utf8');

    expect(clientSource).toContain('nexus-release-promotion-control.v2');
    expect(clientSource).toContain('sign-request');
    expect(clientSource).not.toContain('sign-decision');
    expect(clientSource).not.toContain('awaiting_local_gate');
    expect(clientSource).not.toContain('SYSTEMD_CONTROL" continue');
    expect(clientSource).toContain('transaction result identity does not match');
    expect(clientSource).toContain('NEXUS_INSTALLED_RUNTIME_DIGEST');
    expect(clientSource).toContain('release-installed-tree-attestation.mjs" validate');
    expect(clientSource).toContain('rollbackEscrow: { status: \'passed\'');
    const prepareTarget = clientSource.indexOf('prepare-runtime-target');
    const copyTarget = clientSource.indexOf('rsync -a --delete', prepareTarget);
    const sealTarget = clientSource.indexOf('seal-runtime', copyTarget);
    const candidatePreflight = clientSource.indexOf('remote-release-preflight.sh', sealTarget);
    expect(prepareTarget).toBeGreaterThan(-1);
    expect(copyTarget).toBeGreaterThan(prepareTarget);
    expect(sealTarget).toBeGreaterThan(copyTarget);
    expect(candidatePreflight).toBeGreaterThan(sealTarget);
    expect(clientSource.slice(prepareTarget, copyTarget)).toContain('[ ! -w "$base_dir/releases" ]');
    expect(clientSource).toContain('Tolerate bounded transient transport loss');
    const armIndex = runnerSource.indexOf('RECOVERY_ARMED_MARKER.next');
    const stopIndex = runnerSource.indexOf('\nstop_predecessor\n', armIndex);
    expect(armIndex).toBeLessThan(stopIndex);
    expect(runnerSource).not.toContain('sleep "$STABILITY_SECONDS"');
    expect(runnerSource).not.toContain('soak_predecessor_identity');
    expect(runnerSource.match(/--stability-seconds "\$STABILITY_SECONDS"/gu)).toHaveLength(1);
    expect(runnerSource).toContain('signed_migration_identities_automatically_verified');
    expect(runnerSource).not.toContain('continue.envelope.json');
    expect(fs.readFileSync(path.resolve('scripts/remote-create-release-backup.sh'), 'utf8')).not.toContain('tail -n +11');
    expect(brokerSource).toContain('OUTAGE_BUDGET_SECONDS=120');
    expect(brokerSource).toContain('PRE_RECOVERY_BUDGET_SECONDS=60');
    expect(brokerSource).toContain('NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC');
    expect(brokerSource).toContain('"${timeout_seconds}s"');
    expect(brokerSource).toContain('/run/lock/nexus-release-sonar.lock');
    expect(brokerSource).toContain('exec 8<>"$RELEASE_SONAR_LOCK"');
    expect(brokerSource).not.toContain('exec 8>"$RELEASE_SONAR_LOCK"');
    expect(brokerSource).toContain('AUTHORITATIVE_DIR="$TRANSACTION_DIR/state"');
    expect(brokerSource.indexOf('RECOVERY_INTENT.next')).toBeLessThan(brokerSource.indexOf('invoke_worker worker-run'));
    expect(brokerSource.indexOf('verify_candidate_live')).toBeLessThan(brokerSource.indexOf('escrow_exact_backup'));
    expect(brokerSource).toContain('candidate_available_before_network_escrow');
    expect(brokerSource).toContain('explicit_recovery_from_escrow_pending');
    expect(brokerSource).toContain('if [ "$ACTION" = recover ] || [ -f "$CONTROL_DIR/recover" ]');
    expect(brokerSource).toContain('"$RUNUSER_BIN" -u "$WORKER_USER" -- "$SYSTEM_NODE_BIN" -e "$script" "$BACKUP_DIR"');
    expect(runnerSource).toContain('exact rollback backup size changed');
    expect(runnerSource).toContain('exact rollback backup digest changed');
    expect(runnerSource).toContain('rollback database digest does not match stopped-state evidence');
    expect(runnerSource).toContain('unsupported rollback archive entry');
    expect(attestorSource).toContain('installed dependency symlink escapes the runtime');
    expect(attestorSource).toContain('assertSealedPermissions');
    expect(attestorSource).toContain('fs.chmodSync(base, 0o1770)');
    expect(attestorSource).toContain("fs.chmodSync(path.join(base, 'releases'), 0o750)");
    expect(fs.readFileSync(control, 'utf8')).toContain('prepare-runtime-target)');
    expect(fs.readFileSync(control, 'utf8')).toContain('chown root:"$worker_group" "$base" "$base/releases"');
    expect(fs.readFileSync(path.resolve('scripts/release-operator.sh'), 'utf8')).toContain('release_acquire_remote_sonar_lock "$SERVER"');
    const releaseOperator = fs.readFileSync(path.resolve('scripts/release-operator.sh'), 'utf8');
    expect(releaseOperator).toContain('release-runtime-dependencies.mjs install');
    expect(releaseOperator).not.toContain('/usr/bin/npm ci');
    expect(releaseOperator).not.toContain('pip install');
    expect(installSource).toContain('--shell /usr/sbin/nologin');
    expect(installSource).toContain('-m 700');
    expect(installSource).toContain('nexus-release-sonar-lock.conf');
    expect(installSource).toContain('root:dominguez:660');
    expect(installSource).not.toContain('promotion-control continue');
    expect(installSource).not.toContain('promotion-control escrow-inflight');
    expect(service).toContain('User=nexus-release');
    expect(service).not.toContain('TimeoutStartSec=infinity');
    expect(service).not.toContain('network-online.target');
    expect(recovery).toContain('Before=network.target network-online.target multi-user.target pm2-dominguez.service pm2-root.service');
    expect(recovery).toContain('TimeoutStartSec=130s');
    expect(gate).toContain("'--approval-mode', 'promotion'");
  });
});
