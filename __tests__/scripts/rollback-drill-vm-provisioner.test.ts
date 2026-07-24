import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const manifestHelper = resolve('scripts/rollback-drill-vm-manifest.py');
const installer = read('scripts/rollback-drill-vm-systemd-install.sh');
const provisioner = read('scripts/rollback-drill-vm-provision.sh');
const runner = read('scripts/rollback-drill-vm-run.sh');
const hostPreflight = read('scripts/rollback-drill-vm-host-preflight.sh');
const unit = read(
  'ops/rollback-drill-vm/systemd/nexus-rollback-drill-vm@.service',
);
const tmpfiles = read('ops/rollback-drill-vm/nexus-rollback-drill-vm.tmpfiles');
const operations = read('ops/rollback-drill-vm/OPERATIONS.txt');
const releaseRunbook = read('docs/release/README.md');

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-rollback-drill-vm-'));
  chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

describe('rollback-drill KVM provisioner', () => {
  it('selects exactly one owner-reviewed image from a strict signed-manifest payload', () => {
    const root = temporaryRoot();
    const targetDigest = 'a'.repeat(64);
    const sums = join(root, 'SHA256SUMS');
    writeFileSync(
      sums,
      [
        `${'b'.repeat(64)}  noble-server-cloudimg-arm64.img`,
        `${targetDigest} *noble-server-cloudimg-amd64.img`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const selected = spawnSync(
      'python3',
      [
        manifestHelper,
        '--checksums',
        sums,
        '--filename',
        'noble-server-cloudimg-amd64.img',
        '--expected-sha256',
        targetDigest,
      ],
      { encoding: 'utf8' },
    );

    expect(selected.status, `${selected.stdout}${selected.stderr}`).toBe(0);
    expect(JSON.parse(selected.stdout)).toEqual({
      filename: 'noble-server-cloudimg-amd64.img',
      schema: 'nexus.rollback-drill-vm-image-selection.v1',
      sha256: targetDigest,
    });
  });

  it.each([
    {
      name: 'owner digest drift',
      lines: [`${'a'.repeat(64)}  noble-server-cloudimg-amd64.img`],
      expected: 'b'.repeat(64),
      error: 'owner-reviewed image SHA-256 differs',
    },
    {
      name: 'duplicate image entries',
      lines: [
        `${'a'.repeat(64)}  noble-server-cloudimg-amd64.img`,
        `${'a'.repeat(64)} *noble-server-cloudimg-amd64.img`,
      ],
      expected: 'a'.repeat(64),
      error: 'exactly one target image entry',
    },
    {
      name: 'malformed manifest line',
      lines: [
        `${'a'.repeat(64)}  noble-server-cloudimg-amd64.img`,
        'not-a-checksum-line',
      ],
      expected: 'a'.repeat(64),
      error: 'malformed checksum line',
    },
  ])(
    'rejects $name after signature verification',
    ({ lines, expected, error }) => {
      const root = temporaryRoot();
      const sums = join(root, 'SHA256SUMS');
      writeFileSync(sums, `${lines.join('\n')}\n`, { mode: 0o600 });

      const result = spawnSync(
        'python3',
        [
          manifestHelper,
          '--checksums',
          sums,
          '--filename',
          'noble-server-cloudimg-amd64.img',
          '--expected-sha256',
          expected,
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
    },
  );

  it('installs only an exact root-owned compatibility set and leaves every guest static and inactive', () => {
    const layout = read('ops/rollback-drill-vm/install-layout.tsv');

    expect(layout).toContain(
      'scripts/rollback-drill-vm-provision.sh\t/usr/local/libexec/nexus-rollback-drill-vm/provision\troot:root\t0755',
    );
    expect(layout).toContain(
      'scripts/rollback-drill-vm-run.sh\t/usr/local/libexec/nexus-rollback-drill-vm/run\troot:root\t0755',
    );
    expect(layout).toContain(
      'scripts/rollback-drill-vm-host-preflight.sh\t/usr/local/libexec/nexus-rollback-drill-vm/host-preflight\troot:root\t0755',
    );
    expect(layout).toContain(
      'scripts/rollback-drill-vm-runtime-manifest.py\t/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest\troot:root\t0755',
    );
    expect(layout).toContain(
      'scripts/rollback-drill-vm-runtime-control.sh\t/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest\troot:root\t0755',
    );
    expect(layout).toContain(
      'scripts/rollback-drill-vm-runtime-readiness-seal.sh\t/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness\troot:root\t0755',
    );
    expect(layout).toContain(
      'nexus-rollback-drill-vm-runtime-recovery.service\t/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service\troot:root\t0644',
    );
    expect(layout).toContain(
      'nexus-rollback-drill-vm@.service\t/etc/systemd/system/nexus-rollback-drill-vm@.service\troot:root\t0644',
    );
    expect(installer).toContain(
      'EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"',
    );
    expect(installer).toContain(
      '[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ]',
    );
    expect(installer).toContain(
      'archive.pax_headers.get("comment") != source_sha',
    );
    expect(installer).toContain('required member is not regular');
    expect(installer).toContain('source drift for');
    expect(installer).toContain('validate_root_owned_chain "$SOURCE_ROOT"');
    expect(installer).toContain(
      'install layout differs from the exact allowlist',
    );
    expect(installer).toContain('nexus.rollback-drill-vm-install-journal.v1');
    expect(installer).toContain('commit_asset "$unit_index"');
    expect(installer).toContain('rollback incomplete; install journal remains');
    expect(installer).toContain(
      'active guest set binds a different runner; replacement is not automatic',
    );
    expect(installer).toContain(
      'active guest set binds a different systemd unit; replacement is not automatic',
    );
    expect(installer).toContain(
      'active guest set binds a different host preflight; replacement is not automatic',
    );
    expect(installer).toContain(
      'active guest set binds a different runtime manifest helper; replacement is not automatic',
    );
    expect(installer).toContain(
      'active guest set binds a different guest runtime control; replacement is not automatic',
    );
    expect(installer).toContain(
      'active guest set binds a different readiness collector; replacement is not automatic',
    );
    expect(installer).toContain(
      'active guest set binds a different guest recovery unit; replacement is not automatic',
    );
    expect(installer).toContain('"installedAssets":10');
    expect(installer).toContain('--groups kvm');
    expect(installer).toContain(
      'must belong only to its private group and kvm',
    );
    expect(installer).toContain('assert_template_static false');
    expect(installer).toContain(
      '"$unit_verify_path" "$runtime_recovery_verify_path"',
    );
    expect(installer).toContain(
      'rollback drill VM runtime recovery prevalidation: ',
    );
    expect(installer).toContain(
      'compile(path.read_bytes(), str(path), "exec")',
    );
    expect(installer).toContain(
      'staged asset digest differs from its reviewed source',
    );
    expect(installer).toContain(
      'installed asset digest differs from its reviewed source',
    );
    expect(installer).not.toContain('systemctl is-active');
    expect(installer).not.toContain('systemctl is-enabled');
    expect(installer).not.toMatch(/systemctl\s+(?:start|restart|enable)\b/);
    expect(unit).toContain(
      'ConditionPathExists=!/var/lib/nexus-rollback-drill-vm/install-in-progress.v1',
    );
    expect(unit).toContain(
      'ConditionPathExists=!/var/lib/nexus-rollback-drill-vm/provision-in-progress.v1',
    );
    expect(unit).toContain(
      'ConditionPathExists=/run/nexus-rollback-drill-vm/admission.lock',
    );
    expect(unit).toContain('User=nexus-drill-vm');
    expect(unit).toContain('SupplementaryGroups=kvm');
    expect(unit).toContain(
      'OpenFile=/run/lock/nexus-release-sonar.lock:release-sonar-lock',
    );
    expect(unit).toContain(
      'OpenFile=/run/nexus-rollback-drill-vm/active.lock:rollback-drill-run-lock',
    );
    expect(unit).not.toContain(':read-write');
    expect(unit).toContain(
      'ExecStartPre=+/usr/local/libexec/nexus-rollback-drill-vm/host-preflight',
    );
    expect(unit).not.toContain('[Install]');
    expect(unit).toContain('Restart=no');
    expect(unit).toContain('MemoryHigh=10G');
    expect(unit).toContain('MemoryMax=12G');
    expect(unit).toContain('MemorySwapMax=512M');
    expect(tmpfiles).toContain(
      'd /run/nexus-rollback-drill-vm 0750 root nexus-drill-vm -',
    );
    expect(tmpfiles).toContain(
      'f /run/nexus-rollback-drill-vm/active.lock 0660 root nexus-drill-vm -',
    );
    expect(tmpfiles).toContain(
      'f /run/nexus-rollback-drill-vm/admission.lock 0660 root nexus-drill-vm -',
    );
    expect(tmpfiles).toContain(
      'd /run/nexus-rollback-drill-vm/handoff 0750 root nexus-drill-vm -',
    );
  });

  it('enforces the bounded host admission floor before a VM can start', () => {
    const capacityVerifier = hostPreflight.match(
      /python3 - \\\n[\s\S]*?<<'PY' \\\n  \|\| die [^\n]+\n([\s\S]*?)\nPY/,
    )?.[1];
    expect(capacityVerifier).toBeTruthy();
    const root = temporaryRoot();
    const verifierPath = join(root, 'capacity.py');
    const meminfoPath = join(root, 'meminfo');
    const loadavgPath = join(root, 'loadavg');
    writeFileSync(verifierPath, capacityVerifier!);
    const verify = (availableKiB: number, load15: string) => {
      writeFileSync(
        meminfoPath,
        `MemTotal: 32500000 kB\nMemAvailable: ${availableKiB} kB\n`,
      );
      writeFileSync(loadavgPath, `0.25 0.50 ${load15} 1/100 123\n`);
      return spawnSync(
        'python3',
        [
          verifierPath,
          String(25 * 1024 * 1024),
          '6000',
          meminfoPath,
          loadavgPath,
        ],
        { encoding: 'utf8' },
      );
    };

    const accepted = verify(26 * 1024 * 1024, '5.999');
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(verify(25 * 1024 * 1024 - 1, '0.5').status).not.toBe(0);
    expect(verify(26 * 1024 * 1024, '6.0').status).not.toBe(0);
    expect(hostPreflight).toContain("--since='24 hours ago'");
    expect(hostPreflight).toContain(
      'kernel OOM evidence exists in the last 24 hours',
    );
  });

  it('rejects missing, duplicate, spoofed, and contended inherited shared-lock descriptors', () => {
    const helper = runner.match(
      /(acquire_shared_release_mutex\(\) \{[\s\S]*?\n\})\nacquire_shared_release_mutex/,
    )?.[1];
    expect(helper).toBeTruthy();
    const root = temporaryRoot();
    const mutex = join(root, 'release-sonar.lock');
    writeFileSync(mutex, '');
    const exercise = (
      setup: string,
      descriptorIdentity = '10:20',
      flockStatus = 0,
    ) =>
      spawnSync(
        'bash',
        [
          '-c',
          [
            'die() { echo "$*" >&2; exit 1; }',
            `SHARED_MUTEX=${JSON.stringify(mutex)}`,
            'realpath() { printf "%s\\n" "$SHARED_MUTEX"; }',
            'readlink() { printf "%s\\n" "$SHARED_MUTEX"; }',
            'stat() {',
            '  case "$*" in',
            '    *"%d:%i"*"/proc/self/fd/3"*) printf "%s\\n" "$MOCK_DESCRIPTOR_ID" ;;',
            '    *"%d:%i"*) printf "10:20\\n" ;;',
            '    *) printf "root:dominguez:660\\n" ;;',
            '  esac',
            '}',
            'flock() { return "$MOCK_FLOCK_STATUS"; }',
            helper!.replace(
              '[[ -e /proc/self/fd/3 &&',
              '[[ -e "$SHARED_MUTEX" &&',
            ),
            'LISTEN_PID=$$',
            'LISTEN_FDS=2',
            'LISTEN_FDNAMES=release-sonar-lock:rollback-drill-run-lock',
            setup,
            'acquire_shared_release_mutex',
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            MOCK_DESCRIPTOR_ID: descriptorIdentity,
            MOCK_FLOCK_STATUS: String(flockStatus),
          },
        },
      );

    expect(exercise('').status).toBe(0);
    expect(exercise('unset LISTEN_FDS').status).not.toBe(0);
    expect(exercise('LISTEN_FDS=1').status).not.toBe(0);
    const spoofed = exercise('', '99:99');
    expect(spoofed.status).not.toBe(0);
    expect(spoofed.stderr).toContain('descriptor identity is invalid');
    const contended = exercise('', '10:20', 1);
    expect(contended.status).not.toBe(0);
    expect(contended.stderr).toContain(
      'a release, Sonar operation, or rollback drill holds the shared mutex',
    );
  });

  it('rejects replaced, spoofed, and contended inherited single-guest locks', () => {
    const helper = runner.match(
      /(acquire_single_guest_lock\(\) \{[\s\S]*?\n\})\nacquire_single_guest_lock/,
    )?.[1];
    expect(helper).toBeTruthy();
    const root = temporaryRoot();
    const runDirectory = join(root, 'run');
    const runLock = join(runDirectory, 'active.lock');
    mkdirSync(runDirectory);
    writeFileSync(runLock, '');
    const exercise = (
      descriptorIdentity = '10:20',
      lockIdentity = '10:20',
      flockStatus = 0,
      lockMetadata = 'root:nexus-drill-vm:660:1',
    ) =>
      spawnSync(
        'bash',
        [
          '-c',
          [
            'die() { echo "$*" >&2; exit 1; }',
            `RUN_LOCK=${JSON.stringify(runLock)}`,
            'realpath() {',
            '  [ "${1:-}" = -e ] && shift',
            '  [ "${1:-}" = -- ] && shift',
            '  printf "%s\\n" "$1"',
            '}',
            'stat() {',
            '  case "$*" in',
            '    *"%d:%i"*"/proc/self/fd/4"*) printf "%s\\n" "$MOCK_DESCRIPTOR_ID" ;;',
            '    *"%d:%i"*) printf "%s\\n" "$MOCK_LOCK_ID" ;;',
            '    *"%U:%G:%a:%h"*"/proc/self/fd/4"*) printf "%s\\n" "$MOCK_LOCK_METADATA" ;;',
            '    *"%U:%G:%a:%h"*) printf "%s\\n" "$MOCK_LOCK_METADATA" ;;',
            '    *) printf "root:nexus-drill-vm:750\\n" ;;',
            '  esac',
            '}',
            'flock() { return "$MOCK_FLOCK_STATUS"; }',
            helper!.replace(
              '[[ -e /proc/self/fd/4 && "$(readlink -f -- /proc/self/fd/4)" = "$RUN_LOCK" ]]',
              '[[ -e "$RUN_LOCK" ]]',
            ),
            'acquire_single_guest_lock',
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            MOCK_DESCRIPTOR_ID: descriptorIdentity,
            MOCK_LOCK_ID: lockIdentity,
            MOCK_FLOCK_STATUS: String(flockStatus),
            MOCK_LOCK_METADATA: lockMetadata,
          },
        },
      );

    const accepted = exercise();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(exercise('99:99').stderr).toContain(
      'descriptor identity is invalid',
    );
    expect(exercise('10:20', '20:30').stderr).toContain(
      'descriptor identity is invalid',
    );
    expect(exercise('10:20', '10:20', 1).stderr).toContain(
      'another rollback-drill guest is already active',
    );
    expect(
      exercise('10:20', '10:20', 0, 'root:nexus-drill-vm:660:2').status,
    ).not.toBe(0);
  });

  it('behaviorally rejects Git archive identity and privileged-source drift', () => {
    const verifier = installer.match(
      /# Prove the owner-reviewed archive[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\nvalidate_existing_target_chain/,
    )?.[1];
    expect(verifier).toBeTruthy();

    const root = temporaryRoot();
    const sourceRoot = join(root, 'source');
    const sourceScripts = join(sourceRoot, 'scripts');
    const sourceOps = join(sourceRoot, 'ops', 'rollback-drill-vm');
    const layoutPath = join(sourceOps, 'install-layout.tsv');
    const installerPath = join(
      sourceScripts,
      'rollback-drill-vm-systemd-install.sh',
    );
    const assetPath = join(sourceScripts, 'asset.sh');
    const archivePath = join(root, 'source.tar.gz');
    const verifierPath = join(root, 'verify.py');
    const sourceSha = 'a'.repeat(40);
    mkdirSync(sourceScripts, { recursive: true });
    mkdirSync(sourceOps, { recursive: true });
    writeFileSync(
      layoutPath,
      '# source<TAB>absolute target<TAB>owner<TAB>mode\n' +
        'scripts/asset.sh\t/usr/local/libexec/nexus-rollback-drill-vm/asset\troot:root\t0755\n',
    );
    writeFileSync(installerPath, '#!/usr/bin/env bash\n');
    writeFileSync(assetPath, '#!/usr/bin/env bash\necho reviewed\n');
    writeFileSync(verifierPath, verifier!);

    const createArchive = spawnSync(
      'python3',
      [
        '-c',
        [
          'import pathlib,sys,tarfile',
          'archive,root,sha=sys.argv[1:]',
          'with tarfile.open(archive,"w:gz",format=tarfile.PAX_FORMAT,pax_headers={"comment":sha}) as output:',
          '  for item in sorted(pathlib.Path(root).rglob("*")):',
          '    output.add(item,arcname="source/"+item.relative_to(root).as_posix(),recursive=False)',
        ].join('\n'),
        archivePath,
        sourceRoot,
        sourceSha,
      ],
      { encoding: 'utf8' },
    );
    expect(createArchive.status, createArchive.stderr).toBe(0);

    const verify = (sha = sourceSha) =>
      spawnSync(
        'python3',
        [verifierPath, archivePath, sourceRoot, sha, layoutPath, installerPath],
        { encoding: 'utf8' },
      );

    const accepted = verify();
    expect(accepted.status, accepted.stderr).toBe(0);
    const wrongCommit = verify('b'.repeat(40));
    expect(wrongCommit.status).not.toBe(0);
    expect(wrongCommit.stderr).toContain(
      'Git archive commit does not match source SHA',
    );
    writeFileSync(assetPath, '#!/usr/bin/env bash\necho drifted\n');
    const drifted = verify();
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain('source drift for scripts/asset.sh');
  });

  it('behaviorally fails closed on systemd transport and unknown-state errors', () => {
    const helpers = installer.match(
      /(read_systemd_unit_state\(\) \{[\s\S]*?)\n\nvalidate_root_owned_chain/,
    )?.[1];
    expect(helpers).toBeTruthy();
    const exercise = (output: string, status: number, assertion: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          [
            'die() { echo "$*" >&2; exit 1; }',
            'UNIT_TEMPLATE=nexus-rollback-drill-vm@.service',
            'systemctl() { printf "%s" "$MOCK_OUTPUT"; return "$MOCK_STATUS"; }',
            helpers!,
            assertion,
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            MOCK_OUTPUT: output,
            MOCK_STATUS: String(status),
          },
        },
      );

    const inactive = exercise(
      'LoadState=loaded\nActiveState=inactive\nUnitFileState=static\n',
      0,
      'assert_guest_unit_inactive nexus-rollback-drill-vm@guest-1.service false',
    );
    expect(inactive.status, inactive.stderr).toBe(0);
    const missing = exercise(
      'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n',
      0,
      'assert_guest_unit_inactive nexus-rollback-drill-vm@guest-1.service true',
    );
    expect(missing.status, missing.stderr).toBe(0);
    const transportError = exercise(
      'Failed to connect to bus: No such file or directory\n',
      1,
      'assert_guest_unit_inactive nexus-rollback-drill-vm@guest-1.service true',
    );
    expect(transportError.status).not.toBe(0);
    expect(transportError.stderr).toContain('systemd state query failed');
    const unknown = exercise(
      'LoadState=error\nActiveState=inactive\nUnitFileState=\n',
      0,
      'assert_guest_unit_inactive nexus-rollback-drill-vm@guest-1.service true',
    );
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain('load state is unsafe');
  });

  it('root-copies an optional unprivileged cache before independently verifying Canonical identity', () => {
    const rootCopy = provisioner.indexOf('copy_untrusted_regular_file');
    const signatureCheck = provisioner.indexOf(
      '"$GPGV" --keyring "$KEYRING" "$signature" "$sums"',
    );
    const manifestCheck = provisioner.indexOf('python3 "$MANIFEST_HELPER"');
    const imageDigestCheck = provisioner.indexOf(
      'downloaded image digest differs from the verified signed manifest',
    );
    const baseInstall = provisioner.indexOf(
      'install -o root -g "$EXPECTED_USER" -m 0440',
    );

    expect(provisioner).toContain(
      'IMAGE_ORIGIN="https://cloud-images.ubuntu.com/noble/current"',
    );
    expect(provisioner).toContain(
      'KEYRING="/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg"',
    );
    expect(provisioner).toContain('--staged-source-directory');
    expect(provisioner).toContain('os.O_NOFOLLOW');
    expect(provisioner).toContain('os.O_DIRECTORY');
    expect(provisioner).toContain('before.st_mtime_ns != after.st_mtime_ns');
    expect(provisioner).toContain(
      'image byte size differs from the owner-reviewed value',
    );
    expect(provisioner).toContain('--remove-on-error');
    expect(provisioner.match(/--max-filesize 2097152/g)).toHaveLength(2);
    expect(provisioner).toContain('--max-filesize "$expected_image_size"');
    expect(provisioner).toContain('storage = os.statvfs(state_root)');
    expect(provisioner).toContain('guard_bytes = 20 * 1024 * 1024 * 1024');
    expect(provisioner).toContain('storage.f_favail < 256');
    expect(rootCopy).toBeGreaterThan(0);
    expect(signatureCheck).toBeGreaterThan(rootCopy);
    expect(manifestCheck).toBeGreaterThan(signatureCheck);
    expect(imageDigestCheck).toBeGreaterThan(manifestCheck);
    expect(baseInstall).toBeGreaterThan(imageDigestCheck);
    expect(provisioner).toContain('"$QEMU_IMG" check -q -- "$image"');
    expect(provisioner).toContain(
      'downloaded image is not the expected standalone qcow2 format',
    );
    expect(provisioner).toContain(
      'base_target="$BASE_DIR/$expected_image_sha256.qcow2"',
    );
    expect(provisioner).not.toMatch(
      /\b(?:bash|sh|source|\.)\s+["']?\$staged_source_directory/,
    );
  });

  it('behaviorally refuses provisioning when download and base-copy headroom is unavailable', () => {
    const admission = provisioner.match(
      /python3 - "\$STATE_ROOT" "\$expected_image_size" <<'PY' \\\n  \|\| die "rollback-drill storage admission failed"\n([\s\S]*?)\nPY/,
    )?.[1];
    expect(admission).toBeTruthy();
    const root = temporaryRoot();
    const verifier = join(root, 'storage-admission.py');
    writeFileSync(verifier, admission!);
    const rejected = spawnSync(
      'python3',
      [verifier, root, String(Number.MAX_SAFE_INTEGER)],
      { encoding: 'utf8' },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('including the 20 GiB host guard');
  });

  it('publishes exactly three independent key-only guests in one atomic set', () => {
    expect(provisioner).toContain('for index in 1 2 3; do');
    expect(provisioner).toContain('qemu-img');
    expect(provisioner).toContain('-F qcow2 -b "$base_target"');
    expect(provisioner).toContain(
      '"$QEMU_IMG" bitmap --add --disable -g 65536 "$overlay" "$bitmap_name"',
    );
    expect(provisioner).toContain('"flags": []');
    expect(provisioner).toContain('"granularity": 65536');
    expect(provisioner).toContain(
      'initial guest overlay digests must be independent',
    );
    expect(provisioner).toContain('100G');
    expect(provisioner.match(/ssh-keygen -q -t ed25519/g)).toHaveLength(1);
    expect(provisioner).toContain(
      '"guestSshHostPublicKeySha256": host_key_sha',
    );
    expect(provisioner).toContain(
      'printf \'%s\' "$normalized_key" | sha256sum',
    );
    expect(provisioner).toContain(
      'printf \'%s\' "$set_host_public_key" | sha256sum',
    );
    expect(provisioner).toContain('overlay_initial_sha256=');
    expect(provisioner).toContain(
      '"overlayInitialSha256": overlay_initial_sha',
    );
    expect(provisioner).toContain('"hostPublicKey": host_public_key');
    expect(provisioner).toContain('"manager": "qemu-systemd"');
    expect(provisioner).toContain('"qemuSha256": qemu_sha');
    expect(provisioner).toContain('"qemuVersion": qemu_version');
    expect(provisioner).toContain('"qemuPackage": qemu_package');
    expect(provisioner).toContain('"qemuPackageVersion": qemu_package_version');
    expect(provisioner).toContain(
      '"qemuPackageArchitecture": qemu_package_architecture',
    );
    expect(provisioner).toContain('"hostPreflightSha256": host_preflight_sha');
    expect(provisioner).toContain('"hostAvailableMemoryFloorGiB": 25');
    expect(provisioner).toContain('"hostLoad15CeilingExclusive": 6');
    expect(provisioner).toContain('"memoryMiB": 14336');
    expect(provisioner).toContain('"memorySwapMaxMiB": 512');
    expect(provisioner).toContain('"networkMode": "qemu-user-restrict"');
    expect(provisioner).toContain('"productionDataAttached": False');
    expect(provisioner).toContain('"runnerSha256": runner_sha');
    expect(provisioner).toContain('"unitSha256": unit_sha');
    expect(provisioner).toContain('"status": "ssh_only_bootstrap_required"');
    expect(provisioner).toContain('"drillReady": False');
    expect(provisioner).toContain(
      '"pm2-6.0.14-at-/opt/nexus-rollback-drill-vm/runtime/pm2-6.0.14/bin/pm2"',
    );
    expect(provisioner).toContain('vm_uuid="$(tr');
    expect(provisioner).toContain('instance_id="nexus-rollback-drill-$guest-');
    expect(provisioner).toContain('disable_root: true');
    expect(provisioner).toContain('ssh_pwauth: false');
    expect(provisioner).toContain('lock_passwd: true');
    expect(provisioner).toContain('PasswordAuthentication no');
    expect(provisioner).toContain('PermitRootLogin no');
    expect(provisioner).toContain('AllowUsers dominguez');
    expect(provisioner).toContain('ssh_deletekeys: true');
    expect(provisioner).toContain('ed25519_private: |');
    expect(provisioner).toContain('mv -T -- "$set_stage" "$set_target"');
    expect(provisioner).toContain(
      'mv -fT -- "$active_stage" "$ACTIVE_RECEIPT"',
    );
    expect(provisioner).toContain('"guestCount":3');
    expect(provisioner).not.toMatch(/systemctl\s+(?:start|restart|enable)\b/);
  });

  it('runs one guest at a time with loopback-only user networking and regular-file drives', () => {
    expect(runner).toContain('flock -n 5');
    expect(runner).toContain(
      'runtime readiness collection currently blocks new guest starts',
    );
    expect(runner).toContain('flock -u 5');
    expect(runner).toContain('flock -n 4');
    expect(runner).toContain('another rollback-drill guest is already active');
    expect(runner).toContain('acquire_shared_release_mutex');
    expect(runner).toContain('flock -n 3');
    expect(runner).toContain('-m 14336');
    expect(runner).toContain('guest-1|guest-2|guest-3');
    expect(runner).toContain('hostfwd=tcp:127.0.0.1:${port}-:22');
    expect(runner).toContain('restrict=on');
    expect(runner).toContain('-enable-kvm');
    expect(runner).toContain('-machine q35,accel=kvm');
    expect(runner).toContain('-drive "file=$overlay_path');
    expect(runner).toContain('-drive "file=$seed_path');
    expect(runner).toContain('readonly=on');
    expect(runner).toContain('loopback SSH port is already occupied');
    expect(runner).toContain(
      'guest machine identities must be independent and SSH host identity set-scoped',
    );
    expect(runner).toContain(
      'guest host-key fingerprint does not match its public key',
    );
    expect(runner).toContain('hypervisor contract drifted at');
    expect(runner).toContain('installed QEMU binary digest drifted');
    expect(runner).toContain('installed QEMU version drifted');
    expect(runner).toContain('installed QEMU package identity drifted');
    expect(runner).toContain('installed host preflight digest drifted');
    expect(runner).toContain(
      'provision set identity does not bind the hypervisor contract',
    );
    expect(runner).toContain('installed runner digest drifted');
    expect(runner).toContain('installed unit digest drifted');
    expect(runner).toContain('guest runtime-readiness boundary is invalid');
    expect(runner).toContain('base image digest drifted');
    expect(runner).toContain(
      'guest overlay differs from its accepted current readiness; provision a fresh set',
    );
    expect(runner).toContain('guest seed digest drifted');
    expect(runner).not.toMatch(/\b(?:bridge|tap|tun|virtfs|9p|smb|nfs)\b/i);
    expect(runner).not.toContain('/dev/sd');
    expect(runner).not.toContain('-blockdev');
    expect(runner).not.toContain('-daemonize');
    expect(runner).not.toContain('-qmp');
    expect(runner).not.toContain('-no-reboot');
    expect(runner).toContain('trap handle_normal_shutdown TERM');
    expect(runner).toContain('trap handle_interrupt INT');
    expect(runner).toContain('trap handle_runtime_handoff USR1');
    expect(runner).toContain('kill -TERM "$qemu_pid"');
    expect(runner).toContain('kill -KILL "$qemu_pid"');
    expect(runner).toContain('-display none');
    expect(runner).toContain('-serial none');
    expect(runner).toContain('-monitor none');
  });

  it('behaviorally refuses an overlay that differs from its accepted readiness digest', () => {
    const guard = runner.match(
      /printf '%s  %s\\n' "\$expected_overlay_sha256" "\$overlay_path" \\\n  \| sha256sum --check --status \\\n  \|\| die "guest overlay differs from its accepted current readiness; provision a fresh set"/,
    )?.[0];
    expect(guard).toBeTruthy();
    const root = temporaryRoot();
    const overlay = join(root, 'root.qcow2');
    const original = Buffer.from('pristine-overlay');
    writeFileSync(overlay, original);
    const expected = createHash('sha256').update(original).digest('hex');
    const exercise = () =>
      spawnSync(
        'bash',
        [
          '-c',
          [
            'die() { echo "$*" >&2; exit 1; }',
            'sha256sum() {',
            '  [ "$1" = --check ] && [ "$2" = --status ] || return 90',
            '  IFS=" " read -r expected path',
            '  actual="$(openssl dgst -sha256 -r "$path" | cut -d" " -f1)"',
            '  [ "$actual" = "$expected" ]',
            '}',
            guard!,
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            expected_overlay_sha256: expected,
            overlay_path: overlay,
          },
        },
      );

    const accepted = exercise();
    expect(accepted.status, accepted.stderr).toBe(0);
    writeFileSync(overlay, Buffer.concat([original, Buffer.from('-mutated')]));
    const rejected = exercise();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'guest overlay differs from its accepted current readiness; provision a fresh set',
    );
  });

  it('documents the fail-closed owner boundary without claiming drill completion', () => {
    expect(operations).toContain('It is not a second release lane');
    expect(operations).toContain('Never copy a production SSH key');
    expect(operations).toContain('no-follow file-descriptor semantics');
    expect(operations).toContain('does not use the network in this mode');
    expect(operations).toContain('ssh_only_bootstrap_required');
    expect(operations).toContain('drillReady=false');
    expect(operations).toContain('Node 22.23.1');
    expect(operations).toContain(
      '/opt/nexus-rollback-drill-vm/runtime/pm2-6.0.14/bin/pm2',
    );
    expect(operations).toContain(
      'This first version deliberately has no automatic guest deletion',
    );
    expect(releaseRunbook).toContain('#### ServerDominguez KVM drill host');
    expect(releaseRunbook).toContain('Repository tests and');
    expect(releaseRunbook).toContain(
      'a successful VM boot are not fault-drill evidence',
    );
    expect(releaseRunbook).toContain('protected rollback-drill signer');
    expect(releaseRunbook).toContain(
      'The old caller-supplied guest-attestation path is absent',
    );
  });

  it('keeps privileged assets at the executable modes declared by the install layout', () => {
    for (const [path, expectedMode] of [
      ['scripts/rollback-drill-vm-systemd-install.sh', 0o755],
      ['scripts/rollback-drill-vm-provision.sh', 0o755],
      ['scripts/rollback-drill-vm-run.sh', 0o755],
      ['scripts/rollback-drill-vm-host-preflight.sh', 0o755],
      ['scripts/rollback-drill-vm-manifest.py', 0o644],
    ] as const) {
      const mode = statSync(path).mode & 0o777;
      expect(mode & 0o022, `${path} is writable by group or world`).toBe(0);
      expect(mode, `${path} mode differs from its install contract`).toBe(
        expectedMode,
      );
    }
  });
});
