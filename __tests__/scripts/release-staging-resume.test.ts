import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const filesystemIdentity = path.join(ROOT, 'scripts', 'trusted-release-filesystem-identity.mjs');
const selectorSwitch = path.join(ROOT, 'scripts', 'remote-release-selector-switch.py');
const roots: string[] = [];
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makePinnedFixture() {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-staging-pin-')));
  roots.push(fixture);
  const releaseRoot = path.join(fixture, 'nexus-release');
  const base = path.join(releaseRoot, 'staging');
  const releases = path.join(base, 'releases');
  const runtime = path.join(releases, `candidate-${'a'.repeat(12)}`);
  fs.mkdirSync(runtime, { recursive: true });
  fs.chmodSync(releaseRoot, 0o755);
  fs.chmodSync(base, 0o1770);
  fs.chmodSync(releases, 0o750);
  fs.chmodSync(runtime, 0o550);
  return { fixture, releaseRoot, base, releases, runtime };
}

function identityArgs(fixture: ReturnType<typeof makePinnedFixture>) {
  return [
    '--role', 'staging',
    '--release-root', fixture.releaseRoot,
    '--base', fixture.base,
    '--runtime', fixture.runtime,
    '--worker-uid', String(process.getuid()),
    '--worker-gid', String(process.getgid()),
    '--allow-test-owner',
  ];
}

describe('root-pinned staging evidence and exact-active resume', () => {
  it('uses one pinned root CAS helper for ordinary and layout selector transitions', () => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-selector-')));
    roots.push(fixture);
    const releaseRoot = path.join(fixture, 'nexus-release');
    const base = path.join(releaseRoot, 'production');
    const releases = path.join(base, 'releases');
    const predecessor = path.join(releases, 'predecessor');
    const candidate = path.join(releases, 'candidate');
    const legacyBase = path.join(fixture, 'legacy-production');
    fs.mkdirSync(predecessor, { recursive: true });
    fs.mkdirSync(candidate);
    fs.chmodSync(releaseRoot, 0o755);
    fs.chmodSync(base, 0o1770);
    fs.chmodSync(releases, 0o750);
    fs.chmodSync(predecessor, 0o550);
    fs.chmodSync(candidate, 0o550);
    fs.symlinkSync(predecessor, path.join(base, 'current'));
    fs.mkdirSync(path.join(base, '.current.next.attacker'));

    const run = (...args: string[]) => spawnSync('python3', [selectorSwitch, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NEXUS_RELEASE_TEST_MODE: '1' },
    });
    const common = [
      '--role', 'production',
      '--release-root', releaseRoot,
      '--worker-uid', String(process.getuid()),
      '--worker-gid', String(process.getgid()),
      '--allow-test-owner',
    ];
    const switched = run(
      'switch',
      ...common,
      '--expected', predecessor,
      '--target', candidate,
    );
    expect(switched.status, switched.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(base, 'current'))).toBe(candidate);
    expect(fs.statSync(path.join(base, '.current.next.attacker')).isDirectory()).toBe(true);

    const staleCas = run(
      'switch',
      ...common,
      '--expected', predecessor,
      '--target', predecessor,
    );
    expect(staleCas.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(base, 'current'))).toBe(candidate);

    fs.rmSync(path.join(base, 'current'));
    const initialized = run(
      'initialize',
      ...common,
      '--target', predecessor,
      '--layout-transition',
      '--legacy-base', legacyBase,
    );
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(base, 'current'))).toBe(predecessor);
    expect(run(
      'initialize',
      ...common,
      '--target', candidate,
      '--layout-transition',
      '--legacy-base', legacyBase,
    ).status).not.toBe(0);

    fs.rmSync(path.join(base, 'current'));
    const oldLegacyRuntime = path.join(legacyBase, 'releases', 'predecessor');
    fs.symlinkSync(oldLegacyRuntime, path.join(base, 'current'));
    const forwardLayout = run(
      'switch',
      ...common,
      '--expected', oldLegacyRuntime,
      '--target', candidate,
      '--legacy-base', legacyBase,
      '--layout-transition',
      '--adopt-existing-selector',
    );
    expect(forwardLayout.status, forwardLayout.stderr).toBe(0);
    fs.renameSync(base, legacyBase);

    const recoveredRuntime = path.join(legacyBase, 'releases', 'predecessor');
    const recoveryLayout = run(
      'switch',
      ...common,
      '--expected', candidate,
      '--target', recoveredRuntime,
      '--legacy-base', legacyBase,
      '--layout-transition',
      '--layout-base', 'legacy',
      '--adopt-existing-selector',
    );
    expect(recoveryLayout.status, recoveryLayout.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(legacyBase, 'current'))).toBe(recoveredRuntime);
  });

  it('rejects an entire base rename/recreate before any current mutation can run', () => {
    const fixture = makePinnedFixture();
    const captured = spawnSync(process.execPath, [
      filesystemIdentity,
      'capture',
      ...identityArgs(fixture),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(captured.status, captured.stderr).toBe(0);
    const binding = path.join(fixture.fixture, 'binding.json');
    fs.writeFileSync(binding, `${JSON.stringify({
      schema: 'nexus.trusted-staging-runtime-binding.v1',
      filesystem: JSON.parse(captured.stdout),
    }, null, 2)}\n`, { mode: 0o600 });

    const initiallyVerified = spawnSync(process.execPath, [
      filesystemIdentity,
      'verify',
      ...identityArgs(fixture),
      '--binding', binding,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(initiallyVerified.status, initiallyVerified.stderr).toBe(0);

    const replaced = `${fixture.base}.replaced`;
    fs.renameSync(fixture.base, replaced);
    fs.mkdirSync(fixture.runtime, { recursive: true });
    fs.chmodSync(fixture.base, 0o1770);
    fs.chmodSync(fixture.releases, 0o750);
    fs.chmodSync(fixture.runtime, 0o550);
    const mutationMarker = path.join(fixture.fixture, 'current-mutated');
    const reverified = spawnSync(process.execPath, [
      filesystemIdentity,
      'verify',
      ...identityArgs(fixture),
      '--binding', binding,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    if (reverified.status === 0) fs.writeFileSync(mutationMarker, 'unsafe\n');

    expect(reverified.status).not.toBe(0);
    expect(reverified.stderr).toContain('filesystem identity changed after sealing');
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.existsSync(path.join(fixture.base, 'current'))).toBe(false);
  });

  it('keeps verify, preflight, switch, readiness, and publication in one root broker call', () => {
    const control = fs.readFileSync(path.join(ROOT, 'scripts', 'remote-promotion-control.sh'), 'utf8');
    const broker = fs.readFileSync(path.join(ROOT, 'scripts', 'remote-staging-attestation-broker.sh'), 'utf8');
    const operator = fs.readFileSync(path.join(ROOT, 'scripts', 'release-operator.sh'), 'utf8');

    const command = control.indexOf('attest-staging-runtime)');
    const trustedVerify = control.indexOf('verify_staging_runtime_binding', command);
    const brokerCall = control.indexOf('"$STAGING_BROKER"', trustedVerify);
    const publication = control.indexOf('durable_publish "$evidence_next" "$evidence" 600', brokerCall);
    expect(command).toBeGreaterThan(-1);
    expect(trustedVerify).toBeGreaterThan(command);
    expect(brokerCall).toBeGreaterThan(trustedVerify);
    expect(publication).toBeGreaterThan(brokerCall);

    const firstPin = broker.indexOf('verify_filesystem_identity');
    const preflight = broker.indexOf('remote-release-preflight.sh', firstPin);
    const pinAfterPreflight = broker.indexOf('verify_filesystem_identity', preflight);
    const currentSwitch = broker.indexOf(
      'atomic_current_switch "$PREVIOUS_RUNTIME" "$RUNTIME"',
      pinAfterPreflight,
    );
    const readiness = broker.indexOf('remote-release-readiness.sh', currentSwitch);
    const pinAfterReadiness = broker.indexOf('verify_filesystem_identity', readiness);
    const record = broker.indexOf("schema:'nexus.root-staging-attestation-evidence.v1'", pinAfterReadiness);
    expect(firstPin).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(firstPin);
    expect(pinAfterPreflight).toBeGreaterThan(preflight);
    expect(currentSwitch).toBeGreaterThan(pinAfterPreflight);
    expect(readiness).toBeGreaterThan(currentSwitch);
    expect(pinAfterReadiness).toBeGreaterThan(readiness);
    expect(record).toBeGreaterThan(pinAfterReadiness);
    expect(broker).toContain('--output-fd 8');
    expect(broker).toContain('resumedExactActive');

    expect(operator).toContain('attest-staging-runtime');
    expect(operator).toContain('fetch-staging-evidence');
    expect(operator).toContain('nexus.root-staging-attestation-evidence.v1');
    expect(operator).not.toContain('REMOTE_EVIDENCE_DIR');
    expect(operator).not.toContain('remote-release-readiness.sh');
    expect(operator).not.toContain('.release-evidence/');
    expect(operator).not.toMatch(/ssh "\$SERVER" "cat '/u);
  });

  it('ignores replaceable deploy-user readiness/PM2 files and fetches only the root broker record', () => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-root-evidence-')));
    roots.push(fixture);
    const stateRoot = path.join(fixture, 'state');
    const stagingState = path.join(stateRoot, 'staging');
    const workerEvidence = path.join(fixture, 'worker', '.release-evidence');
    const bin = path.join(fixture, 'bin');
    fs.mkdirSync(stagingState, { recursive: true });
    fs.mkdirSync(workerEvidence, { recursive: true });
    fs.mkdirSync(bin);
    fs.chmodSync(stagingState, 0o700);
    const requestId = '11111111-1111-4111-8111-111111111111';
    const runtimeSha = 'a'.repeat(40);
    const artifactDigest = 'b'.repeat(64);
    const releaseRoot = path.join(fixture, 'release-root');
    const base = path.join(releaseRoot, 'staging');
    const releaseDir = path.join(base, 'releases', `${runtimeSha}-${artifactDigest.slice(0, 12)}`);
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.symlinkSync(releaseDir, path.join(base, 'current'));
    const selectorStat = fs.lstatSync(path.join(base, 'current'));
    const currentSelector = {
      schema: 'nexus.release-current-selector-identity.v1',
      path: path.join(base, 'current'),
      target: releaseDir,
      dev: String(selectorStat.dev),
      ino: String(selectorStat.ino),
      uid: selectorStat.uid,
      gid: selectorStat.gid,
    };
    const filesystem = {
      schema: 'nexus.release-filesystem-identity.v1',
      role: 'staging',
      workerUid: process.getuid(),
      workerGid: process.getgid(),
      entries: {
        releaseRoot: { path: releaseRoot, dev: '1', ino: '2' },
        base: { path: base, dev: '1', ino: '3' },
        releases: { path: path.join(base, 'releases'), dev: '1', ino: '4' },
        runtime: { path: releaseDir, dev: '1', ino: '5' },
      },
    };
    const binding = {
      schema: 'nexus.trusted-staging-runtime-binding.v1',
      requestId,
      runtime: releaseDir,
      base,
      runtimeSha,
      artifactDigest,
      installedRuntimeDigest: 'c'.repeat(64),
      recoveryRuntimeDigest: 'd'.repeat(64),
      filesystem,
    };
    const installedRuntimeAttestation = {
      schema: 'nexus.installed-runtime-attestation.v1',
      aggregateDigest: binding.installedRuntimeDigest,
    };
    const recoveryRuntimeAttestation = {
      schema: 'nexus.recovery-runtime-attestation.v1',
      aggregateDigest: binding.recoveryRuntimeDigest,
    };
    const remoteIdentity = {
      schema: 'nexus.pm2-release-identity.v1',
      services: [{
        name: 'nexus-hub-staging',
        status: 'online',
        cwd: releaseDir,
        executable: `${releaseDir}/dist/index.js`,
        interpreter: 'node',
        releaseSha: runtimeSha,
        sentryRelease: runtimeSha,
      }],
    };
    const remoteReadiness = {
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha,
      rootBrokerOwned: true,
    };
    const record = {
      schema: 'nexus.root-staging-attestation-evidence.v1',
      requestId,
      runtimeSha,
      artifactDigest,
      releaseDir,
      base,
      binding,
      filesystem,
      currentSelector,
      installedRuntimeAttestation,
      recoveryRuntimeAttestation,
      remoteIdentity,
      remoteReadiness,
      outputDigests: {
        bindingSha256: sha256(canonical(binding)),
        installedRuntimeSha256: sha256(canonical(installedRuntimeAttestation)),
        recoveryRuntimeSha256: sha256(canonical(recoveryRuntimeAttestation)),
        pm2IdentitySha256: sha256(canonical(remoteIdentity)),
        currentSelectorSha256: sha256(canonical(currentSelector)),
        readinessSha256: sha256(`${JSON.stringify(remoteReadiness, null, 2)}\n`),
      },
      transaction: { publishedAt: '2026-07-24T12:00:00.000Z' },
    };
    const authoritative = path.join(stagingState, `${requestId}.evidence.json`);
    fs.writeFileSync(authoritative, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    const forgedReadiness = path.join(workerEvidence, '.nexus-release-readiness.json');
    const forgedPm2 = path.join(workerEvidence, '.nexus-pm2-identity.json');
    fs.writeFileSync(forgedReadiness, '{"forged":"before"}\n');
    fs.writeFileSync(forgedPm2, '{"forged":"before"}\n');
    fs.writeFileSync(forgedReadiness, '{"forged":"after-check"}\n');
    fs.writeFileSync(forgedPm2, '{"forged":"after-check"}\n');

    const statWrapper = path.join(bin, 'stat');
    fs.writeFileSync(statWrapper, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -c ]; then
  format="$2"; file="$3"
  "${process.execPath}" -e '
const fs=require("fs");const [format,file]=process.argv.slice(1);const s=fs.lstatSync(file);
const mode=(s.mode&0o7777).toString(8);
if(format==="%a:%h")process.stdout.write(mode+":"+s.nlink);
else if(format==="%U:%G")process.stdout.write("test:test");
else process.exit(64);' "$format" "$file"
else
  exec /usr/bin/stat "$@"
fi
`, { mode: 0o755 });
    const brokerWrapper = path.join(bin, 'staging-broker');
    fs.writeFileSync(brokerWrapper, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, 'flock'),
      '#!/usr/bin/env bash\nexit 0\n',
      { mode: 0o755 },
    );
    const commonEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_PROMOTION_TRUSTED_ATTESTOR: filesystemIdentity,
      NEXUS_PROMOTION_RECOVERY_ATTESTOR: filesystemIdentity,
      NEXUS_PROMOTION_FILESYSTEM_IDENTITY: filesystemIdentity,
      NEXUS_PROMOTION_SELECTOR_SWITCH: path.join(
        ROOT,
        'scripts',
        'remote-release-selector-switch.py',
      ),
      NEXUS_PROMOTION_STAGING_BROKER: brokerWrapper,
    };
    const fetched = spawnSync('bash', [
      path.join(ROOT, 'scripts', 'remote-promotion-control.sh'),
      'fetch-staging-evidence',
      requestId,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: commonEnv,
    });

    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toEqual(record);
    expect(fetched.stdout).not.toContain('after-check');

    const driftedRuntime = path.join(base, 'releases', `drifted-${'e'.repeat(12)}`);
    fs.mkdirSync(driftedRuntime);
    fs.rmSync(path.join(base, 'current'));
    fs.symlinkSync(driftedRuntime, path.join(base, 'current'));
    const driftedFetch = spawnSync('bash', [
      path.join(ROOT, 'scripts', 'remote-promotion-control.sh'),
      'fetch-staging-evidence',
      requestId,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: commonEnv,
    });
    expect(driftedFetch.status).not.toBe(0);
    expect(driftedFetch.stdout).not.toContain('after-check');

    fs.rmSync(authoritative);
    fs.symlinkSync(forgedReadiness, authoritative);
    const symlinkFetch = spawnSync('bash', [
      path.join(ROOT, 'scripts', 'remote-promotion-control.sh'),
      'fetch-staging-evidence',
      requestId,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: commonEnv,
    });
    expect(symlinkFetch.status).not.toBe(0);
    expect(symlinkFetch.stdout).not.toContain('after-check');
  });

  it('uses only the root-controlled authoritative release hierarchy', () => {
    const control = fs.readFileSync(path.join(ROOT, 'scripts', 'remote-promotion-control.sh'), 'utf8');
    const broker = fs.readFileSync(path.join(ROOT, 'scripts', 'remote-staging-attestation-broker.sh'), 'utf8');
    const operator = fs.readFileSync(path.join(ROOT, 'scripts', 'release-operator.sh'), 'utf8');

    for (const source of [control, broker]) expect(source).toContain('/srv/nexus-release');
    expect(broker).not.toContain('/home/dominguez/telegram-hub-bot');
    expect(operator).toContain('BASE_DIR="${STAGING_PATH:-/srv/nexus-release/staging}"');
    expect(operator).toContain('DEPLOY_PATH:-/srv/nexus-release/production');
    expect(operator).toContain('STAGING_BASE="${STAGING_PATH:-/srv/nexus-release/staging}"');
    expect(operator).toContain('PROD_BASE="${DEPLOY_PATH:-/srv/nexus-release/production}"');
    expect(control).toContain('chmod 1770 "$base"');
    expect(control).toContain('chmod 0750 "$base/releases"');
  });

  it('binds the sole selector helper and crash-consistent staging recovery into bootstrap', () => {
    const broker = fs.readFileSync(
      path.join(ROOT, 'scripts', 'remote-staging-attestation-broker.sh'),
      'utf8',
    );
    const control = fs.readFileSync(
      path.join(ROOT, 'scripts', 'remote-promotion-control.sh'),
      'utf8',
    );
    const worker = fs.readFileSync(
      path.join(ROOT, 'scripts', 'remote-promotion-worker-control.sh'),
      'utf8',
    );
    const transaction = fs.readFileSync(
      path.join(ROOT, 'scripts', 'remote-promotion-transaction.sh'),
      'utf8',
    );
    const layout = fs.readFileSync(
      path.join(ROOT, 'scripts', 'remote-release-layout-migrate.sh'),
      'utf8',
    );
    const legacy = fs.readFileSync(
      path.join(ROOT, 'scripts', 'promote-exact-release.sh'),
      'utf8',
    );
    const installer = fs.readFileSync(
      path.join(ROOT, 'scripts', 'remote-promotion-systemd-install.sh'),
      'utf8',
    );
    const helper = fs.readFileSync(selectorSwitch, 'utf8');
    const layoutRecoveryUnit = fs.readFileSync(
      path.join(ROOT, 'scripts', 'systemd', 'nexus-release-layout-recovery.service'),
      'utf8',
    );

    expect(helper).toContain('os.rename(');
    expect(helper).toContain('src_dir_fd=base_fd');
    expect(helper).toContain('secrets.token_hex(16)');
    expect(helper).not.toContain('os.unlink("current"');
    for (const source of [broker, worker, transaction, layout]) {
      expect(source).toContain('nexus-release-selector-switch.py');
      expect(source).not.toMatch(/^\s*(?:rm|ln|mv)\s+[^\n]*current/mu);
      expect(source).not.toContain("fs.renameSync(next,current)");
    }
    expect(legacy).not.toMatch(/^\s*(?:rm|ln|mv)\s+[^\n]*current/mu);
    expect(legacy).toContain('the legacy local transaction is retired');
    expect(installer).toContain('scripts/remote-release-selector-switch.py');
    expect(installer).toContain('/usr/local/libexec/nexus-release-selector-switch.py');

    const publish = control.indexOf('durable_publish "$evidence_next" "$evidence" 600');
    const finalize = control.indexOf('"$STAGING_BROKER" finalize "$request_id"', publish);
    expect(publish).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(publish);
    expect(control.indexOf('"$STAGING_BROKER" recover-all')).toBeGreaterThan(-1);
    expect(broker).toContain('nexus.staging-attestation-transaction.v1');
    expect(broker).toContain('assert_no_other_unfinished_staging_transaction');
    expect(broker).toContain('multiple unfinished staging transactions require owner review');
    expect(broker).toContain('transactionJournalSha256');
    expect(broker).toContain('publishedEvidenceSha256');
    expect(layout).not.toContain('recover_layout || true');
    expect(layout).toContain('automatic layout recovery failed; durable journal retained');
    expect(layout).toContain('persist_and_verify_pm2_dump');
    expect(layout).toContain('pm2DumpSha256');
    expect(layoutRecoveryUnit).toContain('KillMode=control-group');
    expect(layoutRecoveryUnit).not.toContain('RemainAfterExit=yes');
    expect(layoutRecoveryUnit).not.toContain('KillMode=process');
  });
});
