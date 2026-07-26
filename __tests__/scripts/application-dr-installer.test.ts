import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = path.resolve('scripts/application-dr-systemd-install.sh');
const layout = path.resolve('ops/application-dr/install-layout.tsv');
const backup = path.resolve('scripts/application-dr-backup.sh');
const service = path.resolve(
  'ops/application-dr/systemd/nexus-application-dr-backup.service',
);
const healthService = path.resolve(
  'ops/application-dr/systemd/nexus-application-dr-health.service',
);
const healthTimer = path.resolve(
  'ops/application-dr/systemd/nexus-application-dr-health.timer',
);
const alertService = path.resolve(
  'ops/application-dr/systemd/nexus-application-dr-alert@.service',
);
const installTransaction = path.resolve(
  'scripts/application-dr-install-transaction.py',
);
const installRecoveryService = path.resolve(
  'ops/application-dr/systemd/nexus-application-dr-install-recovery.service',
);
const systemPython = [
  process.env.CONTENT_ENGINE_PYTHON,
  '/opt/homebrew/bin/python3',
  '/usr/bin/python3',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));

describe('application DR root installer', () => {
  it('is syntactically valid and binds the exact declared install layout', () => {
    const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const script = fs.readFileSync(installer, 'utf8');
    const declared = fs.readFileSync(layout, 'utf8').split('\n').slice(1).join('\n').trim();
    const match = script.match(/cat <<'LAYOUT'\n([\s\S]*?)\nLAYOUT/);
    expect(match?.[1]).toBe(declared);
    expect(script).toContain('validate_root_owned_chain "$SOURCE_ROOT"');
    expect(script).toContain('validate_root_owned_chain "$LAYOUT"');
    expect(script).toContain('validate_root_owned_chain "$source_path"');
    expect(script).toContain('path component is group/world writable');
    expect(script).toContain('install layout differs from the exact allowlist');
    expect(script).toContain('install target is outside the allowlist');
    expect(script).toContain(
      '/etc/systemd/system/nexus-application-dr-install-recovery.service)',
    );
    expect(script).toContain('[ "$(realpath -m -- "$target")" = "$target" ]');
    expect(script).toContain('done <<< "$actual_layout"');
    expect(script).not.toContain('done < <(tail -n +2 "$LAYOUT")');
  });

  it('preflights the captured layout and serializes mutation with backup activity', () => {
    const script = fs.readFileSync(installer, 'utf8');
    const parsedLayout = script.indexOf('done <<< "$actual_layout"');
    const timerStop = script.indexOf('systemctl stop "$DR_TIMER"');
    const accountIntent = script.indexOf(
      '--phase drill-user-create-attempted',
      timerStop,
    );
    const accountMutation = script.indexOf(
      'if [ "$drill_user_exists" = false ]; then',
      parsedLayout,
    );
    expect(parsedLayout).toBeGreaterThan(-1);
    expect(timerStop).toBeGreaterThan(parsedLayout);
    expect(accountMutation).toBeGreaterThan(timerStop);
    expect(accountIntent).toBeGreaterThan(accountMutation);
    expect(accountIntent).toBeLessThan(
      script.indexOf('if ! useradd', accountIntent),
    );
    expect(script.slice(accountIntent, script.indexOf('if ! useradd', accountIntent)))
      .toContain('--drill-user-created');
    expect(script).toContain('exec 9>"$DR_BACKUP_LOCK"');
    expect(script).toContain('flock -n 9');
    expect(script).toContain('application DR backup service is active');
    expect(script).toContain('systemctl start "$DR_TIMER"');
    expect(script).toContain('systemctl start "$DR_HEALTH_TIMER"');
    expect(script).toContain(
      '[ "$timer_enabled_after" = "$timer_enabled" ]',
    );
    expect(script).toContain(
      '[ "$health_timer_enabled_after" = "$health_timer_desired_enabled" ]',
    );
  });

  it('installs matched backup/health timers and local failure alert hooks', () => {
    const script = fs.readFileSync(installer, 'utf8');
    const backupUnit = fs.readFileSync(service, 'utf8');
    const healthUnit = fs.readFileSync(healthService, 'utf8');
    const timerUnit = fs.readFileSync(healthTimer, 'utf8');
    const alertUnit = fs.readFileSync(alertService, 'utf8');

    expect(script).toContain(
      '[ "$health_timer_enabled" = "$timer_enabled" ]',
    );
    expect(script).toContain(
      '[ "$health_timer_active" = "$timer_active" ]',
    );
    expect(script).toContain(
      'health_timer_unit_preexisting="${had_targets[$health_timer_index]}"',
    );
    expect(script).toContain(
      'health_timer_desired_enabled="$timer_enabled"',
    );
    expect(script).toContain('systemctl enable "$DR_HEALTH_TIMER"');
    expect(script).toContain(
      '--health-timer-enabled-state "$health_timer_enabled_state"',
    );
    expect(script).toContain('systemctl_enabled_state()');
    expect(script).toContain('systemctl_active_state()');
    expect(script).toContain('DR_ALERT_DIR="$DR_STATE_DIR/alerts"');
    expect(script).toContain('DR_EVIDENCE_DIR="$DR_STATE_DIR/evidence"');
    expect(script).toContain(
      'scripts/aws-credential-process-boundary.py\t'
      + '/usr/local/libexec/nexus-application-dr/aws-credential-process-boundary.py\t'
      + 'root:root\t0644',
    );
    expect(script).toContain(
      'scripts/application-dr-crl-parameters.mjs\t'
      + '/usr/local/libexec/nexus-application-dr/application-dr-crl-parameters.mjs\t'
      + 'root:root\t0755',
    );
    expect(script).toContain(
      'scripts/application-dr-cloudformation-activate.py\t'
      + '/usr/local/libexec/nexus-application-dr/application-dr-cloudformation-activate.py\t'
      + 'root:root\t0755',
    );
    expect(script).toContain(
      'scripts/application-dr-cloudformation-parameter-digest.py\t'
      + '/usr/local/libexec/nexus-application-dr/application-dr-cloudformation-parameter-digest.py\t'
      + 'root:root\t0755',
    );
    expect(script).toContain(
      'scripts/application-dr-install-transaction.py\t'
      + '/usr/local/libexec/nexus-application-dr/application-dr-install-transaction.py\t'
      + 'root:root\t0755',
    );
    expect(backupUnit).toContain(
      'OnFailure=nexus-application-dr-alert@%n.service',
    );
    expect(backupUnit).toContain(
      'ConditionPathExists=!/var/lib/nexus-release-promotion/active.json',
    );
    expect(healthUnit).toContain('--max-age-seconds 3600');
    expect(healthUnit).toContain(
      'OnFailure=nexus-application-dr-alert@%n.service',
    );
    expect(healthUnit).toContain(
      'ReadWritePaths=/var/lib/nexus-application-dr',
    );
    expect(healthUnit).not.toContain(
      'ConditionPathExists=!/var/lib/nexus-application-dr/install-in-progress.v1',
    );
    expect(healthUnit).not.toContain(
      'ConditionPathExists=/etc/nexus-application-dr/backup.env',
    );
    expect(timerUnit).toContain('OnCalendar=*-*-* *:00/5:00 UTC');
    expect(timerUnit).toContain(
      'Unit=nexus-application-dr-health.service',
    );
    expect(alertUnit).toContain('--unit %i');
    expect(alertUnit).toContain('--logger /usr/bin/logger');
    expect(alertUnit).not.toContain('EnvironmentFile=');
  });

  it('stages exact assets atomically and routes every armed failure through exact retained recovery', () => {
    const script = fs.readFileSync(installer, 'utf8');
    const helper = fs.readFileSync(installTransaction, 'utf8');
    expect(script).toContain(
      'mktemp -p "$target_parent" ".nexus-application-dr.stage.XXXXXX"',
    );
    expect(script).toContain(
      'mv -fT -- "${stage_paths[$index]}" "$target"',
    );
    expect(helper).toContain('for asset in reversed(journal["assets"])');
    expect(helper).toContain('os.replace(backup, target)');
    expect(script).toContain('install_succeeded=false');
    expect(script).toContain(
      'python3 "$DR_INSTALL_RECOVERY_PROGRAM" recover',
    );
    expect(script).toContain(
      'exact transaction rollback failed; journal retained',
    );
    expect(script).toContain('--phase drill-user-create-attempted');
    expect(script.indexOf('--phase drill-user-create-attempted')).toBeLessThan(
      script.indexOf('if ! useradd'),
    );
    expect(script).toContain(
      'rollback incomplete; leaving $DR_TIMER stopped',
    );
    expect(script).toContain(
      'rollback incomplete; leaving $DR_HEALTH_TIMER stopped',
    );
    expect(script).not.toContain(
      'userdel "$EXPECTED_DRILL_USER" >/dev/null 2>&1',
    );
    expect(script).not.toContain(
      'groupdel "$EXPECTED_DRILL_USER" >/dev/null 2>&1',
    );
  });

  it('leaves a durable fail-closed journal across power loss and commits the guard first', () => {
    const script = fs.readFileSync(installer, 'utf8');
    const backupScript = fs.readFileSync(backup, 'utf8');
    const serviceUnit = fs.readFileSync(service, 'utf8');
    const journalWrite = script.indexOf(
      '"$SOURCE_ROOT/scripts/application-dr-install-transaction.py" begin',
    );
    const timerStop = script.indexOf(
      'systemctl stop "$DR_TIMER"',
      journalWrite,
    );
    const accountMutation = script.indexOf(
      'if [ "$drill_user_exists" = false ]; then',
      journalWrite,
    );
    const recoveryServiceCommit = script.indexOf(
      'commit_asset "$install_recovery_service_index"',
    );
    const serviceCommit = script.indexOf(
      'commit_asset "$service_index"',
      recoveryServiceCommit,
    );
    const remainingCommits = script.indexOf(
      'for ((index=0; index<planned; index+=1)); do',
      serviceCommit,
    );
    const stageInstall = script.indexOf(
      'install -o root -g root -m "${modes[$index]}" -- "${sources[$index]}" "$stage"',
    );
    const stageFsync = script.indexOf('fsync_path "$stage"', stageInstall);
    const targetReplace = script.indexOf(
      'mv -fT -- "${stage_paths[$index]}" "$target"',
    );
    const parentFsync = script.indexOf(
      'fsync_path "$target_parent"',
      targetReplace,
    );
    const transactionComplete = script.lastIndexOf(
      '"$DR_INSTALL_RECOVERY_PROGRAM" complete',
    );

    expect(journalWrite).toBeGreaterThan(-1);
    expect(timerStop).toBeGreaterThan(journalWrite);
    expect(accountMutation).toBeGreaterThan(journalWrite);
    expect(recoveryServiceCommit).toBeGreaterThan(journalWrite);
    expect(serviceCommit).toBeGreaterThan(recoveryServiceCommit);
    expect(remainingCommits).toBeGreaterThan(serviceCommit);
    expect(stageFsync).toBeGreaterThan(stageInstall);
    expect(parentFsync).toBeGreaterThan(targetReplace);
    expect(transactionComplete).toBeGreaterThan(targetReplace);
    expect(script).toContain('ln -- "$target" "$backup"');
    expect(script).toContain(
      'unfinished install requires its exact retained recovery program',
    );
    expect(script).toContain(
      '"$DR_INSTALL_RECOVERY_PROGRAM" checkpoint',
    );
    expect(script).toContain('--committed-index "$index"');
    expect(script).toContain(
      'systemctl enable "$DR_INSTALL_RECOVERY_SERVICE"',
    );
    expect(script).toContain('fsync_path "$DR_STATE_DIR"');
    expect(serviceUnit).toContain(
      'ConditionPathExists=!/var/lib/nexus-application-dr/install-in-progress.v1',
    );
    expect(backupScript).toContain(
      'application DR installation is incomplete; rerun the root installer',
    );
  });

  it('binds boot recovery to exact sources and publishes success only after the commit point', () => {
    const helper = fs.readFileSync(installTransaction, 'utf8');
    const recoveryUnit = fs.readFileSync(installRecoveryService, 'utf8');
    const preflight = helper.indexOf('preflight_recovery(journal)');
    const reverseRestore = helper.indexOf(
      'for asset in reversed(journal["assets"])',
      preflight,
    );
    const complete = helper.indexOf('def complete(');
    const verifyTargets = helper.indexOf(
      'regular_digest(target, asset["sourceSha256"]',
      complete,
    );
    const commitPoint = helper.indexOf(
      'remove_durable(args.journal)',
      verifyTargets,
    );
    const passReceipt = helper.indexOf(
      'write_receipt(args.receipt, status="passed"',
      commitPoint,
    );
    const backupCleanup = helper.indexOf(
      'if asset["backup"]:',
      passReceipt,
    );
    const recover = helper.indexOf('def recover(');
    const identityRestore = helper.indexOf(
      'remove_created_identity(journal["drillUser"])',
      recover,
    );
    const timerRestore = helper.indexOf('restore_timers(journal)', recover);
    const rollbackCommit = helper.indexOf(
      'remove_durable(args.journal)',
      timerRestore,
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(reverseRestore).toBeGreaterThan(preflight);
    expect(verifyTargets).toBeGreaterThan(complete);
    expect(commitPoint).toBeGreaterThan(verifyTargets);
    expect(passReceipt).toBeGreaterThan(commitPoint);
    expect(backupCleanup).toBeGreaterThan(passReceipt);
    expect(identityRestore).toBeGreaterThan(recover);
    expect(timerRestore).toBeGreaterThan(identityRestore);
    expect(rollbackCommit).toBeGreaterThan(timerRestore);
    expect(helper).toContain('"sourceSha256": sha256_file(source_path)');
    expect(helper).toContain('"predecessorSha256": predecessor_sha');
    expect(helper).toContain('"layoutSha256": sha256_file(args.layout)');
    expect(helper).toContain(
      '"recoveryProgramSha256": recovery_sha',
    );
    const declaredTargets = fs
      .readFileSync(layout, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split('\t')[1]);
    for (const target of declaredTargets) {
      expect(helper).toContain(JSON.stringify(target));
    }
    expect(helper).toContain('set(targets) != ALLOWED_TARGETS');
    expect(helper).toContain(
      'fail("install journal does not bind the exact distinct asset set")',
    );
    expect(helper).toContain('validate_operation_paths(');
    expect(recoveryUnit).toContain('User=root');
    expect(recoveryUnit).toContain(
      'ConditionPathExists=/var/lib/nexus-application-dr/install-in-progress.v1',
    );
    expect(recoveryUnit).toContain(
      'Before=nexus-application-dr-backup.timer',
    );
    expect(recoveryUnit).toContain(
      '/var/lib/nexus-application-dr/install-recovery-program.v2.py recover',
    );
    expect(recoveryUnit).toContain('ProtectSystem=strict');
  });

  it.runIf(systemPython !== undefined)(
    'resumes rollback after power loss between predecessor replacement and its checkpoint',
    () => {
      const harness = `
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("transaction", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def verify_digest(path, expected, label):
    if not path.is_file() or path.is_symlink() or digest(path) != expected:
        raise SystemExit(f"{label} digest mismatch")

module.regular_digest = verify_digest

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    target = root / "target"
    backup = root / ".nexus-application-dr.backup.0"
    stage = root / ".nexus-application-dr.stage.0"
    predecessor = b"reviewed-predecessor"
    source = b"reviewed-source"
    target.write_bytes(source)
    backup.write_bytes(predecessor)
    stage.write_bytes(source)
    asset = {
        "index": 0,
        "target": str(target),
        "backup": str(backup),
        "stage": str(stage),
        "hadTarget": True,
        "sourceSha256": hashlib.sha256(source).hexdigest(),
        "predecessorSha256": hashlib.sha256(predecessor).hexdigest(),
        "predecessorMode": "0644",
    }
    journal = {"assets": [asset], "recoveredIndices": []}
    module.preflight_recovery(journal)

    def crash_after_replace(*_arguments):
        raise RuntimeError("simulated power loss after os.replace")

    module.os.chown = crash_after_replace
    try:
        module.restore_asset(asset)
    except RuntimeError as error:
        if str(error) != "simulated power loss after os.replace":
            raise
    else:
        raise SystemExit("fault injection did not interrupt recovery")

    if backup.exists() or target.read_bytes() != predecessor:
        raise SystemExit("predecessor replacement did not precede the fault")

    module.os.chown = lambda *_arguments: None
    module.preflight_recovery(journal)
    module.restore_asset(asset)
    recovered = {"assets": [asset], "recoveredIndices": [0]}
    module.preflight_recovery(recovered)
    module.restore_asset(asset)
    module.preflight_recovery(recovered)
    print(json.dumps({
        "targetSha256": digest(target),
        "backupExists": backup.exists(),
        "stageExists": stage.exists(),
    }, separators=(",", ":"), sort_keys=True))
`;
      const result = spawnSync(
        systemPython!,
        ['-c', harness, installTransaction],
        { encoding: 'utf8' },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence).toEqual({
        backupExists: false,
        stageExists: false,
        targetSha256:
          '3f71063dcf9d36f333ed4de44a72605db3b5d000ad7ecbd2b73f6afe25154dcf',
      });
    },
  );

  it.runIf(systemPython !== undefined)(
    'fails closed on disabled/inactive systemd restoration and drill identity deletion errors',
    () => {
      const harness = `
import importlib.util
import json
import subprocess
import sys

spec = importlib.util.spec_from_file_location("transaction", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
failures = []

def expect_failure(label, callback):
    try:
        callback()
    except SystemExit as error:
        failures.append({"label": label, "message": str(error)})
    else:
        raise SystemExit(f"{label} did not fail closed")

def disable_failure(arguments, **kwargs):
    return subprocess.CompletedProcess(arguments, 1, b"", b"")

module.subprocess.run = disable_failure
expect_failure(
    "disabled",
    lambda: module.restore_enabled_state("nexus-test.timer", "disabled"),
)

def inactive_mismatch(arguments, **kwargs):
    if arguments[1] == "stop":
        return subprocess.CompletedProcess(arguments, 1, b"", b"")
    if arguments[1] == "is-active":
        return subprocess.CompletedProcess(arguments, 0, b"active\\n", b"")
    raise AssertionError(arguments)

module.subprocess.run = inactive_mismatch
expect_failure(
    "inactive",
    lambda: module.restore_active_state("nexus-test.timer", "inactive"),
)

def identity_failure(arguments, **kwargs):
    if arguments[0] == "/usr/sbin/userdel":
        return subprocess.CompletedProcess(arguments, 1, b"", b"")
    if arguments[:2] == ["/usr/bin/getent", "passwd"]:
        return subprocess.CompletedProcess(arguments, 0, b"user:x\\n", b"")
    raise AssertionError(arguments)

module.subprocess.run = identity_failure
expect_failure(
    "identity",
    lambda: module.remove_created_identity("nexus-drill"),
)

absent_calls = []
def absent_identity(arguments, **kwargs):
    absent_calls.append(arguments[:2])
    if arguments[0] in {"/usr/sbin/userdel", "/usr/sbin/groupdel"}:
        return subprocess.CompletedProcess(arguments, 1, b"", b"")
    if arguments[0] == "/usr/bin/getent":
        return subprocess.CompletedProcess(arguments, 2, b"", b"")
    raise AssertionError(arguments)

module.subprocess.run = absent_identity
module.remove_created_identity("nexus-drill")
if absent_calls != [
    ["/usr/sbin/userdel", "nexus-drill"],
    ["/usr/bin/getent", "passwd"],
    ["/usr/sbin/groupdel", "nexus-drill"],
    ["/usr/bin/getent", "group"],
]:
    raise AssertionError(absent_calls)
print(json.dumps(failures, separators=(",", ":"), sort_keys=True))
`;
      const result = spawnSync(
        systemPython!,
        ['-c', harness, installTransaction],
        { encoding: 'utf8' },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const failures = JSON.parse(result.stdout);
      expect(failures.map((entry: { label: string }) => entry.label))
        .toEqual(['disabled', 'inactive', 'identity']);
      expect(failures[0].message).toContain('systemctl disable');
      expect(failures[1].message).toContain(
        'active state was not restored exactly',
      );
      expect(failures[2].message).toContain(
        'created drill passwd identity still exists',
      );
    },
  );

  it('creates only root-owned assets and a disabled isolated account without enabling backup', () => {
    const script = fs.readFileSync(installer, 'utf8');
    expect(script).toContain('--shell /usr/sbin/nologin');
    expect(script).toContain('drill account must not belong to supplementary groups');
    expect(script).toContain('/etc/nexus-application-dr');
    expect(script).toContain('/var/lib/nexus-application-dr');
    expect(script).toContain('"configurationWritten":false');
    expect(script).not.toContain('systemctl enable "$DR_TIMER"');
    expect(script).not.toContain('backup.env.example" "/etc/nexus-application-dr/backup.env');
  });

  it('rejects invocation without the exact root-owned source argument before mutation', () => {
    const result = spawnSync('bash', [installer], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      'Usage: sudo scripts/application-dr-systemd-install.sh <root-owned-source-root>',
    );
  });
});
