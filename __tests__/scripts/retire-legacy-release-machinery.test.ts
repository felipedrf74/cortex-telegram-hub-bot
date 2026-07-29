import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const retirementScript = path.resolve('scripts/retire-legacy-release-machinery.sh');
const temporaryRoots: string[] = [];
const retiredKvmResidualPaths = [
  '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service.d',
  '/etc/systemd/system/nexus-release-layout-fault-drill@.service.d',
  '/etc/systemd/system/nexus-rollback-drill-vm@.service.d',
  '/etc/tmpfiles.d/nexus-rollback-drill-vm.conf',
  '/usr/local/libexec/nexus-rollback-drill-vm',
  '/etc/nexus-rollback-drill-vm',
  '/run/nexus-rollback-drill-vm',
] as const;
const protectedOperationalPaths = [
  '/etc/tmpfiles.d/nexus-release-sonar-lock.conf',
  '/usr/local/share/nexus-release',
  '/opt/nexus-release',
  '/var/lib/nexus-release',
  '/var/lib/nexus-release-lean-bootstrap',
  '/var/lib/nexus-release-retired',
] as const;

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-retirement-test-'));
  temporaryRoots.push(root);
  return root;
}

function runHarness(body: string, environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    'bash',
    ['-c', `
source "$RETIREMENT_SCRIPT"
${body}
`],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...environment,
        RETIREMENT_SCRIPT: retirementScript,
      },
    },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy release machinery retirement handoff', () => {
  it('uses a bounded three-second health request window', () => {
    const output = runHarness(`
printf '%s\\n' "$HEALTH_HTTP_TIMEOUT_SECONDS"
`);

    expect(output.trim()).toBe('3');
  });

  it.each(retiredKvmResidualPaths)(
    'allowlists the exact verified retired KVM residual path %s',
    (candidate) => {
      const output = runHarness(`
assert_allowlisted_path "$CANDIDATE"
printf 'allowlisted\\n'
`, { CANDIDATE: candidate });

      expect(output.trim()).toBe('allowlisted');
    },
  );

  it.each(protectedOperationalPaths)(
    'preserves the current release or Sonar path %s',
    (candidate) => {
      const result = spawnSync(
        'bash',
        ['-c', `
source "$RETIREMENT_SCRIPT"
assert_allowlisted_path "$CANDIDATE"
`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            RETIREMENT_SCRIPT: retirementScript,
            CANDIDATE: candidate,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('refusing non-allowlisted removal path');
    },
  );

  it.each(retiredKvmResidualPaths)(
    'does not prefix-allowlist a neighbor of %s',
    (candidate) => {
      const result = spawnSync(
        'bash',
        ['-c', `
source "$RETIREMENT_SCRIPT"
assert_allowlisted_path "$CANDIDATE.unrelated"
`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            RETIREMENT_SCRIPT: retirementScript,
            CANDIDATE: candidate,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('refusing non-allowlisted removal path');
    },
  );

  it('preserves an unrelated path when removal is requested', () => {
    const root = temporaryRoot();
    const unrelated = path.join(root, 'unrelated-release-tool');
    fs.writeFileSync(unrelated, 'keep\n');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
remove_allowlisted_path "$UNRELATED"
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          UNRELATED: unrelated,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing non-allowlisted removal path');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep\n');
  });

  it.each([
    {
      name: 'canonical',
      canonicalActive: '1',
      temporaryActive: '0',
      expected: 'pm2-dominguez.service\t1234\t/system.slice/pm2-dominguez.service',
    },
    {
      name: 'temporary',
      canonicalActive: '0',
      temporaryActive: '1',
      expected: [
        'nexus-release-pm2-recovery-daemon.service',
        '1234',
        '/system.slice/nexus-release-pm2-recovery-daemon.service',
      ].join('\t'),
    },
  ])('accepts exactly one governed $name PM2 authority', ({
    canonicalActive,
    temporaryActive,
    expected,
  }) => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'pm2.pid'), '1234\n', { mode: 0o600 });
    const output = runHarness(`
PM2_HOME="$FIXTURE_ROOT"
fake_systemctl() {
  local command="$1"
  shift
  case "$command" in
    is-active)
      [ "\${1:-}" != --quiet ] || shift
      case "\${1:-}" in
        "$CANONICAL_PM2_UNIT") [ "$CANONICAL_ACTIVE" = 1 ] ;;
        "$TEMPORARY_PM2_UNIT") [ "$TEMPORARY_ACTIVE" = 1 ] ;;
        *) return 3 ;;
      esac
      ;;
    show)
      local property="" unit="\${!#}"
      for argument in "$@"; do
        case "$argument" in --property=*) property="\${argument#--property=}" ;; esac
      done
      case "$property:$unit" in
        MainPID:*) printf '1234\\n' ;;
        ControlGroup:"$CANONICAL_PM2_UNIT")
          printf '/system.slice/%s\\n' "$CANONICAL_PM2_UNIT"
          ;;
        ControlGroup:"$TEMPORARY_PM2_UNIT")
          printf '/system.slice/%s\\n' "$TEMPORARY_PM2_UNIT"
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}
SYSTEMCTL_BIN=fake_systemctl
detect_pm2_authority
`, {
      FIXTURE_ROOT: root,
      CANONICAL_ACTIVE: canonicalActive,
      TEMPORARY_ACTIVE: temporaryActive,
    });

    expect(output.trim()).toBe(expected);
  });

  it.each([
    ['no', '0', '0'],
    ['multiple', '1', '1'],
  ])('fails closed when $1 PM2 authorities are active', (_name, canonical, temporary) => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'pm2.pid'), '1234\n', { mode: 0o600 });
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
PM2_HOME="$FIXTURE_ROOT"
fake_systemctl() {
  [ "$1" = is-active ] || return 1
  shift
  [ "\${1:-}" != --quiet ] || shift
  case "\${1:-}" in
    "$CANONICAL_PM2_UNIT") [ "$CANONICAL_ACTIVE" = 1 ] ;;
    "$TEMPORARY_PM2_UNIT") [ "$TEMPORARY_ACTIVE" = 1 ] ;;
    *) return 3 ;;
  esac
}
SYSTEMCTL_BIN=fake_systemctl
detect_pm2_authority
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          FIXTURE_ROOT: root,
          CANONICAL_ACTIVE: canonical,
          TEMPORARY_ACTIVE: temporary,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly one governed PM2 authority must be active');
  });

  it('validates and acquires the user and root locks in canonical order', () => {
    const root = temporaryRoot();
    const userLock = path.join(root, 'user.lock');
    const rootLock = path.join(root, 'root.lock');
    const trace = path.join(root, 'trace');
    fs.writeFileSync(userLock, '');
    fs.writeFileSync(rootLock, '');
    const output = runHarness(`
USER_RELEASE_LOCK="$USER_LOCK"
ROOT_SONAR_LOCK="$ROOT_LOCK"
assert_safe_lock_file() {
  printf 'safe:%s:%s\\n' "$1" "$2" >>"$TRACE_FILE"
}
assert_lock_fd_matches_path() {
  printf 'fd:%s:%s\\n' "$1" "$2" >>"$TRACE_FILE"
}
fake_flock() {
  printf 'flock:%s\\n' "$*" >>"$TRACE_FILE"
}
FLOCK_BIN=fake_flock
acquire_retirement_locks
cat "$TRACE_FILE"
`, {
      USER_LOCK: userLock,
      ROOT_LOCK: rootLock,
      TRACE_FILE: trace,
    });

    expect(output.trim().split('\n')).toEqual([
      `safe:${userLock}:dominguez:dominguez:600`,
      `safe:${userLock}:dominguez:dominguez:600`,
      `fd:9:${userLock}`,
      'flock:-n 9',
      `safe:${rootLock}:root:dominguez:660`,
      `safe:${rootLock}:root:dominguez:660`,
      `fd:8:${rootLock}`,
      'flock:-n 8',
    ]);
  });

  it('fails nonblocking when the root maintenance lock is busy', () => {
    const root = temporaryRoot();
    const userLock = path.join(root, 'user.lock');
    const rootLock = path.join(root, 'root.lock');
    const trace = path.join(root, 'trace');
    fs.writeFileSync(userLock, '');
    fs.writeFileSync(rootLock, '');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
USER_RELEASE_LOCK="$USER_LOCK"
ROOT_SONAR_LOCK="$ROOT_LOCK"
assert_safe_lock_file() { :; }
assert_lock_fd_matches_path() { :; }
fake_flock() {
  printf '%s\\n' "$*" >>"$TRACE_FILE"
  [ "\${2:-}" != 8 ]
}
FLOCK_BIN=fake_flock
acquire_retirement_locks
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          USER_LOCK: userLock,
          ROOT_LOCK: rootLock,
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('root maintenance action is active');
    expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      '-n 9',
      '-n 8',
    ]);
  });

  it.each(['symbolic', 'wrong-identity'])(
    'rejects a %s shared lock before opening it',
    (kind) => {
      const root = temporaryRoot();
      const target = path.join(root, 'target.lock');
      const candidate = path.join(root, 'candidate.lock');
      fs.writeFileSync(target, '');
      if (kind === 'symbolic') fs.symlinkSync(target, candidate);
      else fs.writeFileSync(candidate, '');
      const result = spawnSync(
        'bash',
        ['-c', `
source "$RETIREMENT_SCRIPT"
fake_stat() {
  [ "$LOCK_KIND" != wrong-identity ] || {
    printf 'root:root:777\\n'
    return
  }
  printf 'dominguez:dominguez:600\\n'
}
STAT_BIN=fake_stat
assert_safe_lock_file "$LOCK_PATH" dominguez:dominguez:600
`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            RETIREMENT_SCRIPT: retirementScript,
            LOCK_KIND: kind,
            LOCK_PATH: candidate,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('shared lock is missing or unsafe');
    },
  );

  it('allows direct dry-run but requires an exact transient systemd identity for apply', () => {
    const root = temporaryRoot();
    const cgroup = path.join(root, 'cgroup');
    fs.writeFileSync(
      cgroup,
      '0::/system.slice/nexus-release-retirement-fixture.service\n',
    );
    const output = runHarness(`
MODE=dry-run
unset INVOCATION_ID SYSTEMD_EXEC_PID
assert_detached_systemd_transaction
printf 'dry-run-direct\\n'

MODE=apply
INVOCATION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SYSTEMD_EXEC_PID=$$
SELF_CGROUP_FILE="$CGROUP_FILE"
fake_systemctl() {
  [ "$1" = show ] || return 1
  local property="\${2#--property=}"
  local unit="\${4:-}"
  case "$property" in
    ActiveState) printf 'activating\\n' ;;
    Type) printf 'exec\\n' ;;
    FragmentPath) printf '/run/systemd/transient/%s\\n' "$unit" ;;
    MainPID) printf '%s\\n' "$$" ;;
    InvocationID) printf '%s\\n' "$INVOCATION_ID" ;;
    ControlGroup) printf '/system.slice/%s\\n' "$unit" ;;
    LoadState) printf 'loaded\\n' ;;
    *) return 1 ;;
  esac
}
SYSTEMCTL_BIN=fake_systemctl
assert_detached_systemd_transaction
printf 'apply-detached\\n'
`, { CGROUP_FILE: cgroup });

    expect(output.trim().split('\n')).toEqual([
      'dry-run-direct',
      'apply-detached',
    ]);
  });

  it('rejects direct apply without a detached systemd invocation', () => {
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
MODE=apply
unset INVOCATION_ID SYSTEMD_EXEC_PID
assert_detached_systemd_transaction
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('detached systemd retirement transaction');
  });

  it('accepts only the audited retired KVM identity and runtime ownership', () => {
    const output = runHarness(`
fake_getent() {
  case "$1:$2" in
    passwd:nexus-drill-vm|passwd:993)
      printf '%s\\n' "$RETIRED_KVM_PASSWD_ENTRY"
      ;;
    group:nexus-drill-vm|group:980)
      printf '%s\\n' "$RETIRED_KVM_GROUP_ENTRY"
      ;;
    group:kvm)
      printf 'kvm:x:993:libvirt-qemu,nexus-drill-vm\\n'
      ;;
    *) return 2 ;;
  esac
}
fake_id() {
  case "$1" in
    -u) printf '993\\n' ;;
    -g) printf '980\\n' ;;
    -G) printf '980 993\\n' ;;
    -Gn) printf 'nexus-drill-vm kvm\\n' ;;
    *) return 1 ;;
  esac
}
fake_pgrep() { return 1; }
fake_find() {
  [ "$1" != /run ] || printf '%s\\0' "$RETIRED_KVM_RUNTIME_ROOT/handoff"
}
GETENT_BIN=fake_getent
ID_BIN=fake_id
PGREP_BIN=fake_pgrep
FIND_BIN=fake_find
validate_retired_kvm_identity
printf '%s\\n' "$RETIRED_KVM_IDENTITY_PRESENT"
`);

    expect(output.trim()).toBe('true');
  });

  it('rejects unexpected retired KVM supplementary membership', () => {
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
fake_getent() {
  case "$1:$2" in
    passwd:nexus-drill-vm|passwd:993)
      printf '%s\\n' "$RETIRED_KVM_PASSWD_ENTRY"
      ;;
    group:nexus-drill-vm|group:980)
      printf '%s\\n' "$RETIRED_KVM_GROUP_ENTRY"
      ;;
    group:kvm) printf 'kvm:x:993:nexus-drill-vm\\n' ;;
    *) return 2 ;;
  esac
}
fake_id() {
  case "$1" in
    -u) printf '993\\n' ;;
    -g) printf '980\\n' ;;
    -G) printf '980 993 994\\n' ;;
    -Gn) printf 'nexus-drill-vm kvm unexpected\\n' ;;
    *) return 1 ;;
  esac
}
GETENT_BIN=fake_getent
ID_BIN=fake_id
validate_retired_kvm_identity
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('membership differs from the audited identity');
  });

  it.each([
    { autoRemovesGroup: 'false', expectsGroupdel: true },
    { autoRemovesGroup: 'true', expectsGroupdel: false },
  ])(
    'removes the audited KVM identity when userdel auto-removes its group: $autoRemovesGroup',
    ({ autoRemovesGroup, expectsGroupdel }) => {
      const root = temporaryRoot();
      const trace = path.join(root, 'trace');
      const output = runHarness(`
user_present=true
group_present=true
validate_retired_kvm_identity() {
  RETIRED_KVM_IDENTITY_PRESENT=true
  printf 'validate\\n' >>"$TRACE_FILE"
}
assert_retired_kvm_owned_paths() {
  printf 'ownership:%s\\n' "$1" >>"$TRACE_FILE"
}
read_getent_entry() {
  GETENT_RESULT=
  GETENT_FOUND=false
  case "$1:$2" in
    passwd:nexus-drill-vm|passwd:993)
      if [ "$user_present" = true ]; then
        GETENT_RESULT="$RETIRED_KVM_PASSWD_ENTRY"
        GETENT_FOUND=true
      fi
      ;;
    group:nexus-drill-vm|group:980)
      if [ "$group_present" = true ]; then
        GETENT_RESULT="$RETIRED_KVM_GROUP_ENTRY"
        GETENT_FOUND=true
      fi
      ;;
  esac
}
fake_userdel() {
  [ "$1" = "$RETIRED_KVM_USER" ] || return 1
  user_present=false
  [ "$AUTO_REMOVES_GROUP" != true ] || group_present=false
  printf 'userdel:%s\\n' "$1" >>"$TRACE_FILE"
}
fake_groupdel() {
  [ "$user_present" = false ] && [ "$1" = "$RETIRED_KVM_GROUP" ] || return 1
  group_present=false
  printf 'groupdel:%s\\n' "$1" >>"$TRACE_FILE"
}
USERDEL_BIN=fake_userdel
GROUPDEL_BIN=fake_groupdel
RETIRED_KVM_IDENTITY_PRESENT=true
retire_kvm_identity
cat "$TRACE_FILE"
`, {
        TRACE_FILE: trace,
        AUTO_REMOVES_GROUP: autoRemovesGroup,
      });

      const expected = [
        'validate',
        'ownership:false',
        'userdel:nexus-drill-vm',
      ];
      if (expectsGroupdel) expected.push('groupdel:nexus-drill-vm');
      expected.push('ownership:false');
      expect(output.trim().split('\n')).toEqual(expected);
    },
  );

  it('retries only the exact orphaned KVM group after userdel succeeds', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const userState = path.join(root, 'user-present');
    const groupState = path.join(root, 'group-present');
    const groupdelAttempt = path.join(root, 'groupdel-attempt');
    fs.writeFileSync(userState, '');
    fs.writeFileSync(groupState, '');

    const output = runHarness(`
fake_getent() {
  case "$1:$2" in
    passwd:nexus-drill-vm|passwd:993)
      [ -e "$USER_STATE" ] || return 2
      printf '%s\\n' "$RETIRED_KVM_PASSWD_ENTRY"
      ;;
    group:nexus-drill-vm|group:980)
      [ -e "$GROUP_STATE" ] || return 2
      printf '%s\\n' "$RETIRED_KVM_GROUP_ENTRY"
      ;;
    group:kvm)
      if [ -e "$USER_STATE" ]; then
        printf 'kvm:x:993:nexus-drill-vm\\n'
      else
        printf 'kvm:x:993:\\n'
      fi
      ;;
    *) return 2 ;;
  esac
}
fake_id() {
  [ -e "$USER_STATE" ] || return 1
  case "$1" in
    -u) printf '993\\n' ;;
    -g) printf '980\\n' ;;
    -G) printf '980 993\\n' ;;
    -Gn) printf 'nexus-drill-vm kvm\\n' ;;
    *) return 1 ;;
  esac
}
fake_pgrep() {
  printf 'process-audit:%s\\n' "$*" >>"$TRACE_FILE"
  return 1
}
fake_find() {
  printf 'ownership-audit:%s\\n' "$1" >>"$TRACE_FILE"
}
fake_userdel() {
  printf 'userdel:%s\\n' "$1" >>"$TRACE_FILE"
  /bin/rm -f "$USER_STATE"
}
fake_groupdel() {
  printf 'groupdel:%s\\n' "$1" >>"$TRACE_FILE"
  if [ ! -e "$GROUPDEL_ATTEMPT" ]; then
    : >"$GROUPDEL_ATTEMPT"
    return 73
  fi
  /bin/rm -f "$GROUP_STATE"
}
GETENT_BIN=fake_getent
ID_BIN=fake_id
PGREP_BIN=fake_pgrep
FIND_BIN=fake_find
USERDEL_BIN=fake_userdel
GROUPDEL_BIN=fake_groupdel

set +e
( set -e; retire_kvm_identity )
first_status=$?
set -e
[ "$first_status" -eq 73 ]
[ ! -e "$USER_STATE" ]
[ -e "$GROUP_STATE" ]

retire_kvm_identity
printf 'first-status:%s\\n' "$first_status" >>"$TRACE_FILE"
printf 'user-present:%s\\n' "$([ -e "$USER_STATE" ] && echo true || echo false)" \
  >>"$TRACE_FILE"
printf 'group-present:%s\\n' "$([ -e "$GROUP_STATE" ] && echo true || echo false)" \
  >>"$TRACE_FILE"
cat "$TRACE_FILE"
`, {
      TRACE_FILE: trace,
      USER_STATE: userState,
      GROUP_STATE: groupState,
      GROUPDEL_ATTEMPT: groupdelAttempt,
    });

    expect(output).toContain('first-status:73');
    expect(output).toContain('userdel:nexus-drill-vm');
    expect(output.match(/groupdel:nexus-drill-vm/g)).toHaveLength(2);
    expect(output).toContain('process-audit:-u 993');
    expect(output).toContain('ownership-audit:/');
    expect(output).toContain('ownership-audit:/run');
    expect(output).toContain('user-present:false');
    expect(output).toContain('group-present:false');
  });

  it('rejects stale supplementary KVM membership during orphan-group retry', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
fake_getent() {
  case "$1:$2" in
    passwd:nexus-drill-vm|passwd:993) return 2 ;;
    group:nexus-drill-vm|group:980)
      printf '%s\\n' "$RETIRED_KVM_GROUP_ENTRY"
      ;;
    group:kvm)
      printf 'kvm:x:993:libvirt-qemu,nexus-drill-vm\\n'
      ;;
    *) return 2 ;;
  esac
}
fake_pgrep() { return 1; }
fake_find() { return 0; }
fake_groupdel() {
  printf 'unexpected-groupdel\\n' >>"$TRACE_FILE"
}
GETENT_BIN=fake_getent
PGREP_BIN=fake_pgrep
FIND_BIN=fake_find
GROUPDEL_BIN=fake_groupdel
retire_kvm_identity
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'orphaned retired KVM supplementary membership remains',
    );
    expect(fs.existsSync(trace)).toBe(false);
  });

  it('rejects an orphaned KVM group with members before groupdel', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
fake_getent() {
  case "$1:$2" in
    passwd:nexus-drill-vm|passwd:993) return 2 ;;
    group:nexus-drill-vm|group:980)
      printf 'nexus-drill-vm:x:980:unexpected-member\\n'
      ;;
    *) return 2 ;;
  esac
}
fake_groupdel() {
  printf 'unexpected-groupdel\\n' >>"$TRACE_FILE"
}
GETENT_BIN=fake_getent
GROUPDEL_BIN=fake_groupdel
retire_kvm_identity
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'orphaned retired KVM primary group differs from the audit',
    );
    expect(fs.existsSync(trace)).toBe(false);
  });

  it('resets only the exact stale prelayout recovery unit after disabling it', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
fake_systemctl() {
  case "$1" in
    show) printf 'loaded\\n' ;;
    disable|reset-failed) printf '%s\\n' "$*" >>"$TRACE_FILE" ;;
    *) return 1 ;;
  esac
}
SYSTEMCTL_BIN=fake_systemctl
disable_legacy_unit nexus-rollback-drill-v4-prelayout-staging-recovery.service
disable_legacy_unit nexus-release-layout-recovery.service
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });

    expect(output.trim().split('\n')).toEqual([
      'disable --now nexus-rollback-drill-v4-prelayout-staging-recovery.service',
      'reset-failed nexus-rollback-drill-v4-prelayout-staging-recovery.service',
      'disable --now nexus-release-layout-recovery.service',
    ]);
  });

  it('fails closed when active systemd service inventory cannot be queried', () => {
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
fake_systemctl() {
  [ "$1" = list-units ] || return 1
  return 69
}
SYSTEMCTL_BIN=fake_systemctl
assert_no_active_legacy_transaction
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot inventory active systemd services');
  });

  it('fails closed when a legacy unit load-state query fails', () => {
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
fake_systemctl() {
  [ "$1" = show ] || return 1
  return 69
}
SYSTEMCTL_BIN=fake_systemctl
disable_legacy_unit nexus-release-layout-recovery.service
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'cannot determine legacy unit load state: nexus-release-layout-recovery.service',
    );
  });

  it('clears the exact stale prelayout failure cache after its unit file is gone', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
fake_systemctl() {
  case "$1" in
    show) printf 'not-found\\n' ;;
    reset-failed) printf '%s\\n' "$*" >>"$TRACE_FILE" ;;
    disable) printf 'unexpected-disable\\n' >>"$TRACE_FILE" ;;
    *) return 1 ;;
  esac
}
SYSTEMCTL_BIN=fake_systemctl
disable_legacy_unit nexus-rollback-drill-v4-prelayout-staging-recovery.service
disable_legacy_unit nexus-release-layout-recovery.service
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });

    expect(output.trim().split('\n')).toEqual([
      'reset-failed nexus-rollback-drill-v4-prelayout-staging-recovery.service',
    ]);
  });

  it('allows inverse legacy ordering before handoff on an otherwise audited canonical PM2 unit', () => {
    const root = temporaryRoot();
    const unitFile = path.join(root, 'pm2-dominguez.service');
    fs.writeFileSync(unitFile, '[Service]\n');
    const output = runHarness(`
CANONICAL_PM2_UNIT_FILE="$UNIT_FILE"
fake_stat() { printf 'root:root:644\\n'; }
fake_systemctl() {
  case "$1" in
    is-enabled) printf 'enabled\\n' ;;
    show)
      local property="\${2#--property=}"
      case "$property" in
        LoadState) printf 'loaded\\n' ;;
        UnitFileState) printf 'enabled\\n' ;;
        FragmentPath) printf '%s\\n' "$CANONICAL_PM2_UNIT_FILE" ;;
        Type) printf 'forking\\n' ;;
        User) printf 'dominguez\\n' ;;
        Group|DropInPaths|ExecCondition|ExecStartPre|Wants|Requisite|BindsTo|PartOf)
          printf '\\n'
          ;;
        PIDFile) printf '%s/pm2.pid\\n' "$PM2_HOME" ;;
        RemainAfterExit) printf 'no\\n' ;;
        Restart) printf 'on-failure\\n' ;;
        WantedBy) printf 'multi-user.target\\n' ;;
        Environment) printf 'PATH=/usr/bin PM2_HOME=%s\\n' "$PM2_HOME" ;;
        Requires) printf 'sysinit.target system.slice\\n' ;;
        After) printf 'network.target nexus-release-layout-recovery.service\\n' ;;
        Before) printf 'nexus-rollback-drill-recovery.service\\n' ;;
        ExecStart)
          printf '{ path=%s ; argv[]=%s resurrect ; ignore_errors=no ; status=0/0 }\\n' \
            "$CANONICAL_PM2_EXEC" "$CANONICAL_PM2_EXEC"
          ;;
        ExecReload)
          printf '{ path=%s ; argv[]=%s reload all ; ignore_errors=no ; status=0/0 }\\n' \
            "$CANONICAL_PM2_EXEC" "$CANONICAL_PM2_EXEC"
          ;;
        ExecStop)
          printf '{ path=%s ; argv[]=%s kill ; ignore_errors=no ; status=0/0 }\\n' \
            "$CANONICAL_PM2_EXEC" "$CANONICAL_PM2_EXEC"
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}
STAT_BIN=fake_stat
SYSTEMCTL_BIN=fake_systemctl
assert_canonical_pm2_unit_ready
printf 'canonical-ready\\n'
`, { UNIT_FILE: unitFile });

    expect(output.trim()).toBe('canonical-ready');
  });

  it.each(['After', 'Before'] as const)(
    'rejects legacy %s ordering residue during the final canonical PM2 audit',
    (residueProperty) => {
      const result = spawnSync(
        'bash',
        ['-c', `
source "$RETIREMENT_SCRIPT"
systemctl_value() {
  [ "$2" = "$RESIDUE_PROPERTY" ] \
    && printf 'network.target nexus-release-layout-recovery.service\\n' \
    || printf 'shutdown.target\\n'
}
assert_no_legacy_pm2_ordering
`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            RETIREMENT_SCRIPT: retirementScript,
            RESIDUE_PROPERTY: residueProperty,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('still has legacy ordering references');
    },
  );

  it('rejects a canonical PM2 unit with a remaining legacy dependency', () => {
    const root = temporaryRoot();
    const unitFile = path.join(root, 'pm2-dominguez.service');
    fs.writeFileSync(unitFile, '[Service]\n');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
CANONICAL_PM2_UNIT_FILE="$UNIT_FILE"
fake_stat() { printf 'root:root:644\\n'; }
fake_enabled() { printf 'enabled\\n'; }
SYSTEMCTL_BIN=fake_enabled
STAT_BIN=fake_stat
systemctl_value() {
  case "$2" in
    LoadState) printf 'loaded\\n' ;;
    UnitFileState) printf 'enabled\\n' ;;
    FragmentPath) printf '%s\\n' "$CANONICAL_PM2_UNIT_FILE" ;;
    Type) printf 'forking\\n' ;;
    User) printf 'dominguez\\n' ;;
    Group|DropInPaths|ExecCondition|ExecStartPre|Wants|Requisite|BindsTo|PartOf|Before)
      printf '\\n'
      ;;
    PIDFile) printf '%s/pm2.pid\\n' "$PM2_HOME" ;;
    RemainAfterExit) printf 'no\\n' ;;
    Restart) printf 'on-failure\\n' ;;
    WantedBy) printf 'multi-user.target\\n' ;;
    Environment) printf 'PM2_HOME=%s\\n' "$PM2_HOME" ;;
    Requires) printf 'nexus-release-layout-install-recovery.service\\n' ;;
    After) printf 'network.target\\n' ;;
    *) printf '\\n' ;;
  esac
}
assert_canonical_pm2_unit_ready
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          UNIT_FILE: unitFile,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('still depends on legacy release machinery');
  });

  it('keeps dry-run free of retirement mutations and reports a required handoff', () => {
    const output = runHarness(`
MODE=dry-run
LEGACY_DROP_INS=(/fixture/missing-drop-in)
LEGACY_DEPENDENCY_LINKS=(/fixture/missing-dependency)
LEGACY_HELPERS=(/fixture/missing-helper)
LEGACY_STATE=(/fixture/missing-state)
LEGACY_UNITS=(missing.service)
acquire_retirement_locks() { :; }
validate_production_gate() {
  PRODUCTION_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  PRODUCTION_DIGEST=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
}
assert_runtime_health() {
  PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
}
assert_no_active_legacy_transaction() { :; }
validate_retired_kvm_identity() { RETIRED_KVM_IDENTITY_PRESENT=false; }
remove_allowlisted_path() { echo MUTATION >&2; return 99; }
disable_legacy_unit() { echo MUTATION >&2; return 99; }
handoff_pm2_authority() { echo MUTATION >&2; return 99; }
fake_systemctl() {
  [ "$1" = show ] || return 1
  printf 'not-found\\n'
}
SYSTEMCTL_BIN=fake_systemctl
run_retirement
`);

    expect(output).not.toContain('MUTATION');
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      mode: 'dry-run',
      planned: 0,
      pm2Authority: 'nexus-release-pm2-recovery-daemon.service',
      handoffRequired: true,
    });
  });

  it('fails closed when planning cannot query a legacy unit load state', () => {
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
MODE=dry-run
LEGACY_DROP_INS=(/fixture/missing-drop-in)
LEGACY_DEPENDENCY_LINKS=(/fixture/missing-dependency)
LEGACY_HELPERS=(/fixture/missing-helper)
LEGACY_STATE=(/fixture/missing-state)
LEGACY_UNITS=(query-failure.service)
assert_detached_systemd_transaction() { :; }
acquire_retirement_locks() { :; }
validate_production_gate() {
  PRODUCTION_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  PRODUCTION_DIGEST=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
}
assert_runtime_health() {
  PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"
}
assert_no_active_legacy_transaction() { :; }
validate_retired_kvm_identity() { RETIRED_KVM_IDENTITY_PRESENT=false; }
fake_systemctl() {
  [ "$1" = show ] || return 1
  return 69
}
SYSTEMCTL_BIN=fake_systemctl
run_retirement
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'cannot determine legacy unit load state while planning: query-failure.service',
    );
  });

  it('removes blockers before handing authority to canonical PM2', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
MODE=apply
LEGACY_DROP_INS=(/fixture/drop-in)
LEGACY_DEPENDENCY_LINKS=(/fixture/dependency)
LEGACY_HELPERS=(/fixture/helper)
LEGACY_STATE=(/fixture/state)
LEGACY_UNITS=(legacy.service)
assert_detached_systemd_transaction() {
  printf 'detached\\n' >>"$TRACE_FILE"
}
acquire_retirement_locks() {
  printf 'locks\\n' >>"$TRACE_FILE"
}
validate_production_gate() {
  PRODUCTION_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  PRODUCTION_DIGEST=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
}
assert_runtime_health() {
  printf 'health:%s\\n' "\${1:-any}" >>"$TRACE_FILE"
  [ -n "\${1:-}" ] || PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
}
wait_runtime_health() { assert_runtime_health "$1"; }
assert_no_active_legacy_transaction() { :; }
validate_retired_kvm_identity() {
  RETIRED_KVM_IDENTITY_PRESENT=false
  printf 'kvm-identity-audit\\n' >>"$TRACE_FILE"
}
retire_kvm_identity() {
  printf 'kvm-identity-retired\\n' >>"$TRACE_FILE"
}
path_exists() { return 0; }
remove_allowlisted_path() { printf 'remove:%s\\n' "$1" >>"$TRACE_FILE"; }
disable_legacy_unit() { printf 'disable:%s\\n' "$1" >>"$TRACE_FILE"; }
rmdir() { printf 'rmdir\\n' >>"$TRACE_FILE"; }
prepare_pm2_blocker_backup() { printf 'backup\\n' >>"$TRACE_FILE"; }
restore_pm2_blocker_backup() { printf 'restore-blockers\\n' >>"$TRACE_FILE"; }
discard_pm2_blocker_backup() { printf 'discard-backup\\n' >>"$TRACE_FILE"; }
arm_pm2_blocker_guard() { printf 'arm-guard\\n' >>"$TRACE_FILE"; }
disarm_pm2_blocker_guard() { printf 'disarm-guard\\n' >>"$TRACE_FILE"; }
assert_canonical_pm2_unit_ready() {
  printf 'canonical-audit\\n' >>"$TRACE_FILE"
}
assert_no_legacy_pm2_ordering() {
  printf 'final-ordering-audit\\n' >>"$TRACE_FILE"
}
refresh_pm2_authority() {
  PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"
  printf 'refresh:%s\\n' "$PM2_AUTHORITY_UNIT" >>"$TRACE_FILE"
}
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  if [ "$1" = show ]; then printf 'loaded\\n'; fi
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
run_retirement
printf '%s\\n' TRACE
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });
    const traceOutput = output.split('TRACE\n')[1].trim().split('\n');

    expect(traceOutput.indexOf('remove:/fixture/drop-in')).toBeLessThan(
      traceOutput.indexOf(`systemctl:stop nexus-release-pm2-recovery-daemon.service`),
    );
    expect(traceOutput.indexOf('canonical-audit')).toBeLessThan(
      traceOutput.indexOf(`systemctl:stop nexus-release-pm2-recovery-daemon.service`),
    );
    expect(traceOutput.indexOf(`systemctl:start pm2-dominguez.service`)).toBeLessThan(
      traceOutput.indexOf('disable:legacy.service'),
    );
    expect(traceOutput.lastIndexOf('systemctl:daemon-reload')).toBeLessThan(
      traceOutput.indexOf('final-ordering-audit'),
    );
    expect(traceOutput.indexOf('remove:/etc/systemd/system/legacy.service')).toBeLessThan(
      traceOutput.indexOf('final-ordering-audit'),
    );
    expect(traceOutput).toContain('health:pm2-dominguez.service');
    expect(output).toContain('"mode":"apply"');
  });

  it('restores the first real blocker when removing the second blocker fails', () => {
    const root = temporaryRoot();
    const blockerRoot = path.join(root, 'blockers');
    const first = path.join(root, 'first.conf');
    const second = path.join(root, 'second.conf');
    const trace = path.join(root, 'trace');
    fs.mkdirSync(blockerRoot, { mode: 0o700 });
    fs.writeFileSync(first, 'first\n');
    fs.writeFileSync(second, 'second\n');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
LEGACY_DROP_INS=("$FIRST_BLOCKER" "$SECOND_BLOCKER")
LEGACY_DEPENDENCY_LINKS=("$MISSING_BLOCKER")
PM2_BLOCKER_BACKUP_ROOT="$BLOCKER_ROOT"
fake_stat() {
  case "$*" in
    *%U:%G:%a*) printf 'root:root:700\\n' ;;
    *) printf '0:0:644:regular\\ file\\n' ;;
  esac
}
fake_systemctl() {
  [ "$1" = daemon-reload ] || return 1
  printf 'daemon-reload\\n' >>"$TRACE_FILE"
}
STAT_BIN=fake_stat
SYSTEMCTL_BIN=fake_systemctl
rm() {
  local candidate="\${!#}"
  if [ "$candidate" = "$SECOND_BLOCKER" ]; then
    printf 'second-removal-failed\\n' >>"$TRACE_FILE"
    return 73
  fi
  /bin/rm "$@"
}
prepare_pm2_blocker_backup
arm_pm2_blocker_guard
for blocker in "\${LEGACY_DROP_INS[@]}"; do
  remove_allowlisted_path "$blocker"
done
exit 91
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          BLOCKER_ROOT: blockerRoot,
          FIRST_BLOCKER: first,
          SECOND_BLOCKER: second,
          MISSING_BLOCKER: path.join(root, 'missing.conf'),
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status, result.stderr).toBe(73);
    expect(fs.readFileSync(first, 'utf8')).toBe('first\n');
    expect(fs.readFileSync(second, 'utf8')).toBe('second\n');
    expect(fs.readFileSync(trace, 'utf8')).toContain('second-removal-failed');
    expect(fs.readFileSync(trace, 'utf8')).toContain('daemon-reload');
    expect(fs.existsSync(blockerRoot)).toBe(false);
  });

  it.each([
    {
      name: 'refresh fails',
      refreshStatus: '71',
      refreshedAuthority: 'canonical',
    },
    {
      name: 'refresh reports temporary authority',
      refreshStatus: '0',
      refreshedAuthority: 'temporary',
    },
  ])('fails an already-canonical handoff when $name', ({
    refreshStatus,
    refreshedAuthority,
  }) => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"
refresh_pm2_authority() {
  printf 'refresh\\n' >>"$TRACE_FILE"
  [ "$REFRESH_STATUS" -eq 0 ] || return "$REFRESH_STATUS"
  if [ "$REFRESHED_AUTHORITY" = canonical ]; then
    PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"
  else
    PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
  fi
}
handoff_pm2_authority
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          TRACE_FILE: trace,
          REFRESH_STATUS: refreshStatus,
          REFRESHED_AUTHORITY: refreshedAuthority,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(trace, 'utf8').trim()).toBe('refresh');
  });

  it.each([
    {
      name: 'refresh fails',
      refreshStatus: '72',
      refreshedAuthority: 'canonical',
    },
    {
      name: 'refresh reports temporary authority',
      refreshStatus: '0',
      refreshedAuthority: 'temporary',
    },
  ])('rejects canonical handoff completion when $name', ({
    refreshStatus,
    refreshedAuthority,
  }) => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
wait_runtime_health() {
  printf 'health:%s\\n' "$1" >>"$TRACE_FILE"
  [ "$1" = "$CANONICAL_PM2_UNIT" ]
}
refresh_pm2_authority() {
  printf 'refresh\\n' >>"$TRACE_FILE"
  [ "$REFRESH_STATUS" -eq 0 ] || return "$REFRESH_STATUS"
  if [ "$REFRESHED_AUTHORITY" = canonical ]; then
    PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"
  else
    PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
  fi
}
recover_temporary_pm2_authority() {
  printf 'bounded-recovery\\n' >>"$TRACE_FILE"
  return 1
}
if handoff_pm2_authority; then
  exit 91
fi
cat "$TRACE_FILE"
`, {
      TRACE_FILE: trace,
      REFRESH_STATUS: refreshStatus,
      REFRESHED_AUTHORITY: refreshedAuthority,
    });

    expect(output).toContain(`systemctl:stop nexus-release-pm2-recovery-daemon.service`);
    expect(output).toContain('systemctl:start pm2-dominguez.service');
    expect(output).toContain('health:pm2-dominguez.service');
    expect(output).toContain('refresh');
    expect(output).toContain('bounded-recovery');
  });

  it('restores temporary PM2 authority and aborts when canonical health fails', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  if [ "$1" = show ]; then
    case "$2" in
      --property=ActiveState) printf 'inactive\\n' ;;
      --property=MainPID) printf '0\\n' ;;
      *) return 1 ;;
    esac
  fi
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
assert_runtime_health() {
  printf 'health:%s\\n' "$1" >>"$TRACE_FILE"
  [ "$1" != "$CANONICAL_PM2_UNIT" ]
}
wait_runtime_health() { assert_runtime_health "$1"; }
resurrect_temporary_pm2() {
  printf 'resurrect:%s\\n' "$TEMPORARY_PM2_UNIT" >>"$TRACE_FILE"
}
refresh_pm2_authority() {
  PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
  printf 'refresh:%s\\n' "$PM2_AUTHORITY_UNIT" >>"$TRACE_FILE"
}
if handoff_pm2_authority; then
  exit 91
fi
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });

    expect(output).toContain(`systemctl:start pm2-dominguez.service`);
    expect(output).toContain(`resurrect:nexus-release-pm2-recovery-daemon.service`);
    expect(output).toContain(`health:nexus-release-pm2-recovery-daemon.service`);
    expect(output).toContain(`refresh:nexus-release-pm2-recovery-daemon.service`);
  });

  it('keeps temporary PM2 stopped when canonical authority remains healthy', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  if [ "$1" = show ]; then
    case "$2" in
      --property=ActiveState) printf 'active\\n' ;;
      --property=MainPID) printf '1234\\n' ;;
      *) return 1 ;;
    esac
  fi
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
wait_runtime_health() {
  printf 'health:%s\\n' "$1" >>"$TRACE_FILE"
  [ "$1" = "$CANONICAL_PM2_UNIT" ]
}
refresh_pm2_authority() {
  PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"
  printf 'refresh:%s\\n' "$PM2_AUTHORITY_UNIT" >>"$TRACE_FILE"
}
resurrect_temporary_pm2() {
  printf 'unexpected-temporary-start\\n' >>"$TRACE_FILE"
  return 91
}
recover_temporary_pm2_authority
printf 'authority:%s\\n' "$PM2_AUTHORITY_UNIT" >>"$TRACE_FILE"
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });

    expect(output).toContain('health:pm2-dominguez.service');
    expect(output).toContain('authority:pm2-dominguez.service');
    expect(output).not.toContain('unexpected-temporary-start');
  });

  it('waits for deactivating canonical PM2 to become inactive before temporary recovery', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const state = path.join(root, 'state');
    fs.writeFileSync(state, '0\n');
    const output = runHarness(`
SECONDS=0
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  if [ "$1" = show ]; then
    case "$2" in
      --property=ActiveState)
        state_checks=$(cat "$RECOVERY_STATE_FILE")
        state_checks=$((state_checks + 1))
        printf '%s\\n' "$state_checks" >"$RECOVERY_STATE_FILE"
        if [ "$state_checks" -eq 1 ]; then
          printf 'deactivating\\n'
        else
          printf 'inactive\\n'
        fi
        ;;
      --property=MainPID)
        state_checks=$(cat "$RECOVERY_STATE_FILE")
        if [ "$state_checks" -eq 1 ]; then
          printf '1234\\n'
        else
          printf '0\\n'
        fi
        ;;
      *) return 1 ;;
    esac
  fi
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
sleep() {
  printf 'sleep:%s\\n' "$1" >>"$TRACE_FILE"
  SECONDS=$((SECONDS + $1))
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
resurrect_temporary_pm2() {
  printf 'resurrect:%s\\n' "$TEMPORARY_PM2_UNIT" >>"$TRACE_FILE"
}
wait_runtime_health() {
  printf 'health:%s\\n' "$1" >>"$TRACE_FILE"
  [ "$1" = "$TEMPORARY_PM2_UNIT" ]
}
refresh_pm2_authority() {
  PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
  printf 'refresh:%s\\n' "$PM2_AUTHORITY_UNIT" >>"$TRACE_FILE"
}
recover_temporary_pm2_authority
cat "$TRACE_FILE"
`, { TRACE_FILE: trace, RECOVERY_STATE_FILE: state });

    expect(output).toContain('sleep:1');
    expect(output).toContain(
      'resurrect:nexus-release-pm2-recovery-daemon.service',
    );
    expect(output).toContain(
      'health:nexus-release-pm2-recovery-daemon.service',
    );
    expect(output).toContain(
      'refresh:nexus-release-pm2-recovery-daemon.service',
    );
  });

  it('does not launch temporary PM2 while canonical state remains ambiguous', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
SECONDS=0
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  if [ "$1" = show ]; then
    case "$2" in
      --property=ActiveState) printf 'deactivating\\n' ;;
      --property=MainPID) printf '1234\\n' ;;
      *) return 1 ;;
    esac
  fi
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
sleep() {
  printf 'sleep:%s\\n' "$1" >>"$TRACE_FILE"
  SECONDS=$((SECONDS + $1))
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
wait_runtime_health() {
  printf 'health:%s\\n' "$1" >>"$TRACE_FILE"
  return 1
}
resurrect_temporary_pm2() {
  printf 'unexpected-temporary-start\\n' >>"$TRACE_FILE"
  return 91
}
recover_temporary_pm2_authority
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'canonical PM2 state remained ambiguous; temporary supervisor was not started',
    );
    expect(fs.readFileSync(trace, 'utf8')).not.toContain(
      'unexpected-temporary-start',
    );
    expect(fs.readFileSync(trace, 'utf8')).not.toContain(
      'health:pm2-dominguez.service',
    );
  });

  it('does not launch temporary PM2 when canonical state cannot be queried', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  [ "$1" != show ] || return 69
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  shift
  "$@"
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
resurrect_temporary_pm2() {
  printf 'unexpected-temporary-start\\n' >>"$TRACE_FILE"
  return 91
}
recover_temporary_pm2_authority
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(trace, 'utf8')).not.toContain(
      'unexpected-temporary-start',
    );
  });

  it('caps sequential runtime checks to one shared health budget', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
SECONDS=0
PRODUCTION_RELEASE=/production/releases/exact
PRODUCTION_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PRODUCTION_DIGEST=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
refresh_pm2_authority() { PM2_AUTHORITY_UNIT="$CANONICAL_PM2_UNIT"; }
realpath() {
  case "$3" in
    "$CURRENT_LINK") printf '%s\\n' "$PRODUCTION_RELEASE" ;;
    "$STAGING_CURRENT_LINK") printf '/staging/releases/exact\\n' ;;
    *) return 1 ;;
  esac
}
read_role_identity() {
  printf '/staging/releases/exact\\t%s\\t%s\\n' \
    "$PRODUCTION_SHA" "$PRODUCTION_DIGEST"
}
fake_curl() {
  local previous="" timeout=""
  for argument in "$@"; do
    [ "$previous" != --max-time ] || timeout="$argument"
    previous="$argument"
  done
  printf 'curl-timeout:%s\\n' "$timeout" >>"$TRACE_FILE"
  SECONDS=$((SECONDS + timeout))
}
capture_and_validate_live_pm2() {
  printf 'unexpected-pm2-snapshot\\n' >>"$TRACE_FILE"
}
assert_resurrection_dump() { :; }
CURL_BIN=fake_curl
assert_runtime_health "$CANONICAL_PM2_UNIT" 5
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          TRACE_FILE: trace,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'runtime health budget expired before staging backend',
    );
    expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      'curl-timeout:3',
      'curl-timeout:2',
    ]);
  });

  it('returns after the first successful bounded health attempt', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
SECONDS=0
assert_runtime_health() {
  printf 'attempt:%s:%s\\n' "$1" "$2" >>"$TRACE_FILE"
}
wait_runtime_health "$CANONICAL_PM2_UNIT" 5
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });

    expect(output.trim().split('\n')).toEqual([
      'attempt:pm2-dominguez.service:5',
    ]);
  });

  it('runs bounded exact temporary recovery when stopping it times out', () => {
    const root = temporaryRoot();
    const trace = path.join(root, 'trace');
    const output = runHarness(`
PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
fake_systemctl() {
  printf 'systemctl:%s\\n' "$*" >>"$TRACE_FILE"
  if [ "$1" = show ]; then
    case "$2" in
      --property=ActiveState) printf 'inactive\\n' ;;
      --property=MainPID) printf '0\\n' ;;
      *) return 1 ;;
    esac
  fi
}
fake_timeout() {
  [ "$1" != --foreground ] || shift
  local budget="$1"
  shift
  printf 'timeout:%s:%s\\n' "$budget" "$*" >>"$TRACE_FILE"
  if [ "\${1:-}" = fake_systemctl ] \
      && [ "\${2:-}" = stop ] \
      && [ "\${3:-}" = "$TEMPORARY_PM2_UNIT" ]; then
    return 124
  fi
  "$@"
}
SYSTEMCTL_BIN=fake_systemctl
TIMEOUT_BIN=fake_timeout
resurrect_temporary_pm2() {
  printf 'resurrect:%s\\n' "$TEMPORARY_PM2_UNIT" >>"$TRACE_FILE"
}
wait_runtime_health() {
  printf 'health:%s:%s\\n' "$1" "$2" >>"$TRACE_FILE"
  [ "$1" = "$TEMPORARY_PM2_UNIT" ]
}
refresh_pm2_authority() {
  PM2_AUTHORITY_UNIT="$TEMPORARY_PM2_UNIT"
  printf 'refresh:%s\\n' "$PM2_AUTHORITY_UNIT" >>"$TRACE_FILE"
}
if handoff_pm2_authority; then
  exit 91
fi
cat "$TRACE_FILE"
`, { TRACE_FILE: trace });

    expect(output).toContain(
      `timeout:10s:fake_systemctl stop nexus-release-pm2-recovery-daemon.service`,
    );
    expect(output).toContain('resurrect:nexus-release-pm2-recovery-daemon.service');
    expect(output).toContain(
      'health:nexus-release-pm2-recovery-daemon.service:15',
    );
    expect(output).toContain('refresh:nexus-release-pm2-recovery-daemon.service');
    expect(output).not.toContain('systemctl:start pm2-dominguez.service');
  });

  it('rejects a dump whose artifact identity differs from the exact release', () => {
    const root = temporaryRoot();
    const inventory = path.join(root, 'dump.json');
    const production = '/production/releases/exact';
    const staging = '/staging/releases/exact';
    const sha = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    const rows = [
      ['nexus-hub', production],
      ['content-engine', `${production}/content-engine`],
      ['nexus-hub-staging', staging],
      ['content-engine-staging', `${staging}/content-engine`],
    ].map(([name, cwd], index) => ({
      name,
      pm_cwd: cwd,
      NEXUS_RELEASE_SHA: sha,
      NEXUS_RELEASE_ARTIFACT_SHA256: index === 0 ? 'c'.repeat(64) : digest,
    }));
    fs.writeFileSync(inventory, `${JSON.stringify(rows)}\n`);
    const result = spawnSync(
      'bash',
      ['-c', `
source "$RETIREMENT_SCRIPT"
validate_pm2_inventory "$INVENTORY" dump \
  "$PRODUCTION_RELEASE" "$SHA" "$DIGEST" \
  "$STAGING_RELEASE" "$SHA" "$DIGEST"
`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RETIREMENT_SCRIPT: retirementScript,
          INVENTORY: inventory,
          PRODUCTION_RELEASE: production,
          STAGING_RELEASE: staging,
          SHA: sha,
          DIGEST: digest,
        },
      },
    );

    expect(result.status).not.toBe(0);
  });
});
