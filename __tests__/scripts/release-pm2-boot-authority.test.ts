import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const boot = read('scripts/remote-release-boot-health.sh');
const control = read('scripts/remote-promotion-control.sh');
const installer = read('scripts/remote-promotion-systemd-install.sh');
const layout = read('scripts/remote-release-layout-migrate.sh');
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
  it('starts one governed temporary daemon before every boot reconciliation client', () => {
    const recoverAll = section(control, '  recover-all)', '  boot-postcheck)');
    const daemon = recoverAll.indexOf('"$BOOT_HEALTH_BIN" start-temporary');
    const stagingRecovery = recoverAll.indexOf('"$STAGING_BROKER" recover-all');
    const productionRecovery = recoverAll.indexOf('"$SYSTEMCTL_BIN" start "$unit"');
    const finalPrepare = recoverAll.indexOf('"$BOOT_HEALTH_BIN" prepare');
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
    expect(boot).toContain('assert_no_ungoverned_pm2_daemon');
    expect(boot).not.toMatch(/kill\s+["']?\$\(?.*pm2\.pid/u);
  });

  it('executes stale runtime cleanup without trusting or signalling a poisoned PID', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-pm2-stale-runtime-')));
    try {
      const target = join(root, 'unrelated-target');
      writeFileSync(target, 'must survive\n');
      writeFileSync(join(root, 'pm2.pid'), `${process.pid}\n`);
      writeFileSync(join(root, 'rpc.sock'), 'poison\n');
      symlinkSync(target, join(root, 'pub.sock'));
      const result = spawnSync('/bin/bash', ['-c', `
set -euo pipefail
PYTHON_BIN="$(command -v python3)"
PM2_HOME=${JSON.stringify(root)}
WORKER_UID="$(id -u)"
WORKER_GID="$(id -g)"
${shellFunction(boot, 'remove_untrusted_pm2_runtime_files')}
remove_untrusted_pm2_runtime_files
`], { encoding: 'utf8' });
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
    expect(boot).toContain('schema:\'nexus.release-boot-health-pending.v2\'');
  });

  it('keeps customer ingress blocked until the real postcheck succeeds', () => {
    expect(installer).toContain(
      'ExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck',
    );
    expect(installer).toContain('[Unit]\nRequires=pm2-dominguez.service\nAfter=pm2-dominguez.service');
    expect(installer).toContain(
      'a cloudflared process bypasses the governed ingress unit',
    );
    expect(temporaryUnit).not.toContain('nexus-cloudflared.service');
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

    const sudoers = section(
      installer,
      'sudoers_tmp="$(mktemp)"',
      'visudo -cf "$sudoers_tmp"',
    );
    expect(sudoers).not.toContain('resolve-boot-sla-incident');
    expect(sudoers).not.toContain('boot-postcheck');
    expect(sudoers).not.toContain('recover-all');
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
  });
});
