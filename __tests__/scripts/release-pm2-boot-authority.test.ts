import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const boot = read('scripts/remote-release-boot-health.sh');
const control = read('scripts/remote-promotion-control.sh');
const installer = read('scripts/remote-promotion-systemd-install.sh');
const layout = read('scripts/remote-release-layout-migrate.sh');
const layoutControl = read('scripts/remote-release-layout-activation-control.sh');
const worker = read('scripts/remote-promotion-worker-control.sh');
const staging = read('scripts/remote-staging-attestation-broker.sh');
const layoutUnit = read('scripts/systemd/nexus-release-layout-recovery.service');
const recoveryUnit = read('scripts/systemd/nexus-release-promotion-recovery.service');
const temporaryUnit = read('scripts/systemd/nexus-release-pm2-recovery-daemon.service');

function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing section start: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing section end: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function shellFunction(source: string, name: string) {
  return `${section(source, `${name}() {`, '\n}\n')}\n}`;
}

describe('root PM2 boot authority', () => {
  it('preflights before publishing boot authority and then starts one governed daemon', () => {
    const recoverAll = section(control, '  recover-all)', '  boot-postcheck)');
    const preflight = recoverAll.indexOf('"$BOOT_HEALTH_BIN" preflight-temporary');
    const marker = recoverAll.indexOf('write_boot_recovery_authority');
    const daemon = recoverAll.indexOf('"$BOOT_HEALTH_BIN" start-temporary');
    const stagingRecovery = recoverAll.indexOf('"$STAGING_BROKER" recover-all');
    const productionRecovery = recoverAll.indexOf('"$SYSTEMCTL_BIN" start "$unit"');
    const finalPrepare = recoverAll.indexOf('"$BOOT_HEALTH_BIN" prepare');
    expect(preflight).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(preflight);
    expect(daemon).toBeGreaterThan(marker);
    expect(daemon).toBeGreaterThan(-1);
    expect(daemon).toBeLessThan(stagingRecovery);
    expect(daemon).toBeLessThan(productionRecovery);
    expect(finalPrepare).toBeGreaterThan(productionRecovery);

    const layoutRecovery = section(layout, 'recover_layout() {', '\nmigrate_layout() {');
    const origin = layoutRecovery.indexOf('write_boot_recovery_origin');
    const layoutDaemon = layoutRecovery.indexOf('"$BOOT_HEALTH_BIN" start-temporary');
    const firstPm2Mutation = layoutRecovery.indexOf('stop_all_apps');
    expect(origin).toBeGreaterThan(-1);
    expect(layoutDaemon).toBeGreaterThan(origin);
    expect(layoutDaemon).toBeLessThan(firstPm2Mutation);
    expect(layoutRecovery).toContain(
      '[ "$production_touched" = true ] \\\n      || [ "${NEXUS_RELEASE_BOOT_RECOVERY:-0}" = 1 ]',
    );
    expect(layoutRecovery.indexOf('start_role production')).toBeLessThan(
      layoutRecovery.indexOf('start_role staging'),
    );

    expect(temporaryUnit).toContain('Restart=no');
    expect(temporaryUnit).toContain('KillMode=control-group');
    expect(temporaryUnit).not.toContain('Conflicts=');
    expect(temporaryUnit).not.toContain('[Install]');
    expect(recoveryUnit).toContain(
      'ExecCondition=/usr/local/sbin/nexus-release-boot-health preflight-temporary',
    );
    expect(boot).toContain('assert_no_ungoverned_pm2_daemon');
    expect(boot).not.toMatch(/kill\s+["']?\$\(?.*pm2\.pid/u);
  });

  it('clamps a one-second future recovery origin to validator-compatible time', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-layout-clock-')));
    try {
      const journal = join(root, 'layout-journal.json');
      const recovery = join(root, 'boot-recovery.json');
      const now = Math.floor(Date.now() / 1000);
      const started = now + 1;
      writeFileSync(journal, `${JSON.stringify({
        schema: 'nexus.release-layout-migration-journal.v1',
        productionOutageStartedEpoch: started,
        productionOutageStartedMonotonic: 10,
        productionOutageBootId: 'prior-boot',
      })}\n`, { mode: 0o600 });
      const result = spawnSync('/bin/bash', ['-s', '--'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          FIXTURE_ROOT: root,
          FIXTURE_JOURNAL: journal,
          FIXTURE_RECOVERY: recovery,
          FIXTURE_STARTED: String(started),
        },
        input: `
set -euo pipefail
NODE_BIN="$(command -v node)"
STATE_ROOT="$FIXTURE_ROOT"
BOOT_RECOVERY="$FIXTURE_RECOVERY"
ACTIVE_JOURNAL="$FIXTURE_JOURNAL"
TEST_MODE=1
NEXUS_RELEASE_BOOT_RECOVERY=1
export NEXUS_RELEASE_TEST_MODE=1
export NEXUS_PROMOTION_TEST_BOOT_ID=test-boot
export NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS=11
root_own(){ :; }
fsync_path(){ :; }
mv(){
  if [ "\${1:-}" = -T ]; then command mv "$3" "$4"
  else command mv "$@"
  fi
}
${shellFunction(layout, 'write_boot_recovery_origin')}
write_boot_recovery_origin "$FIXTURE_STARTED" "$((FIXTURE_STARTED + 120))"
`,
      });
      expect(result.status, result.stderr).toBe(0);
      const authority = JSON.parse(readFileSync(recovery, 'utf8')) as {
        bootDetectedEpoch: number;
        outageStartedEpoch: number;
        recoveryDeadlineEpoch: number;
      };
      expect(authority.outageStartedEpoch).toBeLessThanOrEqual(
        authority.bootDetectedEpoch,
      );
      expect(
        authority.recoveryDeadlineEpoch - authority.outageStartedEpoch,
      ).toBe(120);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes only the three receipt-bound V4 pre-layout staging states', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-v4-boot-role-')));
    try {
      const base = join(root, 'staging');
      const releases = join(base, 'releases');
      const runtime = join(releases, 'candidate');
      const state = join(root, 'v4-state');
      const transactions = join(state, 'transactions');
      const phaseA = join(root, 'phase-a.json');
      const receipt = join(state, 'install-receipt.v1.json');
      mkdirSync(runtime, { recursive: true, mode: 0o700 });
      mkdirSync(transactions, { recursive: true, mode: 0o700 });
      chmodSync(base, 0o755);
      chmodSync(releases, 0o755);
      chmodSync(runtime, 0o700);
      const runtimeSha = 'a'.repeat(40);
      const artifactDigest = 'b'.repeat(64);
      const markerBody = Buffer.from(`${JSON.stringify({
        schema: 'nexus.release-bundle.v1',
        runtimeSha,
        artifactDigest,
      }, null, 2)}\n`);
      const installedBody = Buffer.from(`${JSON.stringify({
        schema: 'nexus.installed-runtime-attestation.v1',
        identity: { runtimeSha, artifactDigest },
        aggregateDigest: 'c'.repeat(64),
      }, null, 2)}\n`);
      writeFileSync(join(runtime, '.complete.json'), markerBody, { mode: 0o600 });
      writeFileSync(
        join(runtime, '.nexus-installed-runtime.json'),
        installedBody,
        { mode: 0o600 },
      );
      symlinkSync(runtime, join(base, 'current'));
      const phaseABody = Buffer.from(`${JSON.stringify({
        schema: 'nexus.release-layout-phase-a-receipt.v1',
        status: 'completed',
        sourceSha: 'd'.repeat(40),
        sourceArchiveSha256: 'e'.repeat(64),
        phaseARecoveryGuard: true,
      }, null, 2)}\n`);
      writeFileSync(phaseA, phaseABody, { mode: 0o600 });
      writeFileSync(receipt, `${JSON.stringify({
        schema:
          'nexus.rollback-drill-v4-prelayout-staging-install-receipt.v1',
        status: 'active',
        promotionAllowed: false,
        control: { version: 'nexus-release-promotion-control.v4' },
        phaseA: {
          sourceSha: 'd'.repeat(40),
          archiveSha256: 'e'.repeat(64),
          receiptSha256:
            createHash('sha256').update(phaseABody).digest('hex'),
        },
      }, null, 2)}\n`, { mode: 0o600 });

      const invoke = () => spawnSync('/bin/bash', ['-s', '--'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          FIXTURE_BASE: base,
          FIXTURE_RECEIPT: receipt,
          FIXTURE_RETIRED: join(state, 'retired.absent'),
          FIXTURE_PHASE_A: phaseA,
          FIXTURE_TRANSACTIONS: transactions,
          FIXTURE_RELEASE_ROOT: join(root, 'release-root'),
          FIXTURE_OLD_PRODUCTION: join(root, 'production-unused'),
        },
        input: `
set -euo pipefail
NODE_BIN="$(command -v node)"
WORKER_UID="$(id -u)"
WORKER_GID="$(id -g)"
TEST_MODE=1
LAYOUT_ATTESTATION="$FIXTURE_RELEASE_ROOT/layout.absent"
V4_INSTALL_RECEIPT="$FIXTURE_RECEIPT"
V4_RETIRED_RECEIPT="$FIXTURE_RETIRED"
PHASE_A_RECEIPT="$FIXTURE_PHASE_A"
V4_TRANSACTIONS="$FIXTURE_TRANSACTIONS"
RELEASE_ROOT="$FIXTURE_RELEASE_ROOT"
OLD_PRODUCTION="$FIXTURE_OLD_PRODUCTION"
OLD_STAGING="$FIXTURE_BASE"
${section(boot, 'boot_role_evidence() {', '\nlegacy_role_fields() {')}
boot_role_evidence v4-prelayout staging
`,
      });

      const initial = invoke();
      expect(initial.status, initial.stderr).toBe(0);
      expect(JSON.parse(initial.stdout).profile).toBe('v4-prelayout-worker');

      const recoveredId = '11111111-1111-4111-8111-111111111111';
      const recoveredDir = join(transactions, recoveredId);
      mkdirSync(recoveredDir, { mode: 0o700 });
      writeFileSync(join(recoveredDir, 'journal.json'), `${JSON.stringify({
        schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
        requestId: recoveredId,
        phase: 'recovered',
        predecessor: { runtime },
      }, null, 2)}\n`, { mode: 0o600 });
      const secondRecoveredId = '33333333-3333-4333-8333-333333333333';
      const secondRecoveredDir = join(transactions, secondRecoveredId);
      mkdirSync(secondRecoveredDir, { mode: 0o700 });
      writeFileSync(
        join(secondRecoveredDir, 'journal.json'),
        `${JSON.stringify({
          schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
          requestId: secondRecoveredId,
          phase: 'recovered',
          predecessor: { runtime },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const recovered = invoke();
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        profile: 'v4-prelayout-recovered',
        transaction: { phase: 'recovered', count: 2 },
      });

      const completedId = '22222222-2222-4222-8222-222222222222';
      const completedDir = join(transactions, completedId);
      mkdirSync(completedDir, { mode: 0o700 });
      const evidenceBody = Buffer.from(`${JSON.stringify({
        schema: 'nexus.rollback-drill-legacy-staging-evidence.v1',
        status: 'completed',
        promotionAllowed: false,
        requestId: completedId,
        releaseDir: runtime,
        runtimeSha,
        artifactDigest,
        currentSelector: { target: runtime },
      }, null, 2)}\n`);
      writeFileSync(join(completedDir, 'evidence.json'), evidenceBody, {
        mode: 0o600,
      });
      writeFileSync(join(completedDir, 'journal.json'), `${JSON.stringify({
        schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
        requestId: completedId,
        phase: 'completed',
        candidateRuntime: runtime,
        evidenceSha256:
          createHash('sha256').update(evidenceBody).digest('hex'),
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(join(runtime, '.complete.json'), 0o444);
      chmodSync(join(runtime, '.nexus-installed-runtime.json'), 0o444);
      chmodSync(runtime, 0o555);
      const sealed = invoke();
      expect(sealed.status, sealed.stderr).toBe(0);
      expect(JSON.parse(sealed.stdout).profile).toBe(
        'v4-prelayout-sealed',
      );

      chmodSync(join(runtime, '.complete.json'), 0o644);
      expect(invoke().status).not.toBe(0);
    } finally {
      try {
        chmodSync(join(root, 'staging', 'releases', 'candidate'), 0o700);
      } catch {
        // The fixture may have failed before the runtime existed.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps temporary-daemon preflight read-only and rejects a live real service', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-pm2-preflight-')));
    try {
      const systemctl = join(root, 'systemctl');
      const log = join(root, 'systemctl.log');
      writeFileSync(systemctl, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
unit="$2"; property="$4"
if [ "$unit" = pm2-dominguez.service ]; then
  case "$property" in
    ActiveState) printf '%s\\n' "$REAL_ACTIVE" ;;
    MainPID) printf '%s\\n' "$REAL_PID" ;;
  esac
else
  case "$property" in
    ActiveState) printf 'inactive\\n' ;;
    MainPID) printf '0\\n' ;;
  esac
fi
`, { mode: 0o755 });
      const input = `
set -euo pipefail
SYSTEMCTL_BIN="$FIXTURE_SYSTEMCTL"
TEMP_PM2_UNIT=nexus-release-pm2-recovery-daemon.service
systemd_pm2_authority() { return 99; }
assert_no_ungoverned_pm2_daemon() { printf 'read-only-daemon-probe\\n' >> "$SYSTEMCTL_LOG"; }
${shellFunction(boot, 'preflight_temporary_pm2')}
preflight_temporary_pm2
`;
      const invoke = (active: string, pid: string) => spawnSync(
        '/bin/bash',
        ['-s', '--'],
        {
          encoding: 'utf8',
          input,
          env: {
            ...process.env,
            FIXTURE_SYSTEMCTL: systemctl,
            SYSTEMCTL_LOG: log,
            REAL_ACTIVE: active,
            REAL_PID: pid,
          },
        },
      );
      const live = invoke('active', '3736');
      expect(live.status).not.toBe(0);
      expect(live.stderr).toContain(
        'real pm2-dominguez is not inactive before sequential boot recovery',
      );
      expect(readFileSync(log, 'utf8')).not.toMatch(/\b(?:start|stop|restart)\b/u);

      writeFileSync(log, '');
      const inactive = invoke('inactive', '0');
      expect(inactive.status, inactive.stderr).toBe(0);
      expect(readFileSync(log, 'utf8')).toContain('read-only-daemon-probe');
      expect(readFileSync(log, 'utf8')).not.toMatch(/\b(?:start|stop|restart)\b/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('compares the legacy PM2 title suffix literally for forged regex paths', () => {
    const exactHome = '/tmp/pm2.home[exact](authority)+';
    const exactTitle = `PM2 v6.0.14: God Daemon (${exactHome})`;
    const invoke = (title: string) => spawnSync('/bin/bash', ['-s', '--'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIXTURE_PM2_HOME: exactHome,
        FIXTURE_PM2_TITLE: title,
      },
      input: `
set -euo pipefail
NODE_BIN="$(command -v node)"
${shellFunction(boot, 'validate_legacy_pm2_title')}
validate_legacy_pm2_title "$FIXTURE_PM2_TITLE" "$FIXTURE_PM2_HOME"
`,
    });

    expect(invoke(exactTitle).status).toBe(0);
    expect(invoke(
      'PM2 v6.0.14: God Daemon (/tmp/pm2Xhomeexactauthority)',
    ).status).not.toBe(0);
    expect(shellFunction(boot, 'validate_legacy_pm2_title')).not.toContain(
      'new RegExp',
    );
  });

  it('executes stale runtime cleanup without trusting or signalling a poisoned PID', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-pm2-stale-runtime-')));
    try {
      const target = join(root, 'unrelated-target');
      writeFileSync(target, 'must survive\n');
      writeFileSync(join(root, 'pm2.pid'), `${process.pid}\n`);
      writeFileSync(join(root, 'rpc.sock'), 'poison\n');
      symlinkSync(target, join(root, 'pub.sock'));
      const result = spawnSync('/bin/bash', ['-s', '--'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          PM2_HOME: root,
        },
        input: `
set -euo pipefail
PYTHON_BIN="$(command -v python3)"
WORKER_UID="$(id -u)"
WORKER_GID="$(id -g)"
${shellFunction(boot, 'remove_untrusted_pm2_runtime_files')}
remove_untrusted_pm2_runtime_files
`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(root, 'pm2.pid'))).toBe(false);
      expect(existsSync(join(root, 'rpc.sock'))).toBe(false);
      expect(existsSync(join(root, 'pub.sock'))).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('must survive\n');
      expect(process.kill(process.pid, 0)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds the daemon and all four apps to the exact systemd cgroup', () => {
    expect(boot).toContain(
      'pm2-dominguez.service:/system.slice/pm2-dominguez.service',
    );
    expect(boot).toContain(
      'nexus-release-pm2-recovery-daemon.service:/system.slice/nexus-release-pm2-recovery-daemon.service',
    );
    expect(boot).toContain('fs.readFileSync(`/proc/${row.pid}/cgroup`');
    expect(boot).toContain('entry.endsWith(controlGroup)');
    expect(boot).toContain('rows.length!==4');
    expect(boot).toContain('temporary recovery PM2 cgroup is not empty after stop');
    expect(boot).toContain('temporary recovery PM2 MainPID survived root cgroup stop');
  });

  it('uses one short exact title and clears inherited execution injection', () => {
    const title = 'NexusPM2:/opt/nexus-release/pm2/6.0.14';
    expect(temporaryUnit).toContain(`PM2_DAEMON_TITLE=${title}`);
    expect(installer).toContain(`PM2_DAEMON_TITLE=${title}`);
    expect(boot).toContain('PM2_DAEMON_TITLE="NexusPM2:$PM2_CLOSURE_ROOT"');

    const forbidden = [
      'NODE_OPTIONS',
      'NODE_PATH',
      'PM2_NODE_OPTIONS',
      'PYTHONPATH',
      'PYTHONHOME',
      'PYTHONINSPECT',
      'PYTHONSTARTUP',
      'PYTHONBREAKPOINT',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
    ].join(' ');
    expect(temporaryUnit).toContain(`UnsetEnvironment=${forbidden}`);
    expect(installer).toContain(`UnsetEnvironment=${forbidden}`);
    for (const name of forbidden.split(' ')) expect(boot).toContain(`'${name}'`);
  });

  it('republishes the root canonical dump at ordinary terminal transitions', () => {
    expect(worker).toContain('completed|recovered|failed_before_stop)');
    expect(worker).toContain('publish_terminal_pm2_authority');
    expect(staging).toContain('completed|recovered) publish_terminal_pm2_authority');
    expect(layout).toContain('"$BOOT_HEALTH_BIN" publish-current');
    expect(worker).toContain('boot-recovery-in-progress.v1.json');
    expect(staging).toContain('boot-recovery-in-progress.v1.json');
    expect(control).toContain('"$BOOT_HEALTH_BIN" prepare');
    expect(boot).toContain('schema:\'nexus.release-boot-health-pending.v3\'');
  });

  it('keeps customer ingress blocked until the real postcheck succeeds', () => {
    expect(installer).toContain(
      'ExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck',
    );
    expect(installer).toContain(
      '[Unit]\n'
      + 'Requires=nexus-release-layout-recovery.service '
      + 'nexus-release-promotion-recovery.service pm2-dominguez.service\n'
      + 'After=nexus-release-layout-recovery.service '
      + 'nexus-release-promotion-recovery.service pm2-dominguez.service',
    );
    expect(installer).toContain(
      'a cloudflared process bypasses the governed ingress unit',
    );
    expect(temporaryUnit).not.toContain('nexus-cloudflared.service');
  });

  it('admits PM2 only after exact boot preparation and finalizes marker last', () => {
    expect(control).toContain('assert-layout-boot-ready)');
    expect(control).toContain('validate_boot_recovery_prepared');
    expect(control).toContain('assert-boot-recovery-prepared)');
    expect(control).toContain(
      "!==crypto.createHash('sha256').update(recoveryInput.body).digest('hex')",
    );
    expect(layoutControl).toContain(
      '"$PROMOTION_CONTROL" assert-layout-boot-ready >/dev/null',
    );
    const finalize = section(
      control,
      'finalize_boot_recovery() {',
      '\nresolve_boot_sla_incident() {',
    );
    const clearActive = finalize.indexOf(
      'clear_terminal_active_during_boot_finalization',
    );
    const clearPending = finalize.indexOf('durable_remove "$BOOT_PENDING" 600');
    const clearRecovery = finalize.indexOf('durable_remove "$BOOT_RECOVERY" 600');
    expect(clearActive).toBeGreaterThan(-1);
    expect(clearPending).toBeGreaterThan(clearActive);
    expect(clearRecovery).toBeGreaterThan(clearPending);
  });
});

describe('boot recovery timing and incident closure', () => {
  it('separates the hard 120-second availability objective from full workflow wall time', () => {
    const timeout = Number(
      /^TimeoutStartSec=(\d+)s$/mu.exec(layoutUnit)?.[1],
    );
    // Worst phase budget: staging soak 60 + production availability recovery
    // 120 + production soak 60 + 60 seconds of bounded orchestration margin.
    expect(timeout).toBeGreaterThanOrEqual(60 + 120 + 60 + 60);
    expect(layout).toContain('recoveryDeadlineEpoch:started+120');
    expect(layout).toContain('production availability was not restored within 120 seconds');
    expect(layout).toContain('recoveryTargetSeconds:120');
    expect(layout).toContain('targetMet:targetMetRaw===\'true\'');
    expect(layout).toContain('"$BOOT_HEALTH_BIN" arm-current');
    expect(layout).toContain('"$BOOT_HEALTH_BIN" postcheck');
    expect(layout).not.toContain(
      '[ "$recovery_seconds" -le 120 ] || die "layout rollback exceeded 120 seconds"',
    );
    expect(layout).not.toContain('die "layout recovery exhausted its 120-second deadline"');
    expect(layout).not.toContain('|| die "layout rollback exceeded 120 seconds"');
    expect(recoveryUnit).toContain('After=local-fs.target nexus-release-layout-recovery.service');
  });

  it('clears a met target marker before disarming the retry journal', () => {
    const layoutRecovery = section(layout, 'recover_layout() {', '\nmigrate_layout() {');
    const targetMetBranch = layoutRecovery.indexOf('[ "$recovery_target_met" = true ]');
    const markerRemove = layoutRecovery.indexOf('rm -f -- "$BOOT_RECOVERY"', targetMetBranch);
    const journalRemove = layoutRecovery.indexOf(
      '"$ACTIVE_JOURNAL" "$REQUEST_COPY"',
      markerRemove,
    );
    expect(targetMetBranch).toBeGreaterThan(-1);
    expect(markerRemove).toBeGreaterThan(targetMetBranch);
    expect(journalRemove).toBeGreaterThan(markerRemove);
    expect(layoutRecovery.slice(markerRemove, journalRemove)).toContain(
      'fsync_path "$STATE_ROOT"',
    );
  });

  it('records an SLA miss without clearing the root promotion blocker', () => {
    const postcheck = section(control, '  boot-postcheck)', '  resolve-boot-sla-incident)');
    expect(postcheck).toContain('healthy_sla_missed');
    expect(postcheck).toContain('"promotionBlocked":true');
    expect(postcheck.indexOf('exit 0')).toBeLessThan(
      postcheck.indexOf('finalize_boot_recovery'),
    );
    expect(control).toContain('cannot activate a promotion while boot recovery is unresolved');
    expect(control).toContain('incident resolution archive is unsafe');
    expect(control).toContain('no unresolved boot SLA incident exists');
  });

  it('keeps SLA resolution root-only, digest-bound, and resumable after interruption', () => {
    expect(control).toContain('promotion control must run as root');
    expect(control).toContain('resolve-boot-sla-incident requires the exact proof SHA-256');
    expect(control).toContain('boot SLA incident proof digest changed');
    expect(control).toContain('${expected_digest}.resolution.json');
    expect(control).toContain('resolution.value.proofSha256!==proofSha256');
    expect(control).toContain('journal_terminal "$transaction_id" "$request_sha"');
    const resolution = section(
      control,
      'resolve_boot_sla_incident() {',
      '\nvalidate_prelayout_boot_marker() {',
    );
    const clearActive = resolution.lastIndexOf(
      'clear_terminal_active_during_boot_finalization',
    );
    const clearPending = resolution.lastIndexOf(
      'durable_remove "$BOOT_PENDING" 600',
    );
    const clearRecovery = resolution.lastIndexOf(
      'durable_remove "$BOOT_RECOVERY" 600',
    );
    expect(clearActive).toBeGreaterThan(-1);
    expect(clearPending).toBeGreaterThan(clearActive);
    expect(clearRecovery).toBeGreaterThan(clearPending);

    const sudoers = section(
      installer,
      'sudoers_tmp="$(mktemp)"',
      'visudo -cf "$sudoers_tmp"',
    );
    expect(sudoers).not.toContain('resolve-boot-sla-incident');
    expect(sudoers).not.toContain('boot-postcheck');
    expect(sudoers).not.toContain('recover-all');
    expect(sudoers).not.toContain('resolve-prelayout-boot-recovery');
  });

  it('limits stale pre-layout marker closure to exact Phase A and read-only live proof', () => {
    const resolver = section(
      control,
      'resolve_prelayout_boot_recovery() {',
      '\nwrite_active() {',
    );
    const verifier = section(
      boot,
      'verify_live_prelayout() {',
      '\nstart_exact_roles() {',
    );
    expect(resolver).toContain('validate_prelayout_boot_marker "$expected_digest"');
    expect(resolver).toContain('"$BOOT_HEALTH_BIN" verify-live-prelayout');
    expect(resolver).toContain('assert_no_unfinished_staging_transaction');
    expect(resolver).toContain('"$LAYOUT_ATTESTATION"');
    expect(resolver).toContain('durable_remove "$BOOT_RECOVERY" 600');
    expect(control).toContain('nexus.release-prelayout-boot-recovery-resolution.v1');
    expect(boot).toContain('nexus.release-layout-phase-a-receipt.v1');
    expect(boot).toContain('identity.afterUnits?.[\'pm2-dominguez.service\']');
    expect(boot).toContain('sha(showBody)!==expectedUnit.showSha256');
    expect(boot).toContain('fs.realpathSync.native(procExecutable)');
    expect(boot).toContain("classification:'worker_owned_legacy_observation'");
    expect(boot).toContain(
      "ancestryPolicy:'linuxbrew_worker_owned_no_world_write'",
    );
    expect(boot).toContain('fs.fstatSync(executableFd)');
    expect(control).toContain(
      "service?.executable?.classification==='worker_owned_legacy_observation'",
    );
    expect(control).toContain("service?.executable?.mode===0o555");
    expect(boot).not.toContain('node/25.6.1');
    expect(verifier).not.toMatch(
      /"\$SYSTEMCTL_BIN"\s+(?:start|stop|restart)|"\$PM2_BIN"\s+(?:start|stop|delete|restart)/u,
    );
  });

  it('does not reuse a terminal transaction cutover as ordinary reboot timing', () => {
    const timing = section(
      control,
      'write_boot_recovery_authority() {',
      '\nfinalize_boot_recovery() {',
    );
    expect(timing).toContain('if ! journal_terminal "$active_id" "$active_sha"; then');
    expect(timing).toContain("source:'boot_detection'");
    expect(timing).toContain('candidates.sort((a,b)=>a.epoch-b.epoch)');
    expect(timing).toContain('if(origin.epoch===nowEpoch+1)');
    expect(timing).toContain('epoch:nowEpoch,monotonic:nowMonotonic');
  });
});
