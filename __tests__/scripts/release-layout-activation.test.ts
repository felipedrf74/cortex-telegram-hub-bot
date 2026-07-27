import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve('.');
const activationControl = path.join(
  root,
  'scripts',
  'remote-release-layout-activation-control.sh',
);
const activationInstaller = path.join(
  root,
  'scripts',
  'remote-release-layout-activation-install.sh',
);
const layoutMigrate = path.join(root, 'scripts', 'remote-release-layout-migrate.sh');
const promotionControl = path.join(root, 'scripts', 'remote-promotion-control.sh');
const legacyInstaller = path.join(root, 'scripts', 'remote-promotion-systemd-install.sh');
const sqliteHelper = path.join(root, 'scripts', 'release-layout-sqlite.py');
const legacySqliteHelper = path.join(root, 'scripts', 'application-dr-sqlite.py');
const drillTool = path.join(root, 'scripts', 'release-layout-fault-drill.mjs');
const layoutAuthorization = path.join(
  root,
  'scripts',
  'release-layout-authorization.mjs',
);
const legacyInstallRecoveryUnit = path.join(
  root,
  'scripts',
  'systemd',
  'nexus-rollback-drill-legacy-staging-install-recovery.service',
);
const layoutInstallRecoveryUnit = path.join(
  root,
  'scripts',
  'systemd',
  'nexus-release-layout-install-recovery.service',
);
const layoutRecoveryUnit = path.join(
  root,
  'scripts',
  'systemd',
  'nexus-release-layout-recovery.service',
);

const temporaryRoots: string[] = [];
const makeRoot = (): string => {
  const value = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'nexus-layout-activation-',
  ));
  temporaryRoots.push(value);
  return value;
};
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
};
const writeJson = (file: string, value: unknown): Buffer => {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return body;
};
const run = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) => spawnSync(executable, args, {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, ...env },
});

const writeStatefulSystemctl = (
  executable: string,
  stateRoot: string,
  initial: Record<string, 'enabled' | 'enabled-runtime' | 'disabled'> = {},
  logFile?: string,
): void => {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const [unit, state] of Object.entries(initial)) {
    fs.writeFileSync(path.join(stateRoot, unit), `${state}\n`, { mode: 0o600 });
  }
  fs.writeFileSync(executable, `#!/usr/bin/env bash
set -euo pipefail
state_root=${JSON.stringify(stateRoot)}
log_file=${JSON.stringify(logFile ?? '')}
command="\${1:-}"
[ -z "$log_file" ] || printf '%s\\n' "$*" >>"$log_file"
shift || true
unit="\${1:-}"
if [ "\${NEXUS_TEST_SYSTEMCTL_FAIL:-}" = "$command:$unit" ]; then
  exit 97
fi
case "$command" in
  daemon-reload)
    [ "\${NEXUS_TEST_SYSTEMCTL_FAIL:-}" != daemon-reload ] || exit 97
    ;;
  is-enabled)
    state_file="$state_root/$unit"
    if [ ! -f "$state_file" ]; then
      printf 'not-found\\n'
      exit 4
    fi
    state="$(tr -d '\\n' <"$state_file")"
    printf '%s\\n' "$state"
    case "$state" in
      enabled|enabled-runtime) exit 0 ;;
      disabled) exit 1 ;;
      *) exit 4 ;;
    esac
    ;;
  enable)
    state=enabled
    if [ "$unit" = --runtime ]; then
      state=enabled-runtime
      shift
      unit="\${1:-}"
    fi
    [ "\${NEXUS_TEST_SYSTEMCTL_FAIL:-}" != "enable:$unit" ] || exit 97
    printf '%s\\n' "$state" >"$state_root/$unit"
    ;;
  disable)
    [ "\${NEXUS_TEST_SYSTEMCTL_FAIL:-}" != "disable:$unit" ] || exit 97
    printf 'disabled\\n' >"$state_root/$unit"
    ;;
  *)
    exit 64
    ;;
esac
`, { mode: 0o755 });
};

afterEach(() => {
  for (const value of temporaryRoots.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe('release-layout activation safety transaction', () => {
  it('keeps Phase A non-disruptive and legacy bootstrap fail-closed', () => {
    const installer = fs.readFileSync(activationInstaller, 'utf8');
    const control = fs.readFileSync(activationControl, 'utf8');
    const promotion = fs.readFileSync(promotionControl, 'utf8');
    const legacy = fs.readFileSync(legacyInstaller, 'utf8');
    const phaseA = installer.slice(
      installer.indexOf('\nphase_a() {'),
      installer.indexOf('write_handover_journal() {'),
    );
    const phaseATargets = installer.slice(
      installer.indexOf('PHASE_A_TARGETS=('),
      installer.indexOf('\n)\n# This is the exact target order'),
    );
    const predecessorTargets = installer.slice(
      installer.indexOf('PHASE_A_PREDECESSOR_TARGETS=('),
      installer.indexOf('\n)\nPHASE_A_PREDECESSOR_RECEIPT_ASSETS=('),
    );
    const requiredInputs = installer.slice(
      installer.indexOf('REQUIRED_INPUTS=('),
      installer.indexOf('\n)\n\nvalidate_source() {'),
    );

    expect(phaseA).toContain('capture_service_identity "$before"');
    expect(phaseA).toContain('capture_service_identity "$after"');
    expect(phaseA).toContain('before.runtimeSha256!==after.runtimeSha256');
    expect(phaseA).toContain('write_phase_a_journal');
    expect(phaseA).toContain('phase_a_checkpoint recovery_guard_active');
    expect(phaseA).toContain("trap 'phase_a_failure $?' EXIT");
    expect(phaseA).toContain('assert-root-pm2-ready');
    expect(phaseA.indexOf('assert-root-pm2-ready'))
      .toBeLessThan(phaseA.indexOf('write_phase_a_journal'));
    expect(phaseA).toContain('phase-a-retirement-plan');
    expect(phaseA).not.toContain('assert-terminal-retirement-ready');
    expect(phaseA.indexOf('acquire_phase_locks'))
      .toBeLessThan(phaseA.indexOf('phase-a-retirement-plan'));
    expect(phaseA.indexOf('acquire_phase_locks'))
      .toBeLessThan(phaseA.indexOf('assert_legacy_install_state_safe'));
    expect(phaseA.indexOf('assert_legacy_install_state_safe'))
      .toBeLessThan(phaseA.indexOf('write_phase_a_journal'));
    expect(phaseA).toContain('legacy_v2_adapter_assets_retired');
    expect(phaseA.indexOf('legacy_v2_adapter_assets_retired'))
      .toBeLessThan(phaseA.indexOf('rm -f -- "$LEGACY_RECEIPT"'));
    expect(phaseA.indexOf('retire_legacy_adapter'))
      .toBeLessThan(phaseA.indexOf(
        'install_file_atomically \\\n    "$source_root/scripts/remote-promotion-control.sh"',
      ));
    expect(phaseA).toContain('remote-release-preflight.sh');
    expect(phaseA).toContain('remote-release-boot-health.sh');
    expect(phaseA).toContain('ollama-install-state-check.mjs');
    expect(phaseA).toContain('00-nexus-ollama-install-guard.conf');
    expect(phaseA).toContain('remote-staging-attestation-broker.sh');
    expect(phaseA).toContain('nexus-release-pm2-recovery-daemon.service');
    expect(phaseA).toContain('nexus-release-promotion-recovery.service');
    expect(phaseA.indexOf('remote-release-boot-health.sh'))
      .toBeLessThan(phaseA.indexOf(
        'install_file_atomically \\\n    "$source_root/scripts/remote-promotion-control.sh"',
      ));
    expect(phaseA.indexOf('write_phase_a_journal'))
      .toBeLessThan(phaseA.indexOf('ollama-install-state-check.mjs'));
    expect(phaseA.indexOf('ollama-install-state-check.mjs'))
      .toBeLessThan(phaseA.indexOf('00-nexus-ollama-install-guard.conf'));
    expect(phaseA.indexOf('00-nexus-ollama-install-guard.conf'))
      .toBeLessThan(phaseA.indexOf(
        'install_file_atomically \\\n    "$source_root/scripts/remote-promotion-control.sh"',
      ));
    expect(phaseA).toContain(
      'phase_a_checkpoint ollama_install_guard_installed',
    );
    expect(installer).toContain(
      'upgrade-phase-a <source-root> <protected-main-sha>',
    );
    expect(installer).toContain('upgrade-phase-a) phase_a "$@"');
    expect(phaseA).toContain('validate_phase_a_upgrade_authority');
    expect(installer).toContain(
      'completedAt:upgrading?predecessorCompletedAt:now',
    );
    expect(installer).toContain('upgradedAt:upgrading?now:null');
    expect(phaseA).toContain(
      'phase_a_checkpoint upgrade_recovery_anchor_installed',
    );
    expect(phaseA).toContain('expand_phase_a_upgrade_journal');
    expect(phaseA).toContain('phase_a_checkpoint predecessor_receipt_archived');
    expect(phaseA.indexOf('write_phase_a_journal'))
      .toBeLessThan(phaseA.indexOf(
        'phase_a_checkpoint upgrade_recovery_anchor_installed',
      ));
    expect(phaseA.indexOf('phase_a_checkpoint upgrade_recovery_anchor_installed'))
      .toBeLessThan(phaseA.indexOf('expand_phase_a_upgrade_journal'));
    expect(phaseA.indexOf('expand_phase_a_upgrade_journal'))
      .toBeLessThan(phaseA.indexOf(
        '"$PHASE_A_RECEIPT" "$PHASE_A_PREDECESSOR_RECEIPT" 600',
      ));
    expect(phaseA.indexOf(
      '"$PHASE_A_RECEIPT" "$PHASE_A_PREDECESSOR_RECEIPT" 600',
    )).toBeLessThan(phaseA.indexOf(
      'install_file_atomically \\\n    "$source_root/scripts/remote-promotion-control.sh"',
    ));
    expect(phaseATargets).toContain('"$OLLAMA_INSTALL_STATE_TARGET"');
    expect(phaseATargets).toContain('"$OLLAMA_INSTALL_GUARD_TARGET"');
    expect(phaseATargets).toContain('"$PHASE_A_PREDECESSOR_RECEIPT"');
    expect(phaseATargets).not.toContain('V4_DRILL_');
    expect(phaseA).not.toContain('v4-prelayout');
    expect(predecessorTargets).not.toContain('OLLAMA_INSTALL_');
    expect(requiredInputs).toContain('scripts/ollama-install-state-check.mjs');
    expect(requiredInputs).toContain(
      'scripts/systemd/00-nexus-ollama-install-guard.conf',
    );
    expect(requiredInputs).not.toContain('v4-prelayout');
    expect(phaseA.indexOf('nexus-release-promotion-recovery.service" \\'))
      .toBeLessThan(phaseA.indexOf(
        'enable nexus-release-promotion-recovery.service',
      ));
    expect(phaseA.indexOf('enable nexus-release-promotion-recovery.service'))
      .toBeLessThan(phaseA.indexOf(
        'install_file_atomically \\\n    "$source_root/scripts/remote-promotion-control.sh"',
      ));
    expect(installer).toContain(
      'PREFLIGHT_TARGET="${NEXUS_LAYOUT_PREFLIGHT_TARGET:-/usr/local/libexec/nexus-release-layout-preflight.sh}"',
    );
    expect(phaseA).not.toMatch(/\bsystemctl"\s+(?:restart|stop|start)\b/u);
    expect(phaseA).not.toContain('publish_pm2_handover');
    expect(phaseA).not.toContain('publish_ingress_handover');
    expect(installer).toContain('serviceRestarted:false,ingressRestarted:false');
    expect(installer).toContain('runningServiceIdentity:{runtimeUnchanged:true');
    expect(installer).toContain(
      "'MainPID','ExecMainStartTimestampMonotonic','NRestarts'",
    );
    expect(installer).toContain('"$PROMOTION_CONTROL" assert-layout-ready >/dev/null');
    expect(installer).toContain('competing pm2-root.service must already be absent or masked');
    expect(installer).toContain('restore_handover');
    expect(installer).toContain('layoutAttestationSha256');
    expect(installer).toContain(
      'Phase A receipt belongs to a different protected source',
    );
    expect(installer).toContain('recover_phase_a_strict');
    expect(installer).toContain('restore_handover_strict');
    expect(installer).toContain('restore_unit_enablement_state');
    expect(installer).toContain('enable --runtime "$unit"');
    expect(installer).not.toMatch(
      /(?:recover_phase_a|restore_handover|disable[^\n]*)\s+\|\|\s+true/u,
    );

    const sudoersLine = installer.split('\n').find((line) => (
      line.includes('Cmnd_Alias NEXUS_LAYOUT_ACTIVATION')
    ));
    expect(sudoersLine).toBeDefined();
    expect(sudoersLine).toContain(' submit *');
    expect(sudoersLine).toContain(' status');
    expect(sudoersLine).toContain(' fetch *');
    expect(sudoersLine).not.toContain(' run');
    expect(sudoersLine).not.toContain('recover-all');

    expect(control).toContain('nexus-release-layout-activation@$id.service');
    expect(control).toContain('case "$phase"');
    expect(control).toContain('running) recover_transaction');
    expect(control).toContain('reconcile_orphan_transaction');
    expect(control).toContain(
      '--accepted-recovery-journal "$journal" >"$current_authority"',
    );
    expect(control).toContain(
      'verify_drill_proof "$drill" "$current_drill" "$journal" "$request"',
    );
    expect(control).not.toContain('--allow-expired');
    expect(control).toContain('submittedAt<requestCreatedAt');
    expect(control).toContain('submittedAt>requestExpiresAt');
    expect(control).toContain('submittedAt<planCreatedAt');
    expect(control).toContain('submittedAt>planExpiresAt');
    expect(control.indexOf('verify_transaction_admission "$id"'))
      .toBeLessThan(control.indexOf(
        'atomic_json "$ACTIVE" schema=nexus.release-layout-activation-active.v1',
      ));
    expect(control).toContain('verify_drill_proof "$drill" "$drill_proof"');
    expect(control.indexOf('verify_drill_proof "$drill" "$drill_proof"'))
      .toBeLessThan(control.indexOf('atomic_copy "$request" "$directory/request-envelope.json"'));
    expect(control).not.toContain('activation remains MANUAL_REQUIRED');
    expect(promotion).toContain('LAYOUT_ACTIVATION_ACTIVE');
    expect(promotion).toContain('release layout activation is active');
    expect(promotion).toContain('--input "$LAYOUT_DRILL"');
    expect(promotion).toContain('--require-root-trust --allow-expired');
    expect(promotion).toContain(
      "const rootUid=testMode==='1'?process.getuid():0;",
    );
    expect(promotion).toContain(
      "const rootGid=testMode==='1'?process.getgid():0;",
    );
    expect(legacy).toContain('safe Phase B layout handover is incomplete');
    expect(legacy.indexOf('safe Phase B layout handover is incomplete'))
      .toBeLessThan(legacy.indexOf('BOOTSTRAP_JOURNAL='));
  });

  it('accepts only the exact completed predecessor receipt as upgrade authority', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const assetRoot = path.join(fixture, 'assets');
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(assetRoot, { mode: 0o700 });
    const asset = (name: string) => path.join(assetRoot, name);
    const layout: Array<[string, string]> = [
      ['NEXUS_LAYOUT_INSTALLER_TARGET', asset('activation-install')],
      ['NEXUS_LAYOUT_CONTROL_TARGET', asset('activation-control')],
      ['NEXUS_LAYOUT_MIGRATE_TARGET', asset('layout-migrate')],
      ['NEXUS_LAYOUT_SQLITE_TARGET', asset('layout-sqlite.py')],
      ['NEXUS_LAYOUT_AUTH_TARGET', asset('layout-authorization.mjs')],
      ['NEXUS_LAYOUT_DRILL_VERIFY_TARGET', asset('layout-fault-drill.mjs')],
      ['NEXUS_LAYOUT_ATTESTOR_TARGET', asset('runtime-attestor.mjs')],
      ['NEXUS_LAYOUT_SELECTOR_TARGET', asset('selector.py')],
      ['NEXUS_LAYOUT_PREFLIGHT_TARGET', asset('layout-preflight.sh')],
      ['NEXUS_LAYOUT_PROMOTION_CONTROL_TARGET', asset('promotion-control')],
      ['NEXUS_LAYOUT_ACTIVATION_UNIT_TARGET', asset('activation@.service')],
      ['NEXUS_LAYOUT_FILESYSTEM_IDENTITY_TARGET', asset('filesystem-identity.mjs')],
      ['NEXUS_LAYOUT_STAGING_BROKER_TARGET', asset('staging-broker.sh')],
      [
        'NEXUS_LAYOUT_PM2_CAPTURE_AUTHORITY_TARGET',
        asset('capture-pm2-dump-authority.mjs'),
      ],
      ['NEXUS_LAYOUT_PM2_DUMP_AUTHORITY_TARGET', asset('pm2-dump-authority.py')],
      ['NEXUS_LAYOUT_BOOT_HEALTH_TARGET', asset('release-boot-health')],
      ['NEXUS_LAYOUT_PM2_RECOVERY_UNIT_TARGET', asset('pm2-recovery.service')],
      [
        'NEXUS_LAYOUT_PROMOTION_RECOVERY_UNIT_TARGET',
        asset('promotion-recovery.service'),
      ],
      ['NEXUS_LAYOUT_RECOVERY_UNIT_TARGET', asset('layout-recovery.service')],
      [
        'NEXUS_LAYOUT_INSTALL_RECOVERY_UNIT_TARGET',
        asset('layout-install-recovery.service'),
      ],
      ['NEXUS_LAYOUT_INSTALL_GUARD_TARGET', asset('layout-install-guard.conf')],
      ['NEXUS_LAYOUT_SUDOERS_TARGET', asset('layout-sudoers')],
    ];
    for (const [, target] of layout) {
      fs.writeFileSync(target, `reviewed:${path.basename(target)}\n`, { mode: 0o600 });
    }
    const receipt = path.join(activationRoot, 'phase-a-receipt.v1.json');
    const initialCompletedAt = '2026-07-26T22:25:59.574Z';
    const existingBootDetectedAt = '2026-07-26T22:28:24.000Z';
    expect(Date.parse(initialCompletedAt)).toBeLessThan(
      Date.parse(existingBootDetectedAt),
    );
    const receiptBody = writeJson(receipt, {
      schema: 'nexus.release-layout-phase-a-receipt.v1',
      status: 'completed',
      sourceSha: '8'.repeat(40),
      sourceArchiveSha256: '9'.repeat(64),
      completedAt: initialCompletedAt,
      existingServiceIdentity: {
        runtimeUnchanged: true,
        beforeSha256: 'a'.repeat(64),
        afterSha256: 'b'.repeat(64),
        runtimeSha256: 'c'.repeat(64),
      },
      installedAssets: layout.map(([, target]) => ({
        path: target,
        sha256: digest(fs.readFileSync(target)),
      })),
      phaseARecoveryGuard: true,
      legacyV2AdapterRetired: false,
      legacyRetirementSha256: null,
      pm2Prerequisite: {
        verified: true,
        evidenceSha256: 'd'.repeat(64),
      },
      prohibitedCommands: ['run', 'recover-all'],
    });
    const env = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: path.join(fixture, 'legacy'),
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_LAYOUT_SYSTEMCTL_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      ...Object.fromEntries(layout),
      NEXUS_LAYOUT_OLLAMA_INSTALL_STATE_TARGET: asset('future-ollama-state'),
      NEXUS_LAYOUT_OLLAMA_INSTALL_GUARD_TARGET: asset('future-ollama-guard'),
    };
    const accepted = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'test-validate-phase-a-upgrade-authority',
    ], env);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout.trim()).toBe(
      `${digest(receiptBody)}\t${'8'.repeat(40)}\t${'9'.repeat(64)}`
        + `\t${initialCompletedAt}`,
    );

    fs.writeFileSync(layout[0][1], 'tampered predecessor\n', { mode: 0o600 });
    const rejected = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'test-validate-phase-a-upgrade-authority',
    ], env);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      'completed Phase A receipt is not valid upgrade authority',
    );
  });

  it('accepts only the canonical receipt-bound legacy retirement plan', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'promotion-state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const legacyRoot = path.join(fixture, 'legacy-state');
    const targetRoot = path.join(fixture, 'legacy-targets');
    const backupRoot = path.join(legacyRoot, 'install', 'predecessor');
    const control = path.join(fixture, 'promotion-control-v2');
    const planFile = path.join(fixture, 'retirement-plan.json');
    const relativeTargets = [
      'usr/local/sbin/nexus-rollback-drill-legacy-staging-install',
      'etc/systemd/system/nexus-rollback-drill-legacy-staging-install-recovery.service',
      'usr/local/sbin/nexus-rollback-drill-legacy-staging-broker',
      'usr/local/libexec/nexus-rollback-drill-legacy-staging-adapter.mjs',
      'usr/local/libexec/nexus-release-runtime-dependencies.mjs',
      'usr/local/libexec/nexus-release-installed-tree-attestation.mjs',
      'usr/local/libexec/nexus-release-recovery-runtime-identity.mjs',
      'etc/nexus-release/release-evidence-public-key.pem',
      'etc/systemd/system/nexus-rollback-drill-legacy-staging@.service',
      'etc/systemd/system/nexus-rollback-drill-legacy-staging-recovery.service',
      'etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf',
      'etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf',
      'etc/sudoers.d/nexus-rollback-drill-legacy-staging',
      'usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py',
    ];
    const expectedModes = [
      0o700, 0o644, 0o700, 0o700, 0o700, 0o700, 0o700,
      0o644, 0o644, 0o644, 0o644, 0o644, 0o440, 0o700,
    ];
    const receiptNames = [
      'installer',
      'installRecoveryUnit',
      'broker',
      'adapter',
      'dependencies',
      'installedAttestor',
      'recoveryAttestor',
      'releasePublicKey',
      'transactionUnit',
      'recoveryUnit',
      'pm2DominguezDropIn',
      'pm2RootDropIn',
      'sudoers',
      'filesystemHelper',
    ];
    const targetPaths = relativeTargets.map((relative) => path.join(targetRoot, relative));
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(control, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const identity = fs.statSync(control);
    const targets = targetPaths.map((targetPath, index) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
      const activeBody = Buffer.from(`active-${index}\n`);
      fs.writeFileSync(targetPath, activeBody, { mode: expectedModes[index] });
      const activeIdentity = fs.statSync(targetPath);
      const restore = index % 2 === 1;
      for (const [field, body] of [
        ['existed', restore ? '1\n' : '0\n'],
        ['mode', `${expectedModes[index].toString(8)}\n`],
        ['uid', `${activeIdentity.uid}\n`],
        ['gid', `${activeIdentity.gid}\n`],
      ]) {
        fs.writeFileSync(path.join(backupRoot, `${index}.${field}`), body, { mode: 0o600 });
      }
      let predecessor: Record<string, unknown> = { action: 'remove' };
      if (restore) {
        const predecessorPath = path.join(backupRoot, `${index}.file`);
        const predecessorBody = Buffer.from(`predecessor-${index}\n`);
        fs.writeFileSync(predecessorPath, predecessorBody, { mode: 0o600 });
        predecessor = {
          action: 'restore',
          sourcePath: predecessorPath,
          sha256: digest(predecessorBody),
          mode: expectedModes[index],
          uid: activeIdentity.uid,
          gid: activeIdentity.gid,
        };
      }
      return {
        path: targetPath,
        active: {
          sha256: digest(activeBody),
          mode: expectedModes[index],
          uid: activeIdentity.uid,
          gid: activeIdentity.gid,
        },
        predecessor,
      };
    });
    const retainedSqlite = path.join(
      targetRoot,
      'usr/local/libexec/nexus-application-dr/application-dr-sqlite.py',
    );
    fs.mkdirSync(path.dirname(retainedSqlite), { recursive: true, mode: 0o755 });
    const retainedBody = Buffer.from('retained-sqlite-helper\n');
    fs.writeFileSync(retainedSqlite, retainedBody, { mode: 0o644 });
    const retainedIdentity = fs.statSync(retainedSqlite);
    const source = {
      sourceSha: '1'.repeat(40),
      archiveSha256: '2'.repeat(64),
    };
    const controlBinding = {
      version: 'nexus-release-promotion-control.v2',
      sha256: digest(fs.readFileSync(control)),
    };
    const receiptFile = path.join(legacyRoot, 'install-receipt.v1.json');
    const receiptBody = writeJson(receiptFile, {
      schema: 'nexus.rollback-drill-legacy-staging-install-receipt.v1',
      status: 'active',
      promotionAllowed: false,
      source,
      control: controlBinding,
      installed: {
        ...Object.fromEntries(targets.map((item, index) => (
          [receiptNames[index], item.active.sha256]
        ))),
        sqliteTool: digest(retainedBody),
      },
      installedAt: new Date().toISOString(),
    });
    const validPlan = {
      schema: 'nexus.rollback-drill-legacy-staging-phase-a-retirement-plan.v1',
      status: 'ready',
      promotionAllowed: false,
      receipt: { path: receiptFile, sha256: digest(receiptBody) },
      source,
      control: controlBinding,
      recoveryUnit: {
        name: 'nexus-rollback-drill-legacy-staging-recovery.service',
        enabledState: 'disabled',
      },
      installRecoveryUnit: {
        name: 'nexus-rollback-drill-legacy-staging-install-recovery.service',
        enabledState: 'disabled',
      },
      retainedDependencies: [{
        path: retainedSqlite,
        sha256: digest(retainedBody),
        mode: 0o644,
        uid: retainedIdentity.uid,
        gid: retainedIdentity.gid,
      }],
      terminal: {
        count: 0,
        aggregateSha256: digest('[]'),
      },
      targets,
    };
    const env = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: legacyRoot,
      NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: targetRoot,
      NEXUS_LEGACY_DRILL_PM2_DOMINGUEZ_DROPIN: targetPaths[10],
      NEXUS_LEGACY_DRILL_PM2_ROOT_DROPIN: targetPaths[11],
      NEXUS_LAYOUT_PROMOTION_CONTROL_TARGET: control,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
    };
    const validate = (value: unknown, canonical = true) => {
      fs.writeFileSync(
        planFile,
        canonical ? `${canonicalJson(value)}\n` : `${JSON.stringify(value, null, 2)}\n`,
        { mode: 0o600 },
      );
      return run('/usr/bin/env', [
        'bash',
        activationInstaller,
        'test-validate-legacy-retirement-plan',
        planFile,
        'disabled',
        'disabled',
      ], env);
    };
    const accepted = validate(validPlan);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout.trim()).toBe(digest(fs.readFileSync(planFile)));

    const escaped = structuredClone(validPlan);
    escaped.targets[0].path = path.join(fixture, 'outside-allowlist');
    expect(validate(escaped).status).not.toBe(0);

    const retainedTamper = structuredClone(validPlan);
    retainedTamper.retainedDependencies[0].sha256 = 'f'.repeat(64);
    expect(validate(retainedTamper).status).not.toBe(0);

    const predecessorTamper = structuredClone(validPlan);
    const restored = predecessorTamper.targets[1].predecessor as Record<string, unknown>;
    restored.sourcePath = path.join(fixture, 'forged-predecessor');
    expect(validate(predecessorTamper).status).not.toBe(0);

    const missing = structuredClone(validPlan);
    missing.targets.pop();
    expect(validate(missing).status).not.toBe(0);
    expect(validate(validPlan, false).status).not.toBe(0);

    fs.writeFileSync(planFile, '{"schema":"first","schema":"second"}\n', { mode: 0o600 });
    const duplicate = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'test-validate-legacy-retirement-plan',
      planFile,
      'disabled',
      'disabled',
    ], env);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain('duplicate JSON key');

    writeJson(path.join(
      activationRoot,
      'phase-a-install-in-progress.v1.json',
    ), {
      schema: 'nexus.release-layout-phase-a-journal.v1',
      status: 'in_progress',
      legacyRetirement: {
        planSha256: digest(`${canonicalJson(validPlan)}\n`),
        plan: validPlan,
      },
    });
    const applied = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'test-apply-and-record-legacy-retirement',
    ], env);
    expect(applied.status, applied.stderr).toBe(0);
    for (const [index, targetPath] of targetPaths.entries()) {
      if (index % 2 === 0) {
        expect(fs.existsSync(targetPath)).toBe(false);
      } else {
        expect(fs.readFileSync(targetPath, 'utf8')).toBe(`predecessor-${index}\n`);
      }
    }
    expect(fs.readFileSync(retainedSqlite)).toEqual(retainedBody);
    expect(fs.existsSync(receiptFile)).toBe(true);
    const retired = JSON.parse(fs.readFileSync(
      path.join(legacyRoot, 'install-receipt.retired.v1.json'),
      'utf8',
    ));
    expect(retired.status).toBe('retired');
    expect(retired.retirementPlanSha256).toBe(digest(`${canonicalJson(validPlan)}\n`));
    expect(retired.retainedDependencies).toEqual(validPlan.retainedDependencies);
    expect(identity.uid).toBe(process.getuid());
  });

  it('binds the stopped database and rollback to the protected predecessor', () => {
    const migrate = fs.readFileSync(layoutMigrate, 'utf8');
    const recovery = migrate.slice(
      migrate.indexOf('recover_layout() {'),
      migrate.indexOf('migrate_layout() {'),
    );
    const databaseRecovery = migrate.slice(
      migrate.indexOf('ensure_recovered_database() {'),
      migrate.indexOf('verify_pm2_identity() {'),
    );
    const migration = migrate.slice(migrate.indexOf('migrate_layout() {'));

    expect(migration).toContain(
      'capture_database_boundary "$PREDECESSOR_ROOT/$migration_id/production"',
    );
    expect(migrate).toContain('copy-stopped-boundary');
    expect(migrate).toContain('stoppedBoundaryCopyEvidenceSha256');
    expect(recovery.indexOf('rollback_role_layout production'))
      .toBeLessThan(recovery.indexOf('pin_recovered_legacy_base production'));
    expect(recovery.indexOf('pin_recovered_legacy_base staging'))
      .toBeLessThan(recovery.indexOf('ensure_recovered_database'));
    expect(recovery.indexOf('ensure_recovered_database'))
      .toBeLessThan(recovery.indexOf('verify_frozen_legacy_runtime "$OLD_PRODUCTION"'));
    expect(recovery.indexOf('verify_frozen_legacy_runtime "$OLD_STAGING"'))
      .toBeLessThan(recovery.indexOf('restore_legacy_base_metadata production'));
    expect(recovery.indexOf('restore_legacy_base_metadata staging'))
      .toBeLessThan(recovery.indexOf('start_role production'));
    expect(databaseRecovery).toContain('retainedLiveDatabase:true');
    expect(databaseRecovery).toContain(
      '"$PYTHON_BIN" "$SQLITE_HELPER" stopped-boundary "$database"',
    );
    expect(databaseRecovery.indexOf('retainedLiveDatabase:true'))
      .toBeLessThan(databaseRecovery.indexOf('retainedLiveDatabase:false'));
    const publishedRecovery = recovery.slice(
      recovery.indexOf('# A crash after the three durable records'),
      recovery.indexOf('remove_partial_publication'),
    );
    expect(publishedRecovery).toContain('reconcile_published_compatibility_mounts');
    expect(publishedRecovery.indexOf('reconcile_published_compatibility_mounts'))
      .toBeLessThan(publishedRecovery.indexOf('rm -f -- "$ACTIVE_JOURNAL"'));

    const attestor = fs.readFileSync(
      path.join(root, 'scripts', 'trusted-release-runtime-attestation.mjs'),
      'utf8',
    );
    expect(attestor).toContain(
      '^\\/srv\\/nexus-release\\/layout-predecessors\\/',
    );
    expect(attestor).not.toContain('^\\/srv\\/nexus\\/releases\\/');
  });

  it('resumes a killed running activation through recovery rather than a second migration', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const transactionId = '12345678-1234-4123-8123-123456789abc';
    const transaction = path.join(activationRoot, 'transactions', transactionId);
    const bin = path.join(fixture, 'bin');
    const log = path.join(fixture, 'migrate.log');
    fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bin, { mode: 0o700 });
    writeJson(path.join(transaction, 'journal.v1.json'), {
      schema: 'nexus.release-layout-activation-transaction.v1',
      phase: 'running',
      transactionId,
      requestEnvelopeSha256: '1'.repeat(64),
      faultDrillEnvelopeSha256: '2'.repeat(64),
      submittedAt: new Date().toISOString(),
    });
    writeJson(path.join(activationRoot, 'active.v1.json'), {
      schema: 'nexus.release-layout-activation-active.v1',
      transactionId,
      requestEnvelopeSha256: '1'.repeat(64),
      activatedAt: new Date().toISOString(),
    });
    const migrate = path.join(bin, 'migrate');
    fs.writeFileSync(migrate, `#!/usr/bin/env bash
printf '%s\\n' "$1" >>${JSON.stringify(log)}
[ "$1" = recover ]
`, { mode: 0o755 });
    const auth = path.join(bin, 'auth');
    fs.writeFileSync(auth, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const handover = path.join(bin, 'handover');
    fs.writeFileSync(handover, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const promotion = path.join(bin, 'promotion-control');
    fs.writeFileSync(promotion, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const systemctl = path.join(bin, 'systemctl');
    fs.writeFileSync(systemctl, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const result = run('/usr/bin/env', ['bash', activationControl, 'run', transactionId], {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LAYOUT_MIGRATE_BIN: migrate,
      NEXUS_LAYOUT_AUTH_BIN: auth,
      NEXUS_LAYOUT_DRILL_VERIFY_BIN: auth,
      NEXUS_LAYOUT_HANDOVER_BIN: handover,
      NEXUS_LAYOUT_PROMOTION_CONTROL: promotion,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: systemctl,
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toBe('recover\n');
    const journal = JSON.parse(
      fs.readFileSync(path.join(transaction, 'journal.v1.json'), 'utf8'),
    );
    expect(journal.phase).toBe('recovered');
    expect(fs.existsSync(path.join(activationRoot, 'active.v1.json'))).toBe(false);
  });

  it('restores exact Phase B drop-in bytes and absence from its durable journal', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const pm2Parent = path.join(fixture, 'pm2.service.d');
    const ingressParent = path.join(fixture, 'cloudflared.service.d');
    const pm2Target = path.join(pm2Parent, 'nexus-release-recovery.conf');
    const ingressTarget = path.join(ingressParent, 'nexus-release-ready.conf');
    const systemctl = path.join(fixture, 'systemctl');
    const systemctlLog = path.join(fixture, 'systemctl.log');
    const unitStates = path.join(fixture, 'unit-states');
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(pm2Parent, { mode: 0o755 });
    fs.mkdirSync(ingressParent, { mode: 0o755 });
    fs.writeFileSync(pm2Target, 'original-pm2\n', { mode: 0o640 });
    const identity = fs.statSync(pm2Target);
    fs.writeFileSync(pm2Target, 'mutated-pm2\n', { mode: 0o644 });
    fs.writeFileSync(ingressTarget, 'mutated-ingress\n', { mode: 0o644 });
    writeStatefulSystemctl(systemctl, unitStates, {}, systemctlLog);
    const journalValue = {
      schema: 'nexus.release-layout-phase-b-journal.v1',
      status: 'in_progress',
      sourceSha: '1'.repeat(40),
      sourceArchiveSha256: '2'.repeat(64),
      layoutAttestationSha256: '3'.repeat(64),
      createdAt: new Date().toISOString(),
      targets: [
        {
          path: pm2Target,
          parentPresent: true,
          present: true,
          uid: identity.uid,
          gid: identity.gid,
          mode: 0o640,
          sha256: digest('original-pm2\n'),
          bodyBase64: Buffer.from('original-pm2\n').toString('base64'),
        },
        {
          path: ingressTarget,
          parentPresent: false,
          present: false,
        },
      ],
    };
    writeJson(
      path.join(activationRoot, 'phase-b-handover-in-progress.v1.json'),
      journalValue,
    );

    const env = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LAYOUT_PM2_DROPIN: pm2Target,
      NEXUS_LAYOUT_INGRESS_DROPIN: ingressTarget,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: systemctl,
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_RELEASE_MUTEX: path.join(fixture, 'release-sonar.lock'),
      NEXUS_LAYOUT_CONTROL_LOCK: path.join(stateRoot, '.control.lock'),
    };
    const journal = path.join(
      activationRoot,
      'phase-b-handover-in-progress.v1.json',
    );

    const daemonFailure = run(
      '/usr/bin/env',
      ['bash', activationInstaller, 'recover-handover'],
      { ...env, NEXUS_TEST_SYSTEMCTL_FAIL: 'daemon-reload' },
    );
    expect(daemonFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);

    const receipt = path.join(activationRoot, 'phase-b-receipt.v1.json');
    fs.mkdirSync(receipt, { mode: 0o700 });
    const receiptFailure = run(
      '/usr/bin/env',
      ['bash', activationInstaller, 'recover-handover'],
      env,
    );
    expect(receiptFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);
    fs.rmdirSync(receipt);

    const fsyncFailure = run(
      '/usr/bin/env',
      ['bash', activationInstaller, 'recover-handover'],
      { ...env, NEXUS_LAYOUT_TEST_FAIL_FSYNC_PATH: activationRoot },
    );
    expect(fsyncFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);

    const result = run(
      '/usr/bin/env',
      ['bash', activationInstaller, 'recover-handover'],
      env,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(pm2Target, 'utf8')).toBe('original-pm2\n');
    expect(fs.statSync(pm2Target).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(ingressTarget)).toBe(false);
    expect(fs.existsSync(ingressParent)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readFileSync(systemctlLog, 'utf8').match(/daemon-reload/g)?.length)
      .toBe(4);

    writeJson(journal, {
      ...journalValue,
      status: 'committed',
      committedAt: new Date().toISOString(),
    });
    const missingCommittedReceipt = run(
      '/usr/bin/env',
      ['bash', activationInstaller, 'recover-handover'],
      env,
    );
    expect(missingCommittedReceipt.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it('keeps PM2 fail-closed while Phase A recovery is incomplete or failed', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const controlTarget = path.join(fixture, 'activation-control');
    const blockMarker = path.join(fixture, 'block-boot');
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(controlTarget, `#!/usr/bin/env bash
[ "$1" = assert-boot-safe ] || exit 64
[ ! -e ${JSON.stringify(blockMarker)} ]
`, { mode: 0o755 });
    const journal = path.join(activationRoot, 'phase-a-install-in-progress.v1.json');
    writeJson(journal, {
      schema: 'nexus.release-layout-phase-a-journal.v1',
      status: 'in_progress',
    });
    const env = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_LAYOUT_CONTROL_TARGET: controlTarget,
    };
    const incomplete = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'assert-phase-a-safe',
    ], env);
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain('Phase A installation recovery is required');

    fs.rmSync(journal);
    writeJson(path.join(activationRoot, 'phase-a-recovery-failed.v1.json'), {
      schema: 'nexus.release-layout-phase-a-recovery-failure.v1',
      status: 'failed',
    });
    const failed = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'assert-phase-a-safe',
    ], env);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Phase A installation recovery failed');

    fs.rmSync(path.join(activationRoot, 'phase-a-recovery-failed.v1.json'));
    writeJson(path.join(activationRoot, 'phase-a-receipt.v1.json'), {
      schema: 'nexus.release-layout-phase-a-receipt.v1',
      status: 'completed',
      installedAssets: [{
        path: controlTarget,
        sha256: digest(fs.readFileSync(controlTarget)),
      }],
    });
    fs.writeFileSync(blockMarker, 'blocked\n', { mode: 0o600 });
    const layoutRecoveryBlocked = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'assert-phase-a-safe',
    ], env);
    expect(layoutRecoveryBlocked.status).not.toBe(0);
    fs.rmSync(blockMarker);
    const layoutRecoverySafe = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'assert-phase-a-safe',
    ], env);
    expect(layoutRecoverySafe.status, layoutRecoverySafe.stderr).toBe(0);

    const guard = fs.readFileSync(path.join(
      root,
      'scripts',
      'systemd',
      '10-nexus-release-layout-install-recovery.conf',
    ), 'utf8');
    expect(guard).toContain('Requires=nexus-release-layout-install-recovery.service');
    expect(guard).toContain('assert-phase-a-safe');
    expect(fs.readFileSync(activationInstaller, 'utf8')).toContain(
      '"$CONTROL_TARGET" assert-boot-safe',
    );
  });

  it('serializes legacy installer recovery before layout recovery and PM2', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const legacyRoot = path.join(fixture, 'legacy-state');
    const legacyInstallState = path.join(legacyRoot, 'install');
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(legacyInstallState, { recursive: true, mode: 0o700 });
    writeJson(path.join(legacyInstallState, 'install-in-progress.v1.json'), {
      schema: 'nexus.rollback-drill-legacy-staging-install-journal.v1',
      phase: 'prepared',
      promotionAllowed: false,
      source: {
        sourceSha: '1'.repeat(40),
        archiveSha256: '2'.repeat(64),
      },
      preparedAt: new Date().toISOString(),
    });
    const blocked = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: legacyRoot,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_RELEASE_MUTEX: path.join(fixture, 'release-sonar.lock'),
      NEXUS_LAYOUT_CONTROL_LOCK: path.join(stateRoot, '.control.lock'),
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain(
      'legacy adapter install recovery must complete before layout activation',
    );

    const legacyUnit = fs.readFileSync(legacyInstallRecoveryUnit, 'utf8');
    const layoutUnit = fs.readFileSync(layoutInstallRecoveryUnit, 'utf8');
    expect(legacyUnit).toContain(
      'Before=nexus-rollback-drill-legacy-staging-recovery.service '
      + 'nexus-release-layout-install-recovery.service '
      + 'pm2-dominguez.service pm2-root.service',
    );
    expect(layoutUnit).toContain(
      'Wants=nexus-rollback-drill-legacy-staging-install-recovery.service',
    );
    expect(layoutUnit).toContain(
      'After=local-fs.target '
      + 'nexus-rollback-drill-legacy-staging-install-recovery.service',
    );
  });

  it('grants recovery units only the exact restoration path families', () => {
    const writableRoots = (unitFile: string): string[] => {
      const unit = fs.readFileSync(unitFile, 'utf8');
      const directive = unit.split('\n').find((line) => (
        line.startsWith('ReadWritePaths=')
      ));
      expect(directive).toBeDefined();
      return directive!.slice('ReadWritePaths='.length).split(/\s+/u);
    };
    const permits = (roots: string[], candidate: string): boolean => (
      roots.some((rootPath) => (
        candidate === rootPath || candidate.startsWith(`${rootPath}/`)
      ))
    );

    const phaseA = writableRoots(layoutInstallRecoveryUnit);
    expect(phaseA).toContain('/etc/nexus-release');
    expect(phaseA).not.toContain('/etc');
    expect(permits(
      phaseA,
      '/etc/nexus-release/release-evidence-public-key.pem',
    )).toBe(true);
    expect(permits(phaseA, '/etc/ssh/sshd_config')).toBe(false);
    expect(permits(phaseA, '/etc/shadow')).toBe(false);

    const phaseB = writableRoots(layoutRecoveryUnit);
    expect(phaseB).toContain('/etc/systemd/system');
    expect(phaseB).toContain('/var/lib/nexus-rollback-drill-legacy-staging');
    expect(phaseB).not.toContain('/etc');
    expect(permits(
      phaseB,
      '/etc/systemd/system/pm2-dominguez.service.d/'
        + 'nexus-release-recovery.conf',
    )).toBe(true);
    expect(permits(
      phaseB,
      '/etc/systemd/system/cloudflared.service.d/'
        + 'nexus-release-ready.conf',
    )).toBe(true);
    expect(permits(
      phaseB,
      '/etc/nexus-release/release-evidence-public-key.pem',
    )).toBe(false);
    expect(permits(phaseB, '/etc/shadow')).toBe(false);
  });

  it('restores Phase A targets exactly while retaining the boot recovery anchors', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const legacyRoot = path.join(fixture, 'legacy');
    const targetRoot = path.join(fixture, 'targets');
    const target = (name: string) => path.join(targetRoot, name);
    const targets = {
      guard: target('pm2-guard.conf'),
      installer: target('activation-install'),
      control: target('activation-control'),
      migrate: target('layout-migrate'),
      sqlite: target('layout-sqlite.py'),
      auth: target('layout-authorization.mjs'),
      drill: target('layout-fault-drill.mjs'),
      attestor: target('runtime-attestor.mjs'),
      selector: target('selector.py'),
      preflight: target('layout-preflight.sh'),
      promotion: target('promotion-control'),
      filesystemIdentity: target('filesystem-identity.mjs'),
      stagingBroker: target('staging-broker.sh'),
      pm2CaptureAuthority: target('capture-pm2-dump-authority.mjs'),
      pm2DumpAuthority: target('pm2-dump-authority.py'),
      bootHealth: target('release-boot-health'),
      ollamaInstallState: target('ollama-install-state-check.mjs'),
      ollamaInstallGuard: path.join(
        targetRoot,
        'ollama.service.d',
        '00-nexus-ollama-install-guard.conf',
      ),
      pm2RecoveryUnit: target('pm2-recovery-daemon.service'),
      promotionRecoveryUnit: target('promotion-recovery.service'),
      activationUnit: target('activation@.service'),
      layoutRecovery: target('layout-recovery.service'),
      installRecovery: target('install-recovery.service'),
      sudoers: target('sudoers'),
      legacyDominguez: target('legacy-dominguez.conf'),
      legacyRoot: target('legacy-root.conf'),
    };
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(activationRoot, 'transactions'), { mode: 0o700 });
    fs.mkdirSync(legacyRoot, { mode: 0o700 });
    fs.mkdirSync(targetRoot, { mode: 0o700 });
    for (const anchor of [targets.guard, targets.installer, targets.installRecovery]) {
      fs.writeFileSync(anchor, `new-${path.basename(anchor)}\n`, { mode: 0o755 });
    }
    fs.writeFileSync(targets.control, 'mutated-control\n', { mode: 0o755 });
    fs.writeFileSync(targets.ollamaInstallState, 'mutated-state-checker\n', {
      mode: 0o700,
    });
    fs.mkdirSync(path.dirname(targets.ollamaInstallGuard), {
      mode: 0o755,
    });
    fs.writeFileSync(targets.ollamaInstallGuard, 'mutated-install-guard\n', {
      mode: 0o644,
    });
    const originalControl = Buffer.from('original-control\n');
    const controlIdentity = fs.statSync(targets.control);
    const phaseAReceipt = path.join(activationRoot, 'phase-a-receipt.v1.json');
    const phaseAPredecessorReceipt = path.join(
      activationRoot,
      'phase-a-predecessor-receipt.v1.json',
    );
    const legacyReceipt = path.join(legacyRoot, 'install-receipt.v1.json');
    const legacyRetired = path.join(legacyRoot, 'install-receipt.retired.v1.json');
    const ordered = [
      targets.guard,
      targets.installer,
      targets.control,
      targets.migrate,
      targets.sqlite,
      targets.auth,
      targets.drill,
      targets.attestor,
      targets.selector,
      targets.preflight,
      targets.promotion,
      targets.filesystemIdentity,
      targets.stagingBroker,
      targets.pm2CaptureAuthority,
      targets.pm2DumpAuthority,
      targets.bootHealth,
      targets.ollamaInstallState,
      targets.ollamaInstallGuard,
      targets.pm2RecoveryUnit,
      targets.promotionRecoveryUnit,
      targets.activationUnit,
      targets.layoutRecovery,
      targets.installRecovery,
      targets.sudoers,
      phaseAPredecessorReceipt,
      phaseAReceipt,
      legacyReceipt,
      legacyRetired,
    ];
    const records = ordered.map((file) => {
      if (file === targets.control) {
        return {
          path: file,
          parentPresent: true,
          present: true,
          uid: controlIdentity.uid,
          gid: controlIdentity.gid,
          mode: 0o755,
          sha256: digest(originalControl),
          bodyBase64: originalControl.toString('base64'),
        };
      }
      if (file === targets.ollamaInstallGuard) {
        return { path: file, parentPresent: false, present: false };
      }
      return { path: file, parentPresent: true, present: false };
    });
    writeJson(path.join(activationRoot, 'phase-a-install-in-progress.v1.json'), {
      schema: 'nexus.release-layout-phase-a-journal.v1',
      status: 'in_progress',
      checkpoint: 'promotion_control_v3_installed',
      sourceSha: '1'.repeat(40),
      sourceArchiveSha256: '2'.repeat(64),
      unitStates: {
        'nexus-release-layout-install-recovery.service': 'disabled',
        'nexus-release-promotion-recovery.service': 'not-found',
        'nexus-rollback-drill-legacy-staging-install-recovery.service':
          'not-found',
        'nexus-rollback-drill-legacy-staging-recovery.service': 'not-found',
      },
      targets: records,
      createdAt: new Date().toISOString(),
    });
    const systemctl = path.join(fixture, 'systemctl');
    const unitStates = path.join(fixture, 'unit-states');
    writeStatefulSystemctl(systemctl, unitStates, {
      'nexus-release-layout-install-recovery.service': 'enabled',
      'nexus-release-promotion-recovery.service': 'enabled',
    });
    const env = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: legacyRoot,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: systemctl,
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_RELEASE_MUTEX: path.join(fixture, 'release-sonar.lock'),
      NEXUS_LAYOUT_CONTROL_LOCK: path.join(stateRoot, '.control.lock'),
      NEXUS_LAYOUT_INSTALLER_TARGET: targets.installer,
      NEXUS_LAYOUT_CONTROL_TARGET: targets.control,
      NEXUS_LAYOUT_MIGRATE_TARGET: targets.migrate,
      NEXUS_LAYOUT_SQLITE_TARGET: targets.sqlite,
      NEXUS_LAYOUT_AUTH_TARGET: targets.auth,
      NEXUS_LAYOUT_DRILL_VERIFY_TARGET: targets.drill,
      NEXUS_LAYOUT_ATTESTOR_TARGET: targets.attestor,
      NEXUS_LAYOUT_SELECTOR_TARGET: targets.selector,
      NEXUS_LAYOUT_PREFLIGHT_TARGET: targets.preflight,
      NEXUS_LAYOUT_PROMOTION_CONTROL_TARGET: targets.promotion,
      NEXUS_LAYOUT_FILESYSTEM_IDENTITY_TARGET: targets.filesystemIdentity,
      NEXUS_LAYOUT_STAGING_BROKER_TARGET: targets.stagingBroker,
      NEXUS_LAYOUT_PM2_CAPTURE_AUTHORITY_TARGET: targets.pm2CaptureAuthority,
      NEXUS_LAYOUT_PM2_DUMP_AUTHORITY_TARGET: targets.pm2DumpAuthority,
      NEXUS_LAYOUT_BOOT_HEALTH_TARGET: targets.bootHealth,
      NEXUS_LAYOUT_OLLAMA_INSTALL_STATE_TARGET: targets.ollamaInstallState,
      NEXUS_LAYOUT_OLLAMA_INSTALL_GUARD_TARGET: targets.ollamaInstallGuard,
      NEXUS_LAYOUT_PM2_RECOVERY_UNIT_TARGET: targets.pm2RecoveryUnit,
      NEXUS_LAYOUT_PROMOTION_RECOVERY_UNIT_TARGET:
        targets.promotionRecoveryUnit,
      NEXUS_LAYOUT_ACTIVATION_UNIT_TARGET: targets.activationUnit,
      NEXUS_LAYOUT_RECOVERY_UNIT_TARGET: targets.layoutRecovery,
      NEXUS_LAYOUT_INSTALL_RECOVERY_UNIT_TARGET: targets.installRecovery,
      NEXUS_LAYOUT_INSTALL_GUARD_TARGET: targets.guard,
      NEXUS_LAYOUT_SUDOERS_TARGET: targets.sudoers,
      NEXUS_LEGACY_DRILL_PM2_DOMINGUEZ_DROPIN: targets.legacyDominguez,
      NEXUS_LEGACY_DRILL_PM2_ROOT_DROPIN: targets.legacyRoot,
    };
    const journal = path.join(
      activationRoot,
      'phase-a-install-in-progress.v1.json',
    );
    const daemonFailure = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], { ...env, NEXUS_TEST_SYSTEMCTL_FAIL: 'daemon-reload' });
    expect(daemonFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);

    const unitFailure = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], {
      ...env,
      NEXUS_TEST_SYSTEMCTL_FAIL:
        'disable:nexus-release-layout-install-recovery.service',
    });
    expect(unitFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);

    const rollbackReceipt = path.join(
      activationRoot,
      'phase-a-rollback-receipt.v1.json',
    );
    fs.mkdirSync(rollbackReceipt, { mode: 0o700 });
    const receiptFailure = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], env);
    expect(receiptFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);
    fs.rmdirSync(rollbackReceipt);

    const fsyncFailure = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], {
      ...env,
      NEXUS_LAYOUT_TEST_FAIL_FSYNC_PATH: activationRoot,
    });
    expect(fsyncFailure.status).not.toBe(0);
    expect(fs.existsSync(journal)).toBe(true);

    const recovered = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], env);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.readFileSync(path.join(
      unitStates,
      'nexus-release-layout-install-recovery.service',
    ), 'utf8')).toBe('disabled\n');
    expect(fs.readFileSync(path.join(
      unitStates,
      'nexus-release-promotion-recovery.service',
    ), 'utf8')).toBe('disabled\n');
    expect(fs.existsSync(path.join(
      unitStates,
      'nexus-release-promotion-recovery.service',
    ))).toBe(true);
    expect(fs.readFileSync(targets.control)).toEqual(originalControl);
    expect(fs.existsSync(targets.ollamaInstallState)).toBe(false);
    expect(fs.existsSync(targets.ollamaInstallGuard)).toBe(false);
    expect(fs.existsSync(path.dirname(targets.ollamaInstallGuard))).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
    for (const anchor of [targets.guard, targets.installer, targets.installRecovery]) {
      expect(fs.existsSync(anchor)).toBe(true);
    }
    const bootSafe = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'assert-phase-a-safe',
    ], env);
    expect(bootSafe.status, bootSafe.stderr).toBe(0);

    const predecessorInstaller = Buffer.from('predecessor-activation-install\n');
    const predecessorReceipt = Buffer.from('{"status":"completed-predecessor"}\n');
    fs.writeFileSync(phaseAReceipt, predecessorReceipt, { mode: 0o600 });
    const predecessorOrdered = ordered.filter((file) => ![
      targets.ollamaInstallState,
      targets.ollamaInstallGuard,
      phaseAPredecessorReceipt,
    ].includes(file));
    const upgradeRecords = predecessorOrdered.map((file) => {
      if (file === targets.installer) {
        const identity = fs.statSync(file);
        return {
          path: file,
          parentPresent: true,
          present: true,
          uid: identity.uid,
          gid: identity.gid,
          mode: identity.mode & 0o7777,
          sha256: digest(predecessorInstaller),
          bodyBase64: predecessorInstaller.toString('base64'),
        };
      }
      if ([targets.guard, targets.installRecovery, phaseAReceipt].includes(file)) {
        const body = fs.readFileSync(file);
        const identity = fs.statSync(file);
        return {
          path: file,
          parentPresent: true,
          present: true,
          uid: identity.uid,
          gid: identity.gid,
          mode: identity.mode & 0o7777,
          sha256: digest(body),
          bodyBase64: body.toString('base64'),
        };
      }
      return { path: file, parentPresent: true, present: false };
    });
    writeJson(journal, {
      schema: 'nexus.release-layout-phase-a-journal.v1',
      status: 'in_progress',
      checkpoint: 'upgrade_recovery_anchor_installed',
      sourceSha: '3'.repeat(40),
      sourceArchiveSha256: '4'.repeat(64),
      installMode: 'upgrade',
      predecessorReceiptSha256: digest(predecessorReceipt),
      unitStates: {
        'nexus-release-layout-install-recovery.service': 'disabled',
        'nexus-release-promotion-recovery.service': 'not-found',
        'nexus-rollback-drill-legacy-staging-install-recovery.service':
          'not-found',
        'nexus-rollback-drill-legacy-staging-recovery.service': 'not-found',
      },
      legacyRetirement: null,
      targets: upgradeRecords,
      createdAt: new Date().toISOString(),
    });
    const recoveredUpgrade = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], env);
    expect(recoveredUpgrade.status, recoveredUpgrade.stderr).toBe(0);
    expect(fs.readFileSync(targets.installer)).toEqual(predecessorInstaller);
    expect(fs.readFileSync(phaseAReceipt)).toEqual(predecessorReceipt);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('recovers every legacy adapter byte after a crash following receipt retirement', () => {
    const fixture = makeRoot();
    const stateRoot = path.join(fixture, 'state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const legacyRoot = path.join(fixture, 'legacy');
    const legacyTargetRoot = path.join(fixture, 'legacy-targets');
    const fixedRoot = path.join(fixture, 'fixed-targets');
    const fixed = (name: string) => path.join(fixedRoot, name);
    const fixedTargets = {
      guard: fixed('pm2-guard.conf'),
      installer: fixed('activation-install'),
      control: fixed('activation-control'),
      migrate: fixed('layout-migrate'),
      sqlite: fixed('layout-sqlite.py'),
      auth: fixed('layout-authorization.mjs'),
      drill: fixed('layout-fault-drill.mjs'),
      attestor: fixed('runtime-attestor.mjs'),
      selector: fixed('selector.py'),
      preflight: fixed('layout-preflight.sh'),
      promotion: fixed('promotion-control'),
      filesystemIdentity: fixed('filesystem-identity.mjs'),
      stagingBroker: fixed('staging-broker.sh'),
      pm2CaptureAuthority: fixed('capture-pm2-dump-authority.mjs'),
      pm2DumpAuthority: fixed('pm2-dump-authority.py'),
      bootHealth: fixed('release-boot-health'),
      ollamaInstallState: fixed('ollama-install-state-check.mjs'),
      ollamaInstallGuard: fixed('ollama-install-guard.conf'),
      pm2RecoveryUnit: fixed('pm2-recovery-daemon.service'),
      promotionRecoveryUnit: fixed('promotion-recovery.service'),
      activationUnit: fixed('activation@.service'),
      layoutRecovery: fixed('layout-recovery.service'),
      installRecovery: fixed('install-recovery.service'),
      sudoers: fixed('sudoers'),
    };
    const legacyRelative = [
      'usr/local/sbin/nexus-rollback-drill-legacy-staging-install',
      'etc/systemd/system/nexus-rollback-drill-legacy-staging-install-recovery.service',
      'usr/local/sbin/nexus-rollback-drill-legacy-staging-broker',
      'usr/local/libexec/nexus-rollback-drill-legacy-staging-adapter.mjs',
      'usr/local/libexec/nexus-release-runtime-dependencies.mjs',
      'usr/local/libexec/nexus-release-installed-tree-attestation.mjs',
      'usr/local/libexec/nexus-release-recovery-runtime-identity.mjs',
      'etc/nexus-release/release-evidence-public-key.pem',
      'etc/systemd/system/nexus-rollback-drill-legacy-staging@.service',
      'etc/systemd/system/nexus-rollback-drill-legacy-staging-recovery.service',
      'etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf',
      'etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf',
      'etc/sudoers.d/nexus-rollback-drill-legacy-staging',
      'usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py',
    ];
    const legacyTargets = legacyRelative.map((relative) => (
      path.join(legacyTargetRoot, relative)
    ));
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(activationRoot, 'transactions'), { mode: 0o700 });
    fs.mkdirSync(legacyRoot, { mode: 0o700 });
    fs.mkdirSync(fixedRoot, { mode: 0o700 });
    for (const anchor of [
      fixedTargets.guard,
      fixedTargets.installer,
      fixedTargets.installRecovery,
    ]) {
      fs.writeFileSync(anchor, `recovery-anchor-${path.basename(anchor)}\n`, {
        mode: 0o755,
      });
    }
    const originalControl = Buffer.from('promotion-control-v2\n');
    fs.writeFileSync(fixedTargets.control, 'promotion-control-v3\n', { mode: 0o755 });
    const controlIdentity = fs.statSync(fixedTargets.control);
    const legacyReceipt = path.join(legacyRoot, 'install-receipt.v1.json');
    const legacyRetired = path.join(legacyRoot, 'install-receipt.retired.v1.json');
    const originalReceipt = Buffer.from('{"active":"legacy-v2"}\n');
    fs.writeFileSync(legacyReceipt, originalReceipt, { mode: 0o600 });
    const receiptIdentity = fs.statSync(legacyReceipt);
    fs.unlinkSync(legacyReceipt);
    fs.writeFileSync(legacyRetired, '{"status":"retired"}\n', { mode: 0o600 });
    const retainedSqlite = path.join(
      legacyTargetRoot,
      'usr/local/libexec/nexus-application-dr/application-dr-sqlite.py',
    );
    fs.mkdirSync(path.dirname(retainedSqlite), { recursive: true, mode: 0o755 });
    const retainedBody = Buffer.from('application-dr-helper-unchanged\n');
    fs.writeFileSync(retainedSqlite, retainedBody, { mode: 0o644 });
    const retainedIdentity = fs.statSync(retainedSqlite);
    const legacyOriginal = new Map<string, Buffer>();
    const planTargets = legacyTargets.map((targetPath, index) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
      const body = Buffer.from(`active-adapter-${index}\n`);
      const mode = index === 12
        ? 0o440
        : index === 0 || (index >= 2 && index <= 6) || index === 13
          ? 0o700
          : 0o644;
      fs.writeFileSync(targetPath, body, { mode });
      const identity = fs.statSync(targetPath);
      legacyOriginal.set(targetPath, body);
      const predecessor = index % 2 === 0
        ? { action: 'remove' }
        : {
          action: 'restore',
          sourcePath: path.join(legacyRoot, 'install', 'predecessor', `${index}.file`),
          sha256: digest(`predecessor-${index}\n`),
          mode,
          uid: identity.uid,
          gid: identity.gid,
        };
      if (predecessor.action === 'remove') {
        fs.unlinkSync(targetPath);
      } else {
        fs.writeFileSync(targetPath, `predecessor-${index}\n`, { mode });
      }
      return {
        path: targetPath,
        active: {
          sha256: digest(body),
          mode,
          uid: identity.uid,
          gid: identity.gid,
        },
        predecessor,
      };
    });
    const plan = {
      schema: 'nexus.rollback-drill-legacy-staging-phase-a-retirement-plan.v1',
      status: 'ready',
      promotionAllowed: false,
      receipt: { path: legacyReceipt, sha256: digest(originalReceipt) },
      source: { sourceSha: '1'.repeat(40), archiveSha256: '2'.repeat(64) },
      control: {
        version: 'nexus-release-promotion-control.v2',
        sha256: digest(originalControl),
      },
      recoveryUnit: {
        name: 'nexus-rollback-drill-legacy-staging-recovery.service',
        enabledState: 'enabled-runtime',
      },
      installRecoveryUnit: {
        name: 'nexus-rollback-drill-legacy-staging-install-recovery.service',
        enabledState: 'enabled',
      },
      retainedDependencies: [{
        path: retainedSqlite,
        sha256: digest(retainedBody),
        mode: 0o644,
        uid: retainedIdentity.uid,
        gid: retainedIdentity.gid,
      }],
      terminal: { count: 0, aggregateSha256: digest('[]') },
      targets: planTargets,
    };
    const phaseAReceipt = path.join(activationRoot, 'phase-a-receipt.v1.json');
    const phaseAPredecessorReceipt = path.join(
      activationRoot,
      'phase-a-predecessor-receipt.v1.json',
    );
    const fixedOrdered = [
      fixedTargets.guard,
      fixedTargets.installer,
      fixedTargets.control,
      fixedTargets.migrate,
      fixedTargets.sqlite,
      fixedTargets.auth,
      fixedTargets.drill,
      fixedTargets.attestor,
      fixedTargets.selector,
      fixedTargets.preflight,
      fixedTargets.promotion,
      fixedTargets.filesystemIdentity,
      fixedTargets.stagingBroker,
      fixedTargets.pm2CaptureAuthority,
      fixedTargets.pm2DumpAuthority,
      fixedTargets.bootHealth,
      fixedTargets.ollamaInstallState,
      fixedTargets.ollamaInstallGuard,
      fixedTargets.pm2RecoveryUnit,
      fixedTargets.promotionRecoveryUnit,
      fixedTargets.activationUnit,
      fixedTargets.layoutRecovery,
      fixedTargets.installRecovery,
      fixedTargets.sudoers,
      phaseAPredecessorReceipt,
      phaseAReceipt,
      legacyReceipt,
      legacyRetired,
    ];
    const absentRecord = (file: string) => ({
      path: file,
      parentPresent: true,
      present: false,
    });
    const fixedRecords = fixedOrdered.map((file) => {
      if (file === fixedTargets.control) {
        return {
          path: file,
          parentPresent: true,
          present: true,
          uid: controlIdentity.uid,
          gid: controlIdentity.gid,
          mode: 0o755,
          sha256: digest(originalControl),
          bodyBase64: originalControl.toString('base64'),
        };
      }
      if (file === legacyReceipt) {
        return {
          path: file,
          parentPresent: true,
          present: true,
          uid: receiptIdentity.uid,
          gid: receiptIdentity.gid,
          mode: 0o600,
          sha256: digest(originalReceipt),
          bodyBase64: originalReceipt.toString('base64'),
        };
      }
      return absentRecord(file);
    });
    const dynamicRecords = planTargets.map((item) => {
      const body = legacyOriginal.get(item.path)!;
      return {
        path: item.path,
        parentPresent: true,
        present: true,
        uid: item.active.uid,
        gid: item.active.gid,
        mode: item.active.mode,
        sha256: item.active.sha256,
        bodyBase64: body.toString('base64'),
      };
    });
    writeJson(path.join(activationRoot, 'phase-a-install-in-progress.v1.json'), {
      schema: 'nexus.release-layout-phase-a-journal.v1',
      status: 'in_progress',
      checkpoint: 'legacy_v2_adapter_receipt_retired',
      sourceSha: '3'.repeat(40),
      sourceArchiveSha256: '4'.repeat(64),
      unitStates: {
        'nexus-release-layout-install-recovery.service': 'disabled',
        'nexus-release-promotion-recovery.service': 'not-found',
        'nexus-rollback-drill-legacy-staging-install-recovery.service':
          'enabled',
        'nexus-rollback-drill-legacy-staging-recovery.service':
          'enabled-runtime',
      },
      legacyRetirement: {
        planSha256: digest(`${canonicalJson(plan)}\n`),
        plan,
      },
      targets: [...fixedRecords, ...dynamicRecords],
      createdAt: new Date().toISOString(),
    });
    const systemctl = path.join(fixture, 'systemctl');
    const unitStates = path.join(fixture, 'unit-states');
    writeStatefulSystemctl(systemctl, unitStates, {
      'nexus-release-layout-install-recovery.service': 'enabled',
    });
    const env = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: legacyRoot,
      NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: legacyTargetRoot,
      NEXUS_LEGACY_DRILL_PM2_DOMINGUEZ_DROPIN: legacyTargets[10],
      NEXUS_LEGACY_DRILL_PM2_ROOT_DROPIN: legacyTargets[11],
      NEXUS_LAYOUT_SYSTEMCTL_BIN: systemctl,
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_RELEASE_MUTEX: path.join(fixture, 'release-sonar.lock'),
      NEXUS_LAYOUT_CONTROL_LOCK: path.join(stateRoot, '.control.lock'),
      NEXUS_LAYOUT_INSTALLER_TARGET: fixedTargets.installer,
      NEXUS_LAYOUT_CONTROL_TARGET: fixedTargets.control,
      NEXUS_LAYOUT_MIGRATE_TARGET: fixedTargets.migrate,
      NEXUS_LAYOUT_SQLITE_TARGET: fixedTargets.sqlite,
      NEXUS_LAYOUT_AUTH_TARGET: fixedTargets.auth,
      NEXUS_LAYOUT_DRILL_VERIFY_TARGET: fixedTargets.drill,
      NEXUS_LAYOUT_ATTESTOR_TARGET: fixedTargets.attestor,
      NEXUS_LAYOUT_SELECTOR_TARGET: fixedTargets.selector,
      NEXUS_LAYOUT_PREFLIGHT_TARGET: fixedTargets.preflight,
      NEXUS_LAYOUT_PROMOTION_CONTROL_TARGET: fixedTargets.promotion,
      NEXUS_LAYOUT_FILESYSTEM_IDENTITY_TARGET:
        fixedTargets.filesystemIdentity,
      NEXUS_LAYOUT_STAGING_BROKER_TARGET: fixedTargets.stagingBroker,
      NEXUS_LAYOUT_PM2_CAPTURE_AUTHORITY_TARGET:
        fixedTargets.pm2CaptureAuthority,
      NEXUS_LAYOUT_PM2_DUMP_AUTHORITY_TARGET:
        fixedTargets.pm2DumpAuthority,
      NEXUS_LAYOUT_BOOT_HEALTH_TARGET: fixedTargets.bootHealth,
      NEXUS_LAYOUT_OLLAMA_INSTALL_STATE_TARGET:
        fixedTargets.ollamaInstallState,
      NEXUS_LAYOUT_OLLAMA_INSTALL_GUARD_TARGET:
        fixedTargets.ollamaInstallGuard,
      NEXUS_LAYOUT_PM2_RECOVERY_UNIT_TARGET: fixedTargets.pm2RecoveryUnit,
      NEXUS_LAYOUT_PROMOTION_RECOVERY_UNIT_TARGET:
        fixedTargets.promotionRecoveryUnit,
      NEXUS_LAYOUT_ACTIVATION_UNIT_TARGET: fixedTargets.activationUnit,
      NEXUS_LAYOUT_RECOVERY_UNIT_TARGET: fixedTargets.layoutRecovery,
      NEXUS_LAYOUT_INSTALL_RECOVERY_UNIT_TARGET: fixedTargets.installRecovery,
      NEXUS_LAYOUT_INSTALL_GUARD_TARGET: fixedTargets.guard,
      NEXUS_LAYOUT_SUDOERS_TARGET: fixedTargets.sudoers,
    };
    fs.writeFileSync(retainedSqlite, 'tampered-retained-helper\n', { mode: 0o644 });
    const blocked = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], env);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('retained dependency changed during Phase A');
    expect(fs.existsSync(path.join(
      activationRoot,
      'phase-a-install-in-progress.v1.json',
    ))).toBe(true);
    fs.writeFileSync(retainedSqlite, retainedBody, { mode: 0o644 });
    const recovered = run('/usr/bin/env', [
      'bash',
      activationInstaller,
      'recover-phase-a',
    ], env);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.readFileSync(fixedTargets.control)).toEqual(originalControl);
    expect(fs.readFileSync(legacyReceipt)).toEqual(originalReceipt);
    expect(fs.existsSync(legacyRetired)).toBe(false);
    for (const [targetPath, body] of legacyOriginal) {
      expect(fs.readFileSync(targetPath)).toEqual(body);
    }
    expect(fs.readFileSync(retainedSqlite)).toEqual(retainedBody);
    expect(fs.statSync(retainedSqlite).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(
      unitStates,
      'nexus-rollback-drill-legacy-staging-recovery.service',
    ), 'utf8')).toBe('enabled-runtime\n');
    expect(fs.existsSync(path.join(
      activationRoot,
      'phase-a-install-in-progress.v1.json',
    ))).toBe(false);
  });

  it('takes and restores a private SQLite recovery point without leaking paths', () => {
    const fixture = makeRoot();
    const database = path.join(fixture, 'bot.db');
    const recoveryRoot = path.join(fixture, 'recovery');
    const recovery = path.join(recoveryRoot, 'bot.sqlite');
    const stoppedCopy = path.join(recoveryRoot, 'stopped-boundary.sqlite');
    fs.mkdirSync(recoveryRoot, { mode: 0o700 });
    const create = run(process.env.PYTHON ?? 'python3', ['-c', `
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA foreign_keys=ON")
db.execute("CREATE TABLE parent(id INTEGER PRIMARY KEY)")
db.execute("CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id))")
db.execute("INSERT INTO parent VALUES(1)")
db.execute("INSERT INTO child VALUES(1,1)")
db.commit()
db.close()
`, database]);
    expect(create.status, create.stderr).toBe(0);

    const snapshot = run(process.env.PYTHON ?? 'python3', [
      sqliteHelper,
      'snapshot',
      database,
      recovery,
    ]);
    expect(snapshot.status, snapshot.stderr).toBe(0);
    const snapshotEvidence = JSON.parse(snapshot.stdout);
    expect(snapshotEvidence.schema).toBe('nexus.release-layout-sqlite-recovery-point.v1');
    expect(snapshotEvidence.integrityCheck).toBe('ok');
    expect(snapshot.stdout).not.toContain(fixture);
    expect(fs.statSync(recovery).mode & 0o777).toBe(0o600);

    const boundary = run(process.env.PYTHON ?? 'python3', [
      sqliteHelper,
      'stopped-boundary',
      database,
    ]);
    expect(boundary.status, boundary.stderr).toBe(0);
    const boundaryEvidence = JSON.parse(boundary.stdout);
    expect(boundaryEvidence.walCheckpoint).toBe('truncate');
    const copied = run(process.env.PYTHON ?? 'python3', [
      sqliteHelper,
      'copy-stopped-boundary',
      database,
      stoppedCopy,
      '--sha256',
      boundaryEvidence.sha256,
      '--size',
      String(boundaryEvidence.sizeBytes),
    ]);
    expect(copied.status, copied.stderr).toBe(0);
    const copyEvidence = JSON.parse(copied.stdout);
    expect(copyEvidence.schema).toBe('nexus.release-layout-sqlite-stopped-copy.v1');
    expect(copyEvidence.sha256).toBe(boundaryEvidence.sha256);
    expect(fs.readFileSync(stoppedCopy)).toEqual(fs.readFileSync(database));
    expect(fs.statSync(stoppedCopy).mode & 0o777).toBe(0o600);
    fs.writeFileSync(database, 'corrupt-live-database', { mode: 0o600 });
    for (const suffix of ['-wal', '-shm', '-journal']) {
      fs.writeFileSync(`${database}${suffix}`, `stale${suffix}\n`, { mode: 0o600 });
    }
    const restore = run(process.env.PYTHON ?? 'python3', [
      sqliteHelper,
      'restore',
      stoppedCopy,
      database,
      '--sha256',
      boundaryEvidence.sha256,
      '--size',
      String(boundaryEvidence.sizeBytes),
      '--uid',
      String(process.getuid?.() ?? 0),
      '--gid',
      String(process.getgid?.() ?? 0),
    ]);
    expect(restore.status, restore.stderr).toBe(0);
    expect(JSON.parse(restore.stdout).integrityCheck).toBe('ok');
    expect(restore.stdout).not.toContain(fixture);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      expect(fs.existsSync(`${database}${suffix}`)).toBe(false);
    }
    const count = run(process.env.PYTHON ?? 'python3', ['-c', `
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
print(db.execute("SELECT COUNT(*) FROM child").fetchone()[0])
`, database]);
    expect(count.status, count.stderr).toBe(0);
    expect(count.stdout.trim()).toBe('1');
    // Reopening a WAL-mode database can recreate SQLite sidecars even after
    // the preceding restore correctly removed the stale set. Closeout has
    // completed here, so reset those fresh test-only files before constructing
    // the deliberately unsafe symlink scenario below.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      fs.rmSync(`${database}${suffix}`, { force: true });
    }

    const sentinel = path.join(fixture, 'sentinel');
    fs.writeFileSync(sentinel, 'do-not-touch\n', { mode: 0o600 });
    fs.writeFileSync(`${database}-wal`, 'retain-until-validation-completes\n', {
      mode: 0o600,
    });
    fs.symlinkSync(sentinel, `${database}-shm`);
    const unsafeSidecar = run(process.env.PYTHON ?? 'python3', [
      sqliteHelper,
      'restore',
      stoppedCopy,
      database,
      '--sha256',
      boundaryEvidence.sha256,
      '--size',
      String(boundaryEvidence.sizeBytes),
      '--uid',
      String(process.getuid?.() ?? 0),
      '--gid',
      String(process.getgid?.() ?? 0),
    ]);
    expect(unsafeSidecar.status).not.toBe(0);
    expect(unsafeSidecar.stderr).toContain(
      'restore destination SQLite sidecar is unsafe',
    );
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do-not-touch\n');
    expect(fs.readFileSync(`${database}-wal`, 'utf8')).toBe(
      'retain-until-validation-completes\n',
    );
  });

  it('retains the adapter-pinned application DR helper byte-for-byte', () => {
    expect(digest(fs.readFileSync(legacySqliteHelper))).toBe(
      'e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d',
    );
    expect(fs.readFileSync(layoutMigrate, 'utf8')).toContain(
      '/usr/local/libexec/nexus-release-layout-sqlite.py',
    );
  });
});

describe('layout-specific KVM evidence is cryptographically fail-closed', () => {
  it('admits only the exact nonce-bound hypervisor and guest proof chain', () => {
    const fixture = makeRoot();
    const sourcePath = path.join(fixture, 'source.json');
    const planPath = path.join(fixture, 'plan.json');
    const migrationId = '12345678-1234-4123-8123-123456789abc';
    const scenarios = [
      'failed_health_check',
      'host_reboot_during_migration',
      'ssh_disconnect_after_pm2_stop',
    ] as const;
    const source = {
      production: {
        base: '/home/dominguez/telegram-hub-bot',
        runtimeSha: '1'.repeat(40),
        artifactDigest: '2'.repeat(64),
        installedRuntimeDigest: '3'.repeat(64),
      },
      staging: {
        base: '/home/dominguez/telegram-hub-bot-staging',
        runtimeSha: '4'.repeat(40),
        artifactDigest: '5'.repeat(64),
        installedRuntimeDigest: '6'.repeat(64),
      },
    };
    writeJson(sourcePath, source);
    const hypervisor = generateKeyPairSync('ed25519');
    const guests = Object.fromEntries(scenarios.map((scenario) => (
      [scenario, generateKeyPairSync('ed25519')]
    ))) as Record<(typeof scenarios)[number], ReturnType<typeof generateKeyPairSync>>;
    const publicPem = (
      key: ReturnType<typeof generateKeyPairSync>['publicKey'],
    ) => key.export({ format: 'pem', type: 'spki' }).toString();
    const provisionReceipt = path.join(fixture, 'provision-receipt.json');
    const provisionSetId = 'e'.repeat(64);
    const receiptHostKeyDigests = [
      '3'.repeat(64),
      '1'.repeat(64),
      '2'.repeat(64),
    ];
    const hypervisorProducer = {
      controllerPath:
        '/usr/local/libexec/nexus-rollback-drill-vm/'
        + 'release-layout-fault-controller',
      controllerSha256: '7'.repeat(64),
      controllerRecoveryUnitPath:
        '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service',
      controllerRecoveryUnitSha256: '6'.repeat(64),
      controllerUnitPath:
        '/etc/systemd/system/nexus-release-layout-fault-drill@.service',
      controllerUnitSha256: '8'.repeat(64),
      verifierPath:
        '/usr/local/libexec/nexus-rollback-drill-vm/'
        + 'release-layout-fault-drill.mjs',
      verifierSha256: '9'.repeat(64),
    };
    const guestProducer = {
      executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
      executorSha256: 'a'.repeat(64),
      recoveryUnitPath:
        '/etc/systemd/system/'
        + 'nexus-release-layout-fault-guest-recovery.service',
      recoveryUnitSha256: 'b'.repeat(64),
    };
    const provisionBody = writeJson(provisionReceipt, {
      schema: 'nexus.rollback-drill-vm-provision.v2',
      setId: provisionSetId,
      image: {
        filename: 'noble-server-cloudimg-amd64.img',
        sha256: 'a'.repeat(64),
      },
      sshPublicKeySha256: 'b'.repeat(64),
      guestSshHostPublicKeySha256s: receiptHostKeyDigests,
      ports: [2221, 2222, 2223],
      setDirectory: `/var/lib/nexus-rollback-drill-vm/sets/${provisionSetId}`,
      runtimeReadiness: {
        status: 'ready',
        drillReady: true,
      },
      hypervisor: {
        qemuSha256: 'f'.repeat(64),
        runnerSha256: '0'.repeat(64),
        faultDrillControllerSha256: hypervisorProducer.controllerSha256,
        faultDrillControllerUnitSha256:
          hypervisorProducer.controllerUnitSha256,
        faultDrillControllerRecoveryUnitSha256:
          hypervisorProducer.controllerRecoveryUnitSha256,
        faultDrillVerifierSha256: hypervisorProducer.verifierSha256,
        faultDrillGuestExecutorSha256: guestProducer.executorSha256,
        faultDrillGuestRecoveryUnitSha256:
          guestProducer.recoveryUnitSha256,
      },
      guests: receiptHostKeyDigests.map((hostPublicKeySha256, index) => ({
        name: `guest-${index + 1}`,
        hostPublicKeySha256,
      })),
      createdAt: new Date().toISOString(),
    });
    fs.chmodSync(provisionReceipt, 0o640);
    const guestIds = {
      failed_health_check: 'guest-2',
      host_reboot_during_migration: 'guest-3',
      ssh_disconnect_after_pm2_stop: 'guest-1',
    } as const;
    const trustManifest = path.join(fixture, 'layout-kvm-trust.json');
    writeJson(trustManifest, {
      schema: 'nexus.release-layout-kvm-trust.v1',
      provision: {
        schema: 'nexus.rollback-drill-vm-provision.v2',
        setId: provisionSetId,
        receiptSha256: digest(provisionBody),
      },
      hypervisor: {
        publicKeyPem: publicPem(hypervisor.publicKey),
        publicKeySha256: digest(publicPem(hypervisor.publicKey)),
        qemuSha256: 'f'.repeat(64),
        runnerSha256: '0'.repeat(64),
        ...hypervisorProducer,
      },
      guests: Object.fromEntries(scenarios.map((scenario) => [
        scenario,
        {
          guestId: guestIds[scenario],
          publicKeyPem: publicPem(guests[scenario].publicKey),
          publicKeySha256: digest(publicPem(guests[scenario].publicKey)),
          sshHostPublicKeySha256: String(scenarios.indexOf(scenario) + 1)
            .repeat(64),
          ...guestProducer,
        },
      ])),
      createdAt: new Date().toISOString(),
    });
    const prepareArgs = [
      drillTool,
      'prepare',
      '--migration-id',
      migrationId,
      '--source',
      sourcePath,
      '--trust-manifest',
      trustManifest,
    ];
    prepareArgs.push('--output', planPath);
    const prepared = run(process.execPath, prepareArgs);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({
      status: 'ready_for_kvm_execution',
      activationEligible: false,
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const planDigest = digest(canonicalJson(plan));
    const completedAt = new Date(
      Math.max(Date.now(), Date.parse(plan.createdAt) + 1),
    ).toISOString();
    const resultPaths = new Map<string, string>();
    scenarios.forEach((scenario, index) => {
      const isolationPath = path.join(fixture, `${scenario}-isolation.json`);
      const executionPath = path.join(fixture, `${scenario}-execution.json`);
      const isolationSignaturePath = path.join(
        fixture,
        `${scenario}-isolation.sig`,
      );
      const executionSignaturePath = path.join(
        fixture,
        `${scenario}-execution.sig`,
      );
      const digit = String(index + 1);
      const beforeBoot = `${digit.repeat(8)}-${digit.repeat(4)}-`
        + `${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
      const afterBoot = scenario === 'host_reboot_during_migration'
        ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        : beforeBoot;
      const durationMilliseconds = 1000 + index;
      const observer = {
        bootId: '11111111-2222-3333-4444-555555555555',
        startMonotonicMilliseconds: 10000,
        endMonotonicMilliseconds: 10000 + durationMilliseconds,
        durationMilliseconds,
        targetMilliseconds: 120000,
      };
      const guest = {
        bootIdBefore: beforeBoot,
        bootIdAfter: afterBoot,
      };
      const executionBody = writeJson(executionPath, {
        schema: 'nexus.release-layout-guest-execution-evidence.v1',
        planId: plan.planId,
        planSha256: planDigest,
        challengeNonce: plan.challengeNonce,
        migrationId,
        scenarioId: scenario,
        controlVersion: 'nexus-release-layout-fault-guest.v1',
        executionMode: 'strictly-sequential',
        testMode: false,
        productionEvidenceEmitted: false,
        promotionControlInvoked: false,
        faultInjected: scenario,
        terminalStatus: 'recovered',
        exactPredecessorRestored: true,
        databaseRecoveryVerified: true,
        healthRestored: true,
        connectionDropped: scenario !== 'failed_health_check',
        observer,
        guest,
        producer: plan.trust.producers.guests[scenario],
        faultObservation: {
          journalSha256: digit.repeat(64),
          predecessorSha256: 'c'.repeat(64),
          restoredSha256: 'c'.repeat(64),
          databaseBeforeSha256: 'd'.repeat(64),
          databaseAfterSha256: 'd'.repeat(64),
          candidateHealthFailureObserved: scenario === 'failed_health_check',
          processStoppedObserved: true,
          durableRecoveryArmed: true,
        },
        completedAt,
      });
      const isolationBody = writeJson(isolationPath, {
        schema: 'nexus.release-layout-hypervisor-isolation-evidence.v1',
        planId: plan.planId,
        planSha256: planDigest,
        challengeNonce: plan.challengeNonce,
        scenarioId: scenario,
        guestId: guestIds[scenario],
        hypervisor: 'qemu-kvm',
        kvmAcceleration: true,
        independentOverlay: true,
        loopbackSshOnly: true,
        productionDataMounted: false,
        productionSecretsPresent: false,
        productionNetworkReachable: false,
        executionEvidenceSha256: digest(executionBody),
        observer,
        guest,
        producer: plan.trust.producers.hypervisor,
        faultObservation: {
          systemdUnit:
            `nexus-rollback-drill-vm@${guestIds[scenario]}.service`,
          qemuMainPid: 1000 + index,
          qemuCommandLineSha256: digit.repeat(64),
          guestSshHostPublicKeySha256: digit.repeat(64),
          sshDisconnectObserved:
            scenario === 'ssh_disconnect_after_pm2_stop',
          guestRebootObserved:
            scenario === 'host_reboot_during_migration',
        },
        createdAt: completedAt,
      });
      const isolationSignature = cryptoSign(
        null,
        isolationBody,
        hypervisor.privateKey,
      );
      const executionSignature = cryptoSign(
        null,
        executionBody,
        guests[scenario].privateKey,
      );
      fs.writeFileSync(isolationSignaturePath, isolationSignature, {
        mode: 0o600,
      });
      fs.writeFileSync(executionSignaturePath, executionSignature, {
        mode: 0o600,
      });
      const resultPath = path.join(fixture, `${scenario}-result.json`);
      writeJson(resultPath, {
        schema: 'nexus.release-layout-fault-scenario-result.v2',
        producerVersion: 'nexus-release-layout-fault-drill.v1',
        planId: plan.planId,
        planSha256: planDigest,
        migrationId,
        scenarioId: scenario,
        status: 'passed',
        sourceSha256: digest(canonicalJson(source)),
        proof: {
          schema: 'nexus.release-layout-kvm-proof.v1',
          challengeNonce: plan.challengeNonce,
          hypervisorPublicKeySha256:
            digest(publicPem(hypervisor.publicKey)),
          guestPublicKeySha256:
            digest(publicPem(guests[scenario].publicKey)),
          isolationEvidenceBase64: isolationBody.toString('base64'),
          isolationSignatureBase64: isolationSignature.toString('base64'),
          executionEvidenceBase64: executionBody.toString('base64'),
          executionSignatureBase64: executionSignature.toString('base64'),
        },
        isolation: {
          hypervisor: 'qemu-kvm',
          kvmAcceleration: true,
          independentOverlay: true,
          loopbackSshOnly: true,
          guestId: guestIds[scenario],
        },
        recovery: {
          observerBootId: observer.bootId,
          durationMilliseconds,
          targetMilliseconds: 120000,
          terminalStatus: 'recovered',
          guestBootIdBefore: beforeBoot,
          guestBootIdAfter: afterBoot,
          exactPredecessorRestored: true,
          databaseRecoveryVerified: true,
          healthRestored: true,
          connectionDropped: scenario !== 'failed_health_check',
        },
        producerTrust: {
          controllerSha256: hypervisorProducer.controllerSha256,
          controllerRecoveryUnitSha256:
            hypervisorProducer.controllerRecoveryUnitSha256,
          controllerUnitSha256: hypervisorProducer.controllerUnitSha256,
          guestExecutorSha256: guestProducer.executorSha256,
          guestRecoveryUnitSha256: guestProducer.recoveryUnitSha256,
        },
        isolationEvidenceSha256: digest(isolationBody),
        executionEvidenceSha256: digest(executionBody),
        completedAt,
        recordedAt: completedAt,
      });
      resultPaths.set(scenario, resultPath);
    });
    const drillPath = path.join(fixture, 'drill.json');
    const collected = run(process.execPath, [
      drillTool,
      'collect',
      '--plan',
      planPath,
      '--failed-health-result',
      resultPaths.get('failed_health_check')!,
      '--host-reboot-result',
      resultPaths.get('host_reboot_during_migration')!,
      '--ssh-disconnect-result',
      resultPaths.get('ssh_disconnect_after_pm2_stop')!,
      '--output',
      drillPath,
    ]);
    expect(collected.status, collected.stderr).toBe(0);
    const deeplyVerifiedResult = run(process.execPath, [
      drillTool,
      'verify-result',
      '--plan',
      planPath,
      '--scenario',
      'failed_health_check',
      '--input',
      resultPaths.get('failed_health_check')!,
    ]);
    expect(deeplyVerifiedResult.status, deeplyVerifiedResult.stderr).toBe(0);
    const deeplyVerifiedDrill = run(process.execPath, [
      drillTool,
      'verify-drill',
      '--input',
      drillPath,
    ]);
    expect(deeplyVerifiedDrill.status, deeplyVerifiedDrill.stderr).toBe(0);

    const owner = generateKeyPairSync('ed25519');
    const ownerPrivate = path.join(fixture, 'owner-private.pem');
    const ownerPublic = path.join(fixture, 'owner-public.pem');
    fs.writeFileSync(
      ownerPrivate,
      owner.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      ownerPublic,
      owner.publicKey.export({ format: 'pem', type: 'spki' }),
      { mode: 0o600 },
    );
    const drillEnvelope = path.join(fixture, 'drill-envelope.json');
    const signedDrill = run(process.execPath, [
      layoutAuthorization,
      'sign-drill',
      '--input',
      drillPath,
      '--private-key',
      ownerPrivate,
      '--output',
      drillEnvelope,
    ]);
    expect(signedDrill.status, signedDrill.stderr).toBe(0);
    const proof = run(process.execPath, [
      drillTool,
      'verify-envelope',
      '--input',
      drillEnvelope,
      '--trust-manifest',
      trustManifest,
      '--provision-receipt',
      provisionReceipt,
    ]);
    expect(proof.status, proof.stderr).toBe(0);
    expect(JSON.parse(proof.stdout)).toMatchObject({
      ok: true,
      schema: 'nexus.release-layout-kvm-proof.v1',
      migrationId,
    });
    const producerTamperedEnvelope = path.join(
      fixture,
      'producer-tampered-drill-envelope.json',
    );
    const producerTampered = JSON.parse(
      fs.readFileSync(drillEnvelope, 'utf8'),
    );
    producerTampered.payload.scenarios[0].result
      .producerTrust.controllerSha256 = 'f'.repeat(64);
    writeJson(producerTamperedEnvelope, producerTampered);
    const producerRejected = run(process.execPath, [
      drillTool,
      'verify-envelope',
      '--input',
      producerTamperedEnvelope,
      '--trust-manifest',
      trustManifest,
      '--provision-receipt',
      provisionReceipt,
    ]);
    expect(producerRejected.status).not.toBe(0);
    expect(producerRejected.stderr).toContain(
      'layout fault result producer trust differs from the plan',
    );

    const createdAt = new Date().toISOString();
    const requestPath = path.join(fixture, 'request.json');
    writeJson(requestPath, {
      schema: 'nexus.release-layout-migration-request.v1',
      migrationId,
      source,
      destination: {
        releaseRoot: '/srv/nexus-release',
        production: '/srv/nexus-release/production',
        staging: '/srv/nexus-release/staging',
      },
      ownerAuthorization: 'explicit',
      pm2AttestationSha256: '7'.repeat(64),
      faultDrillEnvelopeSha256: digest(fs.readFileSync(drillEnvelope)),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 60 * 60 * 1000).toISOString(),
    });
    const requestEnvelope = path.join(fixture, 'request-envelope.json');
    const signedRequest = run(process.execPath, [
      layoutAuthorization,
      'sign-request',
      '--input',
      requestPath,
      '--private-key',
      ownerPrivate,
      '--output',
      requestEnvelope,
    ]);
    expect(signedRequest.status, signedRequest.stderr).toBe(0);
    const verified = run(process.execPath, [
      layoutAuthorization,
      'verify',
      '--request-envelope',
      requestEnvelope,
      '--fault-drill-envelope',
      drillEnvelope,
      '--public-key',
      ownerPublic,
    ]);
    expect(verified.status, verified.stderr).toBe(0);

    const stateRoot = path.join(fixture, 'activation-state');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const phaseAssetRoot = path.join(fixture, 'phase-a-assets');
    const phaseAssets = [
      '/usr/local/sbin/nexus-release-layout-activation-install',
      '/usr/local/sbin/nexus-release-layout-activation-control',
      '/usr/local/sbin/nexus-release-layout-migrate',
      '/usr/local/libexec/nexus-release-layout-sqlite.py',
      '/usr/local/libexec/nexus-release-layout-authorization.mjs',
      '/usr/local/libexec/nexus-release-layout-fault-drill.mjs',
      '/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs',
      '/usr/local/libexec/nexus-release-selector-switch.py',
      '/usr/local/libexec/nexus-release-layout-preflight.sh',
      '/usr/local/sbin/nexus-release-promotion-control',
      '/usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs',
      '/usr/local/libexec/nexus-staging-attestation-broker.sh',
      '/usr/local/libexec/nexus-capture-pm2-dump-authority.mjs',
      '/usr/local/libexec/nexus-pm2-dump-authority.py',
      '/usr/local/sbin/nexus-release-boot-health',
      '/usr/local/sbin/nexus-ollama-install-state-check.mjs',
      '/etc/systemd/system/ollama.service.d/'
        + '00-nexus-ollama-install-guard.conf',
      '/etc/systemd/system/nexus-release-pm2-recovery-daemon.service',
      '/etc/systemd/system/nexus-release-promotion-recovery.service',
      '/etc/systemd/system/nexus-release-layout-activation@.service',
      '/etc/systemd/system/nexus-release-layout-recovery.service',
      '/etc/systemd/system/nexus-release-layout-install-recovery.service',
      '/etc/systemd/system/pm2-dominguez.service.d/'
        + '00-nexus-release-layout-install-recovery.conf',
      '/etc/sudoers.d/nexus-release-layout-activation',
    ].map((asset) => `${phaseAssetRoot}${asset}`);
    for (const asset of phaseAssets) {
      fs.mkdirSync(path.dirname(asset), { recursive: true, mode: 0o700 });
      fs.writeFileSync(asset, `reviewed:${asset}\n`, { mode: 0o600 });
    }
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    const phaseAReceipt = path.join(
      activationRoot,
      'phase-a-receipt.v1.json',
    );
    writeJson(phaseAReceipt, {
      schema: 'nexus.release-layout-phase-a-receipt.v1',
      status: 'completed',
      sourceSha: '8'.repeat(40),
      sourceArchiveSha256: '9'.repeat(64),
      upgradedAt: null,
      existingServiceIdentity: {
        runtimeUnchanged: true,
        beforeSha256: 'a'.repeat(64),
        afterSha256: 'b'.repeat(64),
        runtimeSha256: 'c'.repeat(64),
      },
      phaseARecoveryGuard: true,
      legacyV2AdapterRetired: true,
      pm2Prerequisite: {
        verified: true,
        evidenceSha256: 'd'.repeat(64),
      },
      phaseAUpgrade: {
        performed: false,
        predecessorReceiptPath: null,
        predecessorReceiptSha256: null,
        predecessorSourceSha: null,
      },
      installedAssets: phaseAssets.map((asset) => ({
        path: asset,
        sha256: digest(fs.readFileSync(asset)),
      })),
      prohibitedCommands: ['run', 'recover-all'],
      completedAt: new Date().toISOString(),
    });
    const fakeBin = path.join(fixture, 'activation-bin');
    fs.mkdirSync(fakeBin, { mode: 0o700 });
    const promotion = path.join(fakeBin, 'promotion-control');
    fs.writeFileSync(promotion, `#!/usr/bin/env bash
[ "$1" = assert-root-pm2-ready ] || exit 64
printf '%s\\n' '{"ok":true,"schema":"nexus.pm2-root-install.v1","version":"6.0.14","closureDigest":"${'1'.repeat(64)}","payloadDigest":"${'2'.repeat(64)}","packageLockSha256":"${'3'.repeat(64)}","launcher":"/usr/local/bin/pm2","launcherSha256":"${'4'.repeat(64)}","node":{"path":"/usr/bin/node","version":"v22.23.1","sha256":"${'5'.repeat(64)}"},"entrypoint":"/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2"}'
`, { mode: 0o755 });
    const migrate = path.join(fakeBin, 'migrate');
    const migrateLog = path.join(fixture, 'migrate.log');
    fs.writeFileSync(migrate, `#!/usr/bin/env bash
printf '%s\\n' "$*" >>${JSON.stringify(migrateLog)}
exit 0
`, { mode: 0o755 });
    const systemctl = path.join(fakeBin, 'systemctl');
    const systemctlLog = path.join(fixture, 'systemctl.log');
    fs.writeFileSync(systemctl, `#!/usr/bin/env bash
printf '%s\\n' "$*" >>${JSON.stringify(systemctlLog)}
exit 0
`, { mode: 0o755 });
    const handover = path.join(fakeBin, 'handover');
    fs.writeFileSync(handover, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const authorizationWrapper = path.join(
      fakeBin,
      'layout-authorization.mjs',
    );
    fs.copyFileSync(layoutAuthorization, authorizationWrapper);
    fs.chmodSync(authorizationWrapper, 0o755);
    const controlEnv = {
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LAYOUT_PHASE_A_TEST_ASSET_ROOT: phaseAssetRoot,
      NEXUS_LAYOUT_AUTH_BIN: authorizationWrapper,
      NEXUS_LAYOUT_DRILL_VERIFY_BIN: drillTool,
      NEXUS_LAYOUT_KVM_TRUST_MANIFEST: trustManifest,
      NEXUS_LAYOUT_KVM_PROVISION_RECEIPT: provisionReceipt,
      NEXUS_LAYOUT_KVM_PROVISION_JOURNAL: path.join(
        fixture,
        'no-provision-journal',
      ),
      NEXUS_LAYOUT_MIGRATE_BIN: migrate,
      NEXUS_LAYOUT_HANDOVER_BIN: handover,
      NEXUS_LAYOUT_PROMOTION_CONTROL: promotion,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: systemctl,
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_OWNER_PUBLIC_KEY: ownerPublic,
    };
    const submitted = run('/usr/bin/env', [
      'bash',
      activationControl,
      'submit',
      requestEnvelope,
      drillEnvelope,
    ], controlEnv);
    expect(submitted.status, submitted.stderr).toBe(0);
    expect(
      submitted.stdout.trim(),
      `activation submit produced no receipt; stderr=${submitted.stderr}`,
    ).not.toBe('');
    expect(JSON.parse(submitted.stdout)).toMatchObject({
      ok: true,
      transactionId: migrationId,
      status: 'submitted',
    });
    const journalPath = path.join(
      activationRoot,
      'transactions',
      migrationId,
      'journal.v1.json',
    );
    const submittedJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(submittedJournal).toMatchObject({
      phase: 'submitted',
      transactionId: migrationId,
      authorityVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      drillProofVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      pm2ProofSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      phaseAReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const signedRequestPayload = JSON.parse(
      fs.readFileSync(requestEnvelope, 'utf8'),
    ).payload;
    expect(Date.parse(submittedJournal.submittedAt)).toBeGreaterThanOrEqual(
      Date.parse(signedRequestPayload.createdAt),
    );
    expect(Date.parse(submittedJournal.submittedAt)).toBeLessThanOrEqual(
      Date.parse(signedRequestPayload.expiresAt),
    );
    expect(fs.readFileSync(systemctlLog, 'utf8')).toContain(
      `start --no-block nexus-release-layout-activation@${migrationId}.service`,
    );
    const activePath = path.join(activationRoot, 'active.v1.json');
    fs.unlinkSync(activePath);
    const recoveryNow = new Date(Math.max(
      Date.parse(signedRequestPayload.expiresAt),
      Date.parse(plan.expiresAt),
    ) + 1_000).toISOString();
    const expiredControlEnv = {
      ...controlEnv,
      NODE_ENV: 'test',
      NEXUS_RELEASE_LAYOUT_TEST_NOW: recoveryNow,
    };
    const transactionDirectory = path.dirname(journalPath);
    const acceptedBackup = path.join(
      activationRoot,
      'accepted-transaction-backup',
    );
    fs.renameSync(transactionDirectory, acceptedBackup);
    const expiredNewSubmission = run('/usr/bin/env', [
      'bash',
      activationControl,
      'submit',
      requestEnvelope,
      drillEnvelope,
    ], expiredControlEnv);
    expect(expiredNewSubmission.status).not.toBe(0);
    expect(expiredNewSubmission.stderr).toContain(
      'layout migration request lifetime is invalid',
    );
    expect(fs.existsSync(transactionDirectory)).toBe(false);
    expect(fs.existsSync(activePath)).toBe(false);
    const requestAfterPlanExpiry = path.join(
      fixture,
      'request-after-plan-expiry.json',
    );
    writeJson(requestAfterPlanExpiry, {
      ...signedRequestPayload,
      createdAt: recoveryNow,
      expiresAt: new Date(
        Date.parse(recoveryNow) + 60 * 60 * 1_000,
      ).toISOString(),
    });
    const requestAfterPlanExpiryEnvelope = path.join(
      fixture,
      'request-after-plan-expiry-envelope.json',
    );
    const signedAfterPlanExpiry = run(process.execPath, [
      layoutAuthorization,
      'sign-request',
      '--input',
      requestAfterPlanExpiry,
      '--private-key',
      ownerPrivate,
      '--output',
      requestAfterPlanExpiryEnvelope,
    ], {
      NODE_ENV: 'test',
      NEXUS_RELEASE_LAYOUT_TEST_NOW: recoveryNow,
    });
    expect(signedAfterPlanExpiry.status, signedAfterPlanExpiry.stderr).toBe(0);
    const expiredPlanNewSubmission = run('/usr/bin/env', [
      'bash',
      activationControl,
      'submit',
      requestAfterPlanExpiryEnvelope,
      drillEnvelope,
    ], expiredControlEnv);
    expect(expiredPlanNewSubmission.status).not.toBe(0);
    expect(expiredPlanNewSubmission.stderr).toContain(
      'layout drill plan lifetime is invalid',
    );
    expect(fs.existsSync(transactionDirectory)).toBe(false);
    expect(fs.existsSync(activePath)).toBe(false);
    fs.renameSync(acceptedBackup, transactionDirectory);
    const expiredProofWithoutJournal = run(process.execPath, [
      drillTool,
      'verify-envelope',
      '--input',
      drillEnvelope,
      '--trust-manifest',
      trustManifest,
      '--provision-receipt',
      provisionReceipt,
    ], {
      NODE_ENV: 'test',
      NEXUS_RELEASE_LAYOUT_TEST_NOW: recoveryNow,
    });
    expect(expiredProofWithoutJournal.status).not.toBe(0);
    expect(expiredProofWithoutJournal.stderr).toContain(
      'layout drill plan lifetime is invalid',
    );
    writeJson(journalPath, {
      ...submittedJournal,
      submittedAt: new Date(
        Date.parse(signedRequestPayload.expiresAt) + 1,
      ).toISOString(),
    });
    const invalidAcceptedAt = run('/usr/bin/env', [
      'bash',
      activationControl,
      'recover-all',
    ], expiredControlEnv);
    expect(invalidAcceptedAt.status).not.toBe(0);
    expect(
      fs.existsSync(activePath),
      `${invalidAcceptedAt.stdout}\n${invalidAcceptedAt.stderr}`,
    ).toBe(false);
    writeJson(journalPath, {
      ...submittedJournal,
      drillProofVerificationSha256: '0'.repeat(64),
    });
    const invalidCheckpoint = run('/usr/bin/env', [
      'bash',
      activationControl,
      'recover-all',
    ], expiredControlEnv);
    expect(invalidCheckpoint.status).not.toBe(0);
    expect(fs.existsSync(activePath)).toBe(false);
    writeJson(journalPath, submittedJournal);
    const orphanStatus = run('/usr/bin/env', [
      'bash',
      activationControl,
      'status',
    ], controlEnv);
    expect(orphanStatus.status, orphanStatus.stderr).toBe(0);
    expect(JSON.parse(orphanStatus.stdout)).toMatchObject({
      transactionId: migrationId,
      status: 'submitted',
      recoveryRequired: true,
    });
    const recoveredSubmission = run('/usr/bin/env', [
      'bash',
      activationControl,
      'recover-all',
    ], expiredControlEnv);
    expect(recoveredSubmission.status, recoveredSubmission.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase).toBe(
      'completed',
    );
    expect(fs.readFileSync(migrateLog, 'utf8')).toContain('migrate ');
    expect(fs.existsSync(activePath)).toBe(false);

    const tamperedEnvelope = path.join(fixture, 'tampered-drill-envelope.json');
    const tampered = JSON.parse(fs.readFileSync(drillEnvelope, 'utf8'));
    tampered.payload.scenarios[0].result.proof.executionSignatureBase64 =
      Buffer.alloc(64, 9).toString('base64');
    writeJson(tamperedEnvelope, tampered);
    const rejected = run(process.execPath, [
      drillTool,
      'verify-envelope',
      '--input',
      tamperedEnvelope,
      '--trust-manifest',
      trustManifest,
      '--provision-receipt',
      provisionReceipt,
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('guest execution evidence signature is invalid');
  }, 30_000);

  it('refuses unsigned or incomplete machine evidence before publication', () => {
    const fixture = makeRoot();
    const output = path.join(fixture, 'result.json');
    const attempted = run(process.execPath, [
      drillTool,
      'record',
      '--output',
      output,
    ]);
    expect(attempted.status).not.toBe(0);
    expect(attempted.stderr).toContain(
      'expected prepare, collect, verify-result, verify-drill, verify-plan, '
      + 'verify-envelope, or version',
    );
    expect(fs.existsSync(output)).toBe(false);
  });
});
