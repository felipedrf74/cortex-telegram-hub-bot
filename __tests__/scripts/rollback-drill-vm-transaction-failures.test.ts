import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installerSource = readFileSync(
  resolve('scripts/rollback-drill-vm-systemd-install.sh'),
  'utf8',
);
const provisionerSource = readFileSync(
  resolve('scripts/rollback-drill-vm-provision.sh'),
  'utf8',
);

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'nexus-rollback-drill-transaction-')),
  );
  temporaryRoots.push(root);
  return root;
}

function extractShellFunction(source: string, name: string): string {
  const marker = `${name}() {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing shell function: ${name}`);
  const tail = source.slice(start);
  const close = /^}$/m.exec(tail);
  if (!close) throw new Error(`unterminated shell function: ${name}`);
  return tail.slice(0, close.index + close[0].length);
}

const portableShellPrelude = String.raw`
set -euo pipefail

fsync_path() {
  return 0
}

systemctl() {
  return 0
}

userdel() {
  return 0
}

groupdel() {
  return 0
}

realpath() {
  if [ "$#" -gt 0 ] && [ "$1" = "-m" ]; then
    shift
  fi
  if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
    shift
  fi
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

mv() {
  local force=false
  local injection_marker="$TEST_ROOT/.first-move-failure-injected"
  if [ "$#" -gt 0 ] && [ "$1" = "-fT" ]; then
    force=true
    shift
  elif [ "$#" -gt 0 ] && [ "$1" = "-T" ]; then
    shift
  fi
  if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
    shift
  fi
  if [ "$INJECT_FIRST_MOVE_FAILURE" = true ] \
      && [ ! -e "$injection_marker" ]; then
    : >"$injection_marker"
    return 1
  fi
  if [ "$force" = true ]; then
    command mv -f "$@"
  else
    command mv "$@"
  fi
}

rm() {
  local recursive=false
  local force=false
  if [ "$#" -gt 0 ] && [ "$1" = "-rf" ]; then
    recursive=true
    force=true
    shift
  elif [ "$#" -gt 0 ] && [ "$1" = "-f" ]; then
    force=true
    shift
  fi
  if [ "$#" -gt 0 ] && [ "$1" = "--one-file-system" ]; then
    shift
  fi
  if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
    shift
  fi
  if [ "$FAIL_ACTIVE_REMOVE" = true ]; then
    local candidate
    for candidate in "$@"; do
      if [ "$candidate" = "$ACTIVE_RECEIPT" ]; then
        return 1
      fi
    done
  fi
  if [ "$recursive" = true ]; then
    command rm -rf "$@"
  elif [ "$force" = true ]; then
    command rm -f "$@"
  else
    command rm "$@"
  fi
}
`;

const installerRollbackFunctions = [
  extractShellFunction(installerSource, 'durable_remove'),
  extractShellFunction(installerSource, 'cleanup_install'),
  extractShellFunction(installerSource, 'commit_asset'),
].join('\n\n');

const provisionRollbackFunctions = [
  extractShellFunction(provisionerSource, 'safe_remove_tree'),
  extractShellFunction(provisionerSource, 'cleanup_transaction'),
].join('\n\n');

const installerHarness = String.raw`
STATE_ROOT="$TEST_ROOT/state"
INSTALL_JOURNAL="$STATE_ROOT/install-in-progress.v1"
CONTROL_LOCK="$STATE_ROOT/control.lock"
EXPECTED_USER=nexus-drill-vm
mkdir -p "$STATE_ROOT" "$TEST_ROOT/target"
printf 'journal\n' >"$INSTALL_JOURNAL"

target="$TEST_ROOT/target/asset"
stage="$TEST_ROOT/target/.stage"
printf 'new\n' >"$stage"
sources=()
targets=("$target")
modes=(0755)
source_digests=()
stage_paths=("$stage")
backup_paths=()
committed_indices=()
user_created=false
group_created=false
journal_armed=true
install_succeeded=false
rollback_abandoned=false
state_existed=true
libexec_existed=true
runtime_dir_existed=true

case "$SCENARIO" in
  existing|move-failure|missing-backup)
    printf 'old\n' >"$target"
    had_targets=(true)
    ;;
  new)
    had_targets=(false)
    ;;
  *)
    exit 64
    ;;
esac

trap cleanup_install EXIT
commit_asset 0
if [ "$SCENARIO" = missing-backup ]; then
  for backup in "$TEST_ROOT"/target/.nexus-rollback-drill-vm.backup.*; do
    command rm -f "$backup"
  done
fi
exit 42
`;

const provisionHarness = String.raw`
STATE_ROOT="$TEST_ROOT/state"
BASE_DIR="$STATE_ROOT/base"
SETS_DIR="$STATE_ROOT/sets"
ACTIVE_RECEIPT="$STATE_ROOT/active.json"
PROVISION_JOURNAL="$STATE_ROOT/provision-in-progress.v1"
mkdir -p "$BASE_DIR" "$SETS_DIR"
printf 'journal\n' >"$PROVISION_JOURNAL"

download_dir="$STATE_ROOT/.download.case"
mkdir -p "$download_dir"
printf 'download\n' >"$download_dir/input"
set_stage=""
set_target="$SETS_DIR/set-id"
active_stage=""
base_stage=""
journal_stage=""
base_target="$BASE_DIR/base.qcow2"
base_installed=false
set_committed=false
active_committed=false
journal_armed=true
transaction_succeeded=false

case "$SCENARIO" in
  base)
    printf 'base\n' >"$base_target"
    base_installed=true
    ;;
  staged-set)
    printf 'base\n' >"$base_target"
    base_installed=true
    set_stage="$SETS_DIR/.stage.case"
    mkdir -p "$set_stage"
    printf 'overlay\n' >"$set_stage/root.qcow2"
    ;;
  committed-set)
    printf 'base\n' >"$base_target"
    base_installed=true
    mkdir -p "$set_target"
    printf 'overlay\n' >"$set_target/root.qcow2"
    set_committed=true
    ;;
  active)
    printf 'base\n' >"$base_target"
    base_installed=true
    mkdir -p "$set_target"
    printf 'overlay\n' >"$set_target/root.qcow2"
    set_committed=true
    printf 'active\n' >"$ACTIVE_RECEIPT"
    active_committed=true
    ;;
  unsafe-set-target)
    set_target="$TEST_ROOT/outside-set"
    mkdir -p "$set_target"
    printf 'outside\n' >"$set_target/sentinel"
    set_committed=true
    ;;
  *)
    exit 64
    ;;
esac

trap cleanup_transaction EXIT
exit 42
`;

function runHarness(
  root: string,
  functions: string,
  harness: string,
  {
    scenario,
    injectFirstMoveFailure = false,
    failActiveRemove = false,
  }: {
    scenario: string;
    injectFirstMoveFailure?: boolean;
    failActiveRemove?: boolean;
  },
) {
  return spawnSync(
    'bash',
    ['-c', [portableShellPrelude, functions, harness].join('\n\n')],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_ROOT: root,
        SCENARIO: scenario,
        INJECT_FIRST_MOVE_FAILURE: String(injectFirstMoveFailure),
        FAIL_ACTIVE_REMOVE: String(failActiveRemove),
      },
    },
  );
}

describe('rollback-drill VM installer transaction failures', () => {
  it('restores an existing asset and removes the completed journal after a later failure', () => {
    const root = temporaryRoot();
    const result = runHarness(root, installerRollbackFunctions, installerHarness, {
      scenario: 'existing',
    });

    expect(result.status, result.stderr).toBe(42);
    expect(readFileSync(join(root, 'target', 'asset'), 'utf8')).toBe('old\n');
    expect(existsSync(join(root, 'state', 'install-in-progress.v1'))).toBe(false);
    expect(
      readdirSync(join(root, 'target')).some((name) =>
        name.startsWith('.nexus-rollback-drill-vm.backup.')),
    ).toBe(false);
  });

  it('removes a newly committed asset when a later install step fails', () => {
    const root = temporaryRoot();
    const result = runHarness(root, installerRollbackFunctions, installerHarness, {
      scenario: 'new',
    });

    expect(result.status, result.stderr).toBe(42);
    expect(existsSync(join(root, 'target', 'asset'))).toBe(false);
    expect(existsSync(join(root, 'state', 'install-in-progress.v1'))).toBe(false);
  });

  it('restores the predecessor when the asset rename itself is fault-injected', () => {
    const root = temporaryRoot();
    const result = runHarness(root, installerRollbackFunctions, installerHarness, {
      scenario: 'move-failure',
      injectFirstMoveFailure: true,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(join(root, 'target', 'asset'), 'utf8')).toBe('old\n');
    expect(existsSync(join(root, 'state', 'install-in-progress.v1'))).toBe(false);
  });

  it('retains the blocking journal when an asset backup cannot be restored', () => {
    const root = temporaryRoot();
    const result = runHarness(root, installerRollbackFunctions, installerHarness, {
      scenario: 'missing-backup',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('rollback incomplete; install journal remains');
    expect(readFileSync(join(root, 'target', 'asset'), 'utf8')).toBe('new\n');
    expect(existsSync(join(root, 'state', 'install-in-progress.v1'))).toBe(true);
  });
});

describe('rollback-drill VM provision transaction failures', () => {
  it.each([
    ['base', ['base/base.qcow2']],
    ['staged-set', ['base/base.qcow2', 'sets/.stage.case']],
    ['committed-set', ['base/base.qcow2', 'sets/set-id']],
    ['active', ['active.json', 'base/base.qcow2', 'sets/set-id']],
  ])(
    'rolls back the %s publication boundary and removes the journal',
    (scenario, removedPaths) => {
      const root = temporaryRoot();
      const result = runHarness(root, provisionRollbackFunctions, provisionHarness, {
        scenario,
      });

      expect(result.status, result.stderr).toBe(42);
      for (const relative of removedPaths) {
        expect(existsSync(join(root, 'state', relative))).toBe(false);
      }
      expect(existsSync(join(root, 'state', '.download.case'))).toBe(false);
      expect(existsSync(join(root, 'state', 'provision-in-progress.v1'))).toBe(false);
    },
  );

  it('retains active state and the journal when active-receipt removal is fault-injected', () => {
    const root = temporaryRoot();
    const result = runHarness(root, provisionRollbackFunctions, provisionHarness, {
      scenario: 'active',
      failActiveRemove: true,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('rollback incomplete; journal remains');
    expect(existsSync(join(root, 'state', 'active.json'))).toBe(true);
    expect(existsSync(join(root, 'state', 'provision-in-progress.v1'))).toBe(true);
  });

  it('never follows an out-of-scope set target during rollback and keeps the journal', () => {
    const root = temporaryRoot();
    const result = runHarness(root, provisionRollbackFunctions, provisionHarness, {
      scenario: 'unsafe-set-target',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('rollback incomplete; journal remains');
    expect(readFileSync(join(root, 'outside-set', 'sentinel'), 'utf8')).toBe('outside\n');
    expect(existsSync(join(root, 'state', 'provision-in-progress.v1'))).toBe(true);
  });
});
