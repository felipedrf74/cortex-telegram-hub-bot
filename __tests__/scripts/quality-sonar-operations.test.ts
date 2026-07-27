import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createObservationFixture,
  OLLAMA_DELETE,
  OLLAMA_DIGESTS,
  OLLAMA_RETAINED,
} from './helpers/ollama-observation-fixture';

const read = (path: string) => readFileSync(path, 'utf8');

describe('advisory SonarQube operational assets', () => {
  it('transactionally binds installation to the exact root bootstrap and reviewed layouts', () => {
    const installer = resolve('scripts/quality-sonar-systemd-install.sh');
    const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const script = read(installer);
    const recoveryProgram = read(
      'scripts/quality-sonar-install-transaction.py',
    );
    const declaredInstall = read('ops/sonarqube/install-layout.tsv')
      .split('\n').slice(1).join('\n').trim();
    const declaredData = read('ops/sonarqube/data-layout.tsv')
      .split('\n').slice(1).join('\n').trim();
    const installMatch = script.match(/cat <<'LAYOUT'\n([\s\S]*?)\nLAYOUT/);
    const dataMatch = script.match(/cat <<'DATA_LAYOUT'\n([\s\S]*?)\nDATA_LAYOUT/);

    expect(installMatch?.[1]).toBe(declaredInstall);
    expect(dataMatch?.[1]).toBe(declaredData);
    expect(script).toContain('BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap');
    expect(script).toContain('EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"');
    expect(script).toContain(
      '[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ]',
    );
    expect(script).toContain(
      '[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ]',
    );
    expect(script).toContain('archive.pax_headers.get("comment") != source_sha');
    expect(script).toContain('required member is not regular');
    expect(script).toContain('source drift for');
    expect(script).toContain('install target is outside the exact allowlist');
    expect(script).toContain(
      '[[ "$relative" =~ ^[A-Za-z0-9._@/-]+$ ]]',
    );
    expect(script).toContain('component is group/world writable');
    expect(script).toContain(
      'installer must execute from the exact reviewed bootstrap source path',
    );
    expect(recoveryProgram).toContain('managed directory parent');
    expect(script).toContain(
      'append_directory_plan 4 "$RESTORE_EVIDENCE_DIR" 0 0 0700',
    );
    expect(script).toContain('bootstrap-control-root');
    expect(script).toContain('begin-directories');
    expect(script).toContain('create-directory');
    const targetBlock = recoveryProgram.match(
      /PRODUCTION_TARGETS = frozenset\(\{\n([\s\S]*?)\n\}\)/,
    )?.[1];
    expect(targetBlock).toBeTruthy();
    const recoveryTargets = [
      ...(targetBlock?.matchAll(/^\s*"([^"]+)",$/gm) ?? []),
    ].map((match) => match[1]).sort();
    const layoutTargets = read('ops/sonarqube/install-layout.tsv')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split('\t')[1])
      .sort();
    expect(recoveryTargets).toEqual(layoutTargets);
  });

  it('captures a fail-closed pre-Docker baseline without entering the asset transaction', () => {
    const installer = read('scripts/quality-sonar-systemd-install.sh');
    const archiveVerifier = installer.indexOf(
      '# Prove that the reviewed archive came from the declared Git commit',
    );
    const preDockerBranch = installer.indexOf(
      'if [ "$PRE_DOCKER_PREFLIGHT_ONLY" = true ]; then',
      archiveVerifier,
    );
    const fullInstallMutexMaterialization = installer.indexOf(
      'systemd-tmpfiles --create "$SHARED_MUTEX_CONFIG"',
    );
    const interruptedInstallRecovery = installer.indexOf(
      'control_recovery_required=false',
    );
    const dockerMapping = installer.indexOf('userns_map_json="$(');
    const assetTransaction = installer.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" begin \\\n',
    );
    const preDockerBlock = installer.slice(
      preDockerBranch,
      fullInstallMutexMaterialization,
    );

    expect(installer).toContain(
      '[--pre-docker-preflight-only <new-private-output-directory>]',
    );
    expect(preDockerBranch).toBeGreaterThan(archiveVerifier);
    expect(preDockerBranch).toBeLessThan(fullInstallMutexMaterialization);
    expect(preDockerBranch).toBeLessThan(interruptedInstallRecovery);
    expect(preDockerBranch).toBeLessThan(dockerMapping);
    expect(preDockerBranch).toBeLessThan(assetTransaction);
    expect(preDockerBlock).toContain('exec 9<>"$SHARED_MUTEX"');
    expect(preDockerBlock).toContain('flock -n 9');
    expect(preDockerBlock).toContain('--verify-runtime-boundary-only');
    expect(preDockerBlock).toContain('--allow-docker-absent');
    expect(preDockerBlock).toContain(
      '--output "$PRE_DOCKER_PREFLIGHT_OUTPUT"',
    );
    const initialAbsenceProbe = preDockerBlock.indexOf(
      'assert_pre_docker_absent_boundary initial',
    );
    const fullEvidenceCapture = preDockerBlock.indexOf(
      '--output "$PRE_DOCKER_PREFLIGHT_OUTPUT"',
    );
    const postCaptureAbsenceProbe = preDockerBlock.indexOf(
      'assert_pre_docker_absent_boundary post-capture',
    );
    expect(initialAbsenceProbe).toBeGreaterThan(-1);
    expect(initialAbsenceProbe).toBeLessThan(fullEvidenceCapture);
    expect(postCaptureAbsenceProbe).toBeGreaterThan(fullEvidenceCapture);
    expect(postCaptureAbsenceProbe).toBeGreaterThan(
      preDockerBlock.indexOf(
        'pre-Docker evidence does not prove Docker remained absent',
      ),
    );
    expect(preDockerBlock).toContain(
      "result?.dockerEngineCaptured !== false",
    );
    expect(preDockerBlock).toContain(
      "authority?.dockerAuthority !== 'not_installed'",
    );
    expect(preDockerBlock).toContain(
      '"preflightOnly":true,"dockerTouched":false,"assetsInstalled":false,"configurationWritten":false',
    );
    expect(preDockerBlock).not.toContain('systemd-tmpfiles --create');
    expect(preDockerBlock).not.toContain('bootstrap-control-root');
    expect(preDockerBlock).not.toContain('enroll-anchors');
    expect(preDockerBlock).not.toContain('create-directory');
    expect(preDockerBlock).not.toMatch(
      /\b(?:apt|apt-get|docker)\s+(?:install|pull|run|compose|start)\b/,
    );
  });

  it('behaviorally rejects an installed source asset that drifted from the Git archive', () => {
    const installer = read('scripts/quality-sonar-systemd-install.sh');
    const verifier = installer.match(
      /# Prove that the reviewed archive[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\n# Recovery must precede/,
    )?.[1];
    expect(verifier).toBeTruthy();

    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-installer-'));
    const sourceRoot = join(temp, 'source');
    const sourceScripts = join(sourceRoot, 'scripts');
    const sourceOps = join(sourceRoot, 'ops', 'sonarqube');
    const archive = join(temp, 'source.tar.gz');
    const verifierPath = join(temp, 'verify.py');
    const sha = 'a'.repeat(40);
    const layoutPath = join(sourceOps, 'install-layout.tsv');
    const dataLayoutPath = join(sourceOps, 'data-layout.tsv');
    const installerPath = join(sourceScripts, 'quality-sonar-systemd-install.sh');
    const assetPath = join(sourceScripts, 'asset.sh');
    const lockConfigPath = join(
      sourceOps,
      'nexus-release-sonar-lock.conf',
    );

    try {
      mkdirSync(sourceScripts, { recursive: true });
      mkdirSync(sourceOps, { recursive: true });
      writeFileSync(
        layoutPath,
        '# source<TAB>absolute target<TAB>owner<TAB>mode\n' +
          'scripts/asset.sh\t/usr/local/sbin/asset\troot:root\t0755\n',
      );
      writeFileSync(dataLayoutPath, '# data layout\n');
      writeFileSync(installerPath, '#!/usr/bin/env bash\n');
      writeFileSync(assetPath, '#!/usr/bin/env bash\necho reviewed\n');
      writeFileSync(
        lockConfigPath,
        'f /run/lock/nexus-release-sonar.lock 0660 root dominguez -\n',
      );
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
          archive,
          sourceRoot,
          sha,
        ],
        { encoding: 'utf8' },
      );
      expect(createArchive.status, createArchive.stderr).toBe(0);

      const verify = () =>
        spawnSync(
          'python3',
          [
            verifierPath,
            archive,
            sourceRoot,
            sha,
            layoutPath,
            dataLayoutPath,
            installerPath,
          ],
          { encoding: 'utf8' },
        );

      const accepted = verify();
      expect(accepted.status, accepted.stderr).toBe(0);
      writeFileSync(assetPath, '#!/usr/bin/env bash\necho drifted\n');
      const rejected = verify();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('source drift for scripts/asset.sh');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('serializes, prevalidates, atomically installs, and rolls back without runtime mutation', () => {
    const script = read('scripts/quality-sonar-systemd-install.sh');
    const transaction = read('scripts/quality-sonar-install-transaction.py');
    const lock = script.indexOf('exec 9<>"$SHARED_MUTEX"');
    const prevalidate = script.indexOf(
      '# Complete every source-only validation before creating a directory',
    );
    const firstDirectory = script.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" create-directory',
    );
    const stage = script.indexOf(
      'stage="$(mktemp -p "$target_parent" ".nexus-sonarqube.stage.XXXXXX")"',
    );
    const predecessor = script.indexOf('ln -- "$target" "$backup"');
    const journalWrite = script.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" begin \\\n',
    );
    const firstCommit = script.indexOf('commit_asset "$service_index"');
    const complete = script.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" commit-install',
    );
    const directoryJournal = script.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" begin-directories',
    );
    const anchorEnrollment = script.indexOf(
      'python3 "${sources[$recovery_program_index]}" enroll-anchors',
    );

    expect(script).toContain('flock -n 9');
    expect(script).toContain('bash -n "$source_path"');
    expect(script).toContain('node --check "$source_path"');
    expect(script).toContain('--verify-lock-only');
    expect(script).toContain('visudo -cf');
    expect(script).toContain('Sonar Compose prevalidation');
    expect(lock).toBeGreaterThan(-1);
    expect(prevalidate).toBeGreaterThan(lock);
    expect(anchorEnrollment).toBeGreaterThan(prevalidate);
    expect(directoryJournal).toBeGreaterThan(anchorEnrollment);
    expect(firstDirectory).toBeGreaterThan(prevalidate);
    expect(firstDirectory).toBeGreaterThan(directoryJournal);
    expect(stage).toBeGreaterThan(firstDirectory);
    expect(predecessor).toBeGreaterThan(stage);
    expect(journalWrite).toBeGreaterThan(predecessor);
    expect(firstCommit).toBeGreaterThan(stage);
    expect(firstCommit).toBeGreaterThan(journalWrite);
    expect(complete).toBeGreaterThan(firstCommit);
    expect(script).toContain('ln -- "$target" "$backup"');
    expect(script).toContain('mv -fT -- "${stage_paths[$index]}" "$target"');
    expect(script).toContain('"preservedDependencies": [{');
    expect(script).toContain(
      'promotion-owned shared lock config changed before receipt staging',
    );
    expect(
      read('ops/sonarqube/install-layout.tsv'),
    ).not.toContain('/etc/tmpfiles.d/nexus-release-sonar-lock.conf');
    expect(script).toContain(
      'python3 "$INSTALL_RECOVERY_PROGRAM" auto-recover',
    );
    expect(script).toContain(
      'control journals retained for boot recovery',
    );
    expect(script).toContain('inactive:3|failed:3|unknown:4|not-found:4');
    expect(script).not.toContain('! systemctl is-active "$unit"');
    expect(script).toContain('"configurationWritten":false');
    expect(script).toContain('"dockerTouched":false');
    expect(script).toContain('"servicesEnabled":false');
    expect(script).toContain('"applicationDataWritten":false');
    expect(script).not.toMatch(/^\s*(?:sudo\s+)?(?:apt|apt-get|docker)\b/m);
    expect(transaction).toContain(
      'run_systemctl(["enable", RECOVERY_SERVICE])',
    );
    expect(script).not.toMatch(/systemctl\s+(?:start|stop|restart|disable)\b/);
  });

  it('rejects an unknown systemctl transport result instead of assuming inactivity', () => {
    const installer = read('scripts/quality-sonar-systemd-install.sh');
    const helper = installer.match(
      /assert_unit_inactive\(\) \{\n[\s\S]*?\n\}/,
    )?.[0];
    expect(helper).toBeTruthy();

    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-unit-state-'));
    const systemctl = join(temp, 'systemctl');
    try {
      writeFileSync(
        systemctl,
        '#!/bin/sh\nprintf "%s\\n" "${MOCK_SYSTEMCTL_STATE:-}"\nexit "${MOCK_SYSTEMCTL_RC:-1}"\n',
        { mode: 0o755 },
      );
      chmodSync(systemctl, 0o755);
      const harness = [
        'set -euo pipefail',
        'die() { echo "$*" >&2; exit 1; }',
        helper!,
        'assert_unit_inactive nexus-sonarqube.service',
      ].join('\n');
      const run = (state: string, rc: number) =>
        spawnSync('bash', ['-c', harness], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH ?? ''}`,
            MOCK_SYSTEMCTL_STATE: state,
            MOCK_SYSTEMCTL_RC: String(rc),
          },
        });

      expect(run('inactive', 3).status).toBe(0);
      expect(run('failed', 3).status).toBe(0);
      expect(run('unknown', 4).status).toBe(0);
      expect(run('active', 0).status).not.toBe(0);
      expect(run('activating', 3).status).not.toBe(0);
      const transportError = run('', 1);
      expect(transportError.status).not.toBe(0);
      expect(transportError.stderr).toContain(
        'unable to prove unit is safely inactive',
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('guards stack and backup startup after an interrupted asset install', () => {
    const conditions = [
      'ConditionPathExists=!/var/lib/nexus-release-promotion/sonarqube-install-control/asset-install-in-progress.v2',
      'ConditionPathExists=!/var/lib/nexus-release-promotion/sonarqube-install-control/directory-install-in-progress.v1.json',
      'ConditionPathExists=!/var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-unenrollment-in-progress.v1.json',
    ];
    for (const runtimeUnit of [
      'ops/sonarqube/systemd/nexus-sonarqube.service',
      'ops/sonarqube/systemd/nexus-sonarqube-backup.service',
      'ops/sonarqube/systemd/nexus-sonarqube-backup.timer',
    ]) {
      for (const condition of conditions) {
        expect(read(runtimeUnit)).toContain(condition);
      }
    }
    expect(read('scripts/quality-sonar-stack.sh')).toContain(
      'Sonar asset installation is incomplete',
    );
    const recovery = read(
      'ops/sonarqube/systemd/nexus-sonarqube-install-recovery.service',
    );
    expect(recovery).toContain(
      'ConditionPathIsDirectory=/var/lib/nexus-release-promotion/sonarqube-install-control',
    );
    expect(recovery).toContain(
      'Before=nexus-sonarqube.service nexus-sonarqube-backup.service nexus-sonarqube-backup.timer',
    );
    expect(recovery).toContain(
      '/var/lib/nexus-release-promotion/sonarqube-install-control/install-recovery-program.v2.py auto-recover',
    );
    expect(recovery).toContain('RestrictAddressFamilies=AF_UNIX');
    for (const runtimeUnit of [
      'ops/sonarqube/systemd/nexus-sonarqube.service',
      'ops/sonarqube/systemd/nexus-sonarqube-backup.service',
      'ops/sonarqube/systemd/nexus-sonarqube-backup.timer',
    ]) {
      expect(read(runtimeUnit)).toContain(
        'Wants=nexus-sonarqube-install-recovery.service',
      );
      expect(read(runtimeUnit)).toContain(
        'After=' + (
          runtimeUnit.endsWith('nexus-sonarqube.service')
            ? 'network-online.target docker.service '
            : runtimeUnit.endsWith('nexus-sonarqube-backup.service')
              ? 'docker.service '
              : ''
        ) + 'nexus-sonarqube-install-recovery.service',
      );
    }
  });

  it('treats recovery-anchor enrollment as a reversible non-overwriting phase', () => {
    const installer = read('scripts/quality-sonar-systemd-install.sh');
    const transaction = read('scripts/quality-sonar-install-transaction.py');
    const promotionInstaller = read(
      'scripts/remote-promotion-systemd-install.sh',
    );
    const runbook = read('ops/sonarqube/README.md');
    expect(installer).toContain(
      'python3 "${sources[$recovery_program_index]}" enroll-anchors',
    );
    expect(installer).toContain(
      'resume-anchor-cleanup',
    );
    expect(installer).toContain(
      'retire-anchor-cleanup-result',
    );
    expect(installer.indexOf('resume-anchor-cleanup')).toBeLessThan(
      installer.indexOf('userns_map_json="$('),
    );
    expect(installer.indexOf('retire-anchor-cleanup-result')).toBeLessThan(
      installer.indexOf('userns_map_json="$('),
    );
    expect(transaction).toContain(
      'preexisting recovery anchor differs',
    );
    expect(transaction).toContain(
      'preexisting recovery unit must already be enabled',
    );
    expect(transaction).toContain(
      'nexus.sonarqube-recovery-anchor-enrollment.v2',
    );
    expect(transaction).toContain(
      'nexus.sonarqube-recovery-anchor-enrollment-intent.v2',
    );
    expect(transaction).toContain(
      'recovery-anchor intent binds another source',
    );
    expect(transaction).toContain('createdFromAbsence');
    expect(transaction).toContain('anchor-plan');
    expect(transaction).toContain('anchor-unenroll');
    expect(transaction).toContain('NEXUS_SONAR_OWNER_AUTHORIZED');
    expect(transaction).toContain('remove-retainedRecoveryProgram');
    expect(transaction).toContain(
      'recovery-anchor-unenrollment-result.v1.json',
    );
    expect(transaction).toContain(
      'remove-continuation-unit',
    );
    expect(transaction).toContain('validate-anchor-current');
    expect(promotionInstaller).toContain(
      'install_release_sonar_lock_config',
    );
    expect(promotionInstaller).toContain(
      'python3 "$anchor_program" validate-anchor-current',
    );
    expect(promotionInstaller).toContain(
      '"$control_root/recovery-anchor-enrollment-in-progress.v2.json"',
    );
    expect(promotionInstaller).toContain(
      '"$control_root/recovery-anchor-unenrollment-in-progress.v1.json"',
    );
    expect(promotionInstaller).toContain(
      '"$control_root/recovery-anchor-unenrollment-result.v1.json"',
    );
    expect(promotionInstaller).toContain(
      'flock -n "$lock_fd"',
    );
    expect(promotionInstaller.indexOf('flock -n "$lock_fd"')).toBeLessThan(
      promotionInstaller.indexOf('for marker in'),
    );
    const promotionMutexAcquire = promotionInstaller.indexOf(
      'materialize_release_sonar_mutex \\\n' +
        '  "$SOURCE_ROOT/ops/sonarqube/nexus-release-sonar-lock.conf"',
    );
    expect(promotionMutexAcquire).toBeGreaterThan(-1);
    expect(promotionMutexAcquire).toBeLessThan(
      promotionInstaller.indexOf(
        'exec 8>"/var/lib/nexus-release-promotion/.control.lock"',
      ),
    );
    expect(
      read(
        'ops/sonarqube/systemd/nexus-sonarqube-install-recovery.service',
      ),
    ).not.toContain('RemainAfterExit=');
    expect(runbook).toContain(
      'Recovery-anchor enrollment is independently reversible',
    );
    expect(runbook).toContain(
      'preserves preexisting-identical anchors',
    );
  });

  it('preserves an interrupted Sonar enrollment and rejects a contended shared lock', () => {
    const promotionInstaller = read(
      'scripts/remote-promotion-systemd-install.sh',
    );
    const lockConfigInstaller = promotionInstaller.match(
      /(install_release_sonar_lock_config\(\) \{[\s\S]*?\n\})\n\nmaterialize_release_sonar_mutex/,
    )?.[1];
    expect(lockConfigInstaller).toBeTruthy();

    const temp = mkdtempSync(join(tmpdir(), 'nexus-promotion-sonar-lock-'));
    const fixtureBin = join(temp, 'bin');
    const control = join(temp, 'control');
    const source = join(temp, 'reviewed-lock.conf');
    const target = join(temp, 'installed-lock.conf');
    const lock = join(temp, 'shared.lock');
    const intent = join(
      control,
      'recovery-anchor-enrollment-in-progress.v2.json',
    );
    const harness = join(temp, 'install-lock-config.sh');
    const contendedHarness = join(temp, 'install-lock-config-contended.sh');
    const holder = join(temp, 'hold-lock.py');
    const ready = join(temp, 'holder.ready');
    const uid = process.geteuid?.() ?? 0;
    const gid = process.getegid?.() ?? 0;
    const existing = 'f /run/lock/nexus-release-sonar.lock 0660 root old - -\n';
    const changed = 'f /run/lock/nexus-release-sonar.lock 0660 root new - -\n';

    try {
      mkdirSync(fixtureBin);
      mkdirSync(control);
      writeFileSync(target, existing, { mode: 0o644 });
      chmodSync(target, 0o644);
      writeFileSync(source, changed, { mode: 0o644 });
      chmodSync(source, 0o644);
      writeFileSync(intent, '{}\n', { mode: 0o600 });
      chmodSync(intent, 0o600);
      writeFileSync(lock, '', { mode: 0o600 });
      chmodSync(lock, 0o600);
      const preserved = statSync(target);

      writeFileSync(
        join(fixtureBin, 'stat'),
        [
          '#!/usr/bin/env python3',
          'import os,stat,sys',
          'fmt=sys.argv[sys.argv.index("-c")+1]',
          'value=os.lstat(sys.argv[-1])',
          'fields={',
          ' "%u":str(value.st_uid),"%g":str(value.st_gid),',
          ' "%a":format(stat.S_IMODE(value.st_mode),"o"),',
          ' "%h":str(value.st_nlink),"%d":str(value.st_dev),',
          ' "%i":str(value.st_ino),',
          '}',
          'for key,replacement in fields.items():fmt=fmt.replace(key,replacement)',
          'print(fmt)',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(join(fixtureBin, 'stat'), 0o755);
      writeFileSync(
        join(fixtureBin, 'flock'),
        [
          '#!/usr/bin/env python3',
          'import fcntl,sys',
          'flags=fcntl.LOCK_EX|(fcntl.LOCK_NB if "-n" in sys.argv else 0)',
          'try:fcntl.flock(int(sys.argv[-1]),flags)',
          'except BlockingIOError:raise SystemExit(1)',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(join(fixtureBin, 'flock'), 0o755);
      writeFileSync(
        harness,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          lockConfigInstaller!,
          'exec 9<>"$4"',
          'install_release_sonar_lock_config "$1" "$2" "$3" 9 "$5" "$6"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(harness, 0o755);
      const fixtureEnv = {
        ...process.env,
        PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
      };
      const interruptedIntent = spawnSync(
        'bash',
        [harness, source, target, control, lock, String(uid), String(gid)],
        { encoding: 'utf8', env: fixtureEnv },
      );
      expect(interruptedIntent.status).not.toBe(0);
      expect(interruptedIntent.stderr).toContain(
        'active Sonar recovery state protects a different lock config',
      );
      expect(statSync(target).ino).toBe(preserved.ino);
      expect(readFileSync(target, 'utf8')).toBe(existing);

      writeFileSync(source, existing, { mode: 0o644 });
      chmodSync(source, 0o644);
      writeFileSync(
        holder,
        [
          'import fcntl,os,pathlib,sys,time',
          'descriptor=os.open(sys.argv[1],os.O_RDWR)',
          'fcntl.flock(descriptor,fcntl.LOCK_EX)',
          'pathlib.Path(sys.argv[2]).write_text("ready\\n")',
          'time.sleep(30)',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      chmodSync(holder, 0o700);
      writeFileSync(
        contendedHarness,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          lockConfigInstaller!,
          'python3 "$7" "$4" "$8" &',
          'holder_pid=$!',
          'trap \'kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true\' EXIT',
          'attempt=0',
          'while [ ! -e "$8" ]; do',
          '  attempt=$((attempt + 1))',
          '  [ "$attempt" -lt 500 ] || exit 98',
          '  sleep 0.01',
          'done',
          'exec 9<>"$4"',
          'install_release_sonar_lock_config "$1" "$2" "$3" 9 "$5" "$6"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(contendedHarness, 0o755);
      const contended = spawnSync(
        'bash',
        [
          contendedHarness,
          source,
          target,
          control,
          lock,
          String(uid),
          String(gid),
          holder,
          ready,
        ],
        { encoding: 'utf8', env: fixtureEnv, timeout: 5_000 },
      );
      expect(contended.error, contended.stderr).toBeUndefined();
      expect(contended.status).toBe(75);
      expect(contended.stderr).toContain(
        'shared release/Sonar mutex is held by another operation',
      );
      expect(statSync(target).ino).toBe(preserved.ino);
      expect(readFileSync(target, 'utf8')).toBe(existing);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('recovers a power-loss journal idempotently and retains fail-closed evidence', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-install-recovery-'));
    const root = join(realpathSync(temp), 'root');
    const state = join(root, 'var', 'lib', 'nexus-sonarqube');
    const controlParent = join(root, 'var', 'lib', 'nexus-release-promotion');
    const control = join(controlParent, 'sonarqube-install-control');
    const transaction = join(control, '.install-transaction.v2.test');
    const journal = join(control, 'asset-install-in-progress.v2');
    const journalLinkWindow = join(
      control,
      '.asset-install-in-progress.v2.999.tmp',
    );
    const program = join(control, 'install-recovery-program.v2.py');
    const recoveryReceipt = join(
      control,
      'asset-install-recovery-receipt.v1.json',
    );
    const installCommit = join(control, 'install-commit.v1.json');
    const lock = join(root, 'run', 'lock', 'nexus-release-sonar.lock');
    const systemctl = join(temp, 'systemctl');
    const existingTarget = join(root, 'usr', 'local', 'sbin', 'quality-sonar-stack');
    const newTarget = join(root, 'usr', 'local', 'sbin', 'quality-sonar-health');
    const installReceipt = join(state, 'install-receipt.v1.json');
    const lockConfig = join(
      root,
      'etc',
      'tmpfiles.d',
      'nexus-release-sonar-lock.conf',
    );
    const existingStage = join(
      root,
      'usr',
      'local',
      'sbin',
      '.nexus-sonarqube.stage.existing',
    );
    const newStage = join(
      root,
      'usr',
      'local',
      'sbin',
      '.nexus-sonarqube.stage.new',
    );
    const receiptStage = join(state, '.nexus-sonarqube.stage.receipt');
    const existingBackup = join(
      root,
      'usr',
      'local',
      'sbin',
      '.nexus-sonarqube.backup.existing',
    );
    const receiptBackup = join(state, '.nexus-sonarqube.backup.receipt');
    const plan = join(transaction, 'plan.tsv');
    const uid = process.geteuid?.() ?? 0;
    const gid = process.getegid?.() ?? 0;
    const sha = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const oldAsset = 'old reviewed stack\n';
    const newAsset = 'new reviewed stack\n';
    const newOnly = 'new reviewed health\n';
    const oldReceipt = 'prior receipt\n';
    const sourceSha = 'a'.repeat(40);
    const archiveSha = 'b'.repeat(64);
    const installTransactionId = 'c'.repeat(64);
    let newReceipt = '';

    try {
      for (const directory of [
        state,
        controlParent,
        control,
        transaction,
        join(root, 'run', 'lock'),
        join(root, 'usr', 'local', 'sbin'),
        join(root, 'etc', 'tmpfiles.d'),
      ]) {
        mkdirSync(directory, { recursive: true, mode: 0o755 });
      }
      chmodSync(control, 0o700);
      writeFileSync(
        program,
        read('scripts/quality-sonar-install-transaction.py'),
        { mode: 0o600 },
      );
      chmodSync(program, 0o600);
      writeFileSync(lock, '', { mode: 0o600 });
      chmodSync(lock, 0o600);
      writeFileSync(existingTarget, oldAsset, { mode: 0o755 });
      writeFileSync(lockConfig, 'd /run/lock 0755 root root -\n', {
        mode: 0o644,
      });
      chmodSync(lockConfig, 0o644);
      const preservedLockConfig = statSync(lockConfig);
      const receiptValue = {
        schema: 'nexus.sonarqube-asset-install.v1',
        status: 'complete',
        sourceSha,
        archiveSha256: archiveSha,
        installedAssets: 2,
        assets: [
          {
            target: existingTarget,
            sha256: sha(newAsset),
            owner: 'root:root',
            mode: '0755',
          },
          {
            target: newTarget,
            sha256: sha(newOnly),
            owner: 'root:root',
            mode: '0755',
          },
        ],
        preservedDependencies: [{
          name: 'releaseSonarLockConfig',
          target: lockConfig,
          sha256: sha(readFileSync(lockConfig, 'utf8')),
          uid: preservedLockConfig.uid,
          gid: preservedLockConfig.gid,
          mode: '0644',
          dev: preservedLockConfig.dev,
          ino: preservedLockConfig.ino,
          nlink: preservedLockConfig.nlink,
        }],
        configurationWritten: false,
        dockerTouched: false,
        servicesEnabled: false,
        installRecoveryServiceEnabled: true,
        applicationDataWritten: false,
        installedAt: '2026-07-25T00:00:00Z',
      };
      newReceipt = `${JSON.stringify(receiptValue)}\n`;
      writeFileSync(existingStage, newAsset, { mode: 0o755 });
      writeFileSync(newStage, newOnly, { mode: 0o755 });
      writeFileSync(installReceipt, oldReceipt, { mode: 0o600 });
      writeFileSync(receiptStage, newReceipt, { mode: 0o600 });
      linkSync(existingTarget, existingBackup);
      linkSync(installReceipt, receiptBackup);
      writeFileSync(
        plan,
        [
          [
            0,
            'layout',
            existingTarget,
            existingStage,
            existingBackup,
            true,
            sha(newAsset),
            uid,
            gid,
            '0755',
            sha(oldAsset),
            uid,
            gid,
            '0755',
          ].join('\t'),
          [
            1,
            'layout',
            newTarget,
            newStage,
            '-',
            false,
            sha(newOnly),
            uid,
            gid,
            '0755',
            '-',
            '-',
            '-',
            '-',
          ].join('\t'),
          [
            2,
            'receipt',
            installReceipt,
            receiptStage,
            receiptBackup,
            true,
            sha(newReceipt),
            uid,
            gid,
            '0600',
            sha(oldReceipt),
            uid,
            gid,
            '0600',
          ].join('\t'),
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
      chmodSync(plan, 0o600);
      writeFileSync(
        systemctl,
        [
          '#!/usr/bin/env bash',
          'case "$1:$2" in',
          '  daemon-reload:*) exit 0 ;;',
          '  is-active:*) printf "inactive\\n"; exit 3 ;;',
          '  is-enabled:nexus-sonarqube-install-recovery.service) printf "enabled\\n"; exit 0 ;;',
          '  is-enabled:nexus-sonarqube-backup.service) printf "static\\n"; exit 0 ;;',
          '  is-enabled:*) printf "disabled\\n"; exit 1 ;;',
          'esac',
          'exit 1',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(systemctl, 0o755);
      const baseEnv = {
        ...process.env,
        NEXUS_RELEASE_TEST_MODE: '1',
        NEXUS_SONAR_INSTALL_TEST_ROOT: root,
        NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL: systemctl,
      };
      const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
        spawnSync('python3', [program, ...args], {
          encoding: 'utf8',
          env: { ...baseEnv, ...extraEnv },
        });
      const begun = run([
        'begin',
        '--journal',
        journal,
        '--plan',
        plan,
        '--program',
        program,
        '--install-transaction-id',
        installTransactionId,
        '--source-sha',
        sourceSha,
        '--archive-sha256',
        archiveSha,
      ]);
      expect(begun.status, begun.stderr).toBe(0);
      // Simulate power loss after the exclusive journal hard link became
      // visible but before its temporary sibling was unlinked.
      linkSync(journal, journalLinkWindow);

      renameSync(existingStage, existingTarget);
      renameSync(newStage, newTarget);
      renameSync(receiptStage, installReceipt);
      for (const index of [0, 1, 2]) {
        const checkpoint = run([
          'checkpoint',
          '--journal',
          journal,
          '--program',
          program,
          '--phase',
          `committed-${index}`,
          '--committed-index',
          String(index),
        ]);
        expect(checkpoint.status, checkpoint.stderr).toBe(0);
        if (index === 0) {
          expect(() => readFileSync(journalLinkWindow, 'utf8')).toThrow();
        }
      }

      const interrupted = run(
        [
          'recover',
          '--journal',
          journal,
          '--program',
          program,
          '--receipt',
          recoveryReceipt,
          '--lock',
          lock,
        ],
        { NEXUS_SONAR_INSTALL_TEST_CRASH_AFTER_RESTORES: '1' },
      );
      expect(interrupted.status).toBe(91);
      expect(readFileSync(journal, 'utf8')).toContain(
        'nexus.sonarqube-asset-install-transaction.v3',
      );
      expect(readFileSync(installReceipt, 'utf8')).toBe(oldReceipt);

      writeFileSync(existingBackup, 'tampered predecessor\n', { mode: 0o755 });
      const rejectedDrift = run([
        'recover',
        '--journal',
        journal,
        '--program',
        program,
        '--receipt',
        recoveryReceipt,
        '--lock',
        lock,
      ]);
      expect(rejectedDrift.status).not.toBe(0);
      expect(rejectedDrift.stderr).toContain(
        'recovery predecessor',
      );
      expect(readFileSync(journal, 'utf8')).toContain(
        'nexus.sonarqube-asset-install-transaction.v3',
      );
      rmSync(existingBackup);
      writeFileSync(existingBackup, oldAsset, { mode: 0o755 });
      chmodSync(existingBackup, 0o755);

      const recovered = run([
        'recover',
        '--journal',
        journal,
        '--program',
        program,
        '--receipt',
        recoveryReceipt,
        '--lock',
        lock,
      ]);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(existingTarget, 'utf8')).toBe(oldAsset);
      expect(() => readFileSync(newTarget, 'utf8')).toThrow();
      expect(readFileSync(installReceipt, 'utf8')).toBe(oldReceipt);
      expect(() => readFileSync(journal, 'utf8')).toThrow();
      const evidence = JSON.parse(readFileSync(recoveryReceipt, 'utf8'));
      expect(evidence).toMatchObject({
        schema: 'nexus.sonarqube-asset-install-recovery.v1',
        status: 'rolled_back',
        sourceSha,
        archiveSha256: archiveSha,
        restoredAssets: 2,
        sonarRuntimeStarted: false,
      });
      expect(evidence.transactionBindingSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(lockConfig).ino).toBe(preservedLockConfig.ino);

      // A complete asset transaction records, validates, and preserves the
      // promotion-owned shared lock dependency without staging it.
      mkdirSync(transaction, { mode: 0o700 });
      writeFileSync(existingStage, newAsset, { mode: 0o755 });
      writeFileSync(newStage, newOnly, { mode: 0o755 });
      writeFileSync(receiptStage, newReceipt, { mode: 0o600 });
      linkSync(existingTarget, existingBackup);
      linkSync(installReceipt, receiptBackup);
      writeFileSync(
        plan,
        [
          [
            0, 'layout', existingTarget, existingStage, existingBackup, true,
            sha(newAsset), uid, gid, '0755', sha(oldAsset), uid, gid, '0755',
          ].join('\t'),
          [
            1, 'layout', newTarget, newStage, '-', false,
            sha(newOnly), uid, gid, '0755', '-', '-', '-', '-',
          ].join('\t'),
          [
            2, 'receipt', installReceipt, receiptStage, receiptBackup, true,
            sha(newReceipt), uid, gid, '0600', sha(oldReceipt), uid, gid, '0600',
          ].join('\t'),
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
      chmodSync(plan, 0o600);
      const successfulInstallId = '9'.repeat(64);
      const successfulBegin = run([
        'begin',
        '--journal', journal,
        '--plan', plan,
        '--program', program,
        '--install-transaction-id', successfulInstallId,
        '--source-sha', sourceSha,
        '--archive-sha256', archiveSha,
      ]);
      expect(successfulBegin.status, successfulBegin.stderr).toBe(0);
      renameSync(existingStage, existingTarget);
      renameSync(newStage, newTarget);
      renameSync(receiptStage, installReceipt);
      for (const index of [0, 1, 2]) {
        const checkpoint = run([
          'checkpoint',
          '--journal', journal,
          '--program', program,
          '--phase', `successful-committed-${index}`,
          '--committed-index', String(index),
        ]);
        expect(checkpoint.status, checkpoint.stderr).toBe(0);
      }
      const completedInstall = run([
        'complete',
        '--journal', journal,
        '--program', program,
      ]);
      expect(completedInstall.status, completedInstall.stderr).toBe(0);
      expect(readFileSync(existingTarget, 'utf8')).toBe(newAsset);
      expect(readFileSync(newTarget, 'utf8')).toBe(newOnly);
      expect(JSON.parse(readFileSync(installReceipt, 'utf8')))
        .toMatchObject({
          preservedDependencies: [{
            name: 'releaseSonarLockConfig',
            ino: preservedLockConfig.ino,
          }],
        });
      expect(statSync(lockConfig).ino).toBe(preservedLockConfig.ino);

      // Restore the predecessor fixture before modeling an interrupted
      // reinstall with an unrelated prior success marker.
      writeFileSync(existingTarget, oldAsset, { mode: 0o755 });
      rmSync(newTarget);
      writeFileSync(installReceipt, oldReceipt, { mode: 0o600 });
      chmodSync(installReceipt, 0o600);

      // A previous successful exact-SHA marker must not finalize a later
      // interrupted reinstall whose random stage/backup inventory differs.
      mkdirSync(transaction, { mode: 0o700 });
      writeFileSync(existingStage, newAsset, { mode: 0o755 });
      writeFileSync(newStage, newOnly, { mode: 0o755 });
      writeFileSync(receiptStage, newReceipt, { mode: 0o600 });
      linkSync(existingTarget, existingBackup);
      linkSync(installReceipt, receiptBackup);
      const reinstallTransactionId = 'd'.repeat(64);
      writeFileSync(
        plan,
        [
          [
            0,
            'layout',
            existingTarget,
            existingStage,
            existingBackup,
            true,
            sha(newAsset),
            uid,
            gid,
            '0755',
            sha(oldAsset),
            uid,
            gid,
            '0755',
          ].join('\t'),
          [
            1,
            'layout',
            newTarget,
            newStage,
            '-',
            false,
            sha(newOnly),
            uid,
            gid,
            '0755',
            '-',
            '-',
            '-',
            '-',
          ].join('\t'),
          [
            2,
            'receipt',
            installReceipt,
            receiptStage,
            receiptBackup,
            true,
            sha(newReceipt),
            uid,
            gid,
            '0600',
            sha(oldReceipt),
            uid,
            gid,
            '0600',
          ].join('\t'),
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
      chmodSync(plan, 0o600);
      const reinstallBegun = run([
        'begin',
        '--journal',
        journal,
        '--plan',
        plan,
        '--program',
        program,
        '--install-transaction-id',
        reinstallTransactionId,
        '--source-sha',
        sourceSha,
        '--archive-sha256',
        archiveSha,
      ]);
      expect(reinstallBegun.status, reinstallBegun.stderr).toBe(0);
      renameSync(existingStage, existingTarget);
      renameSync(newStage, newTarget);
      renameSync(receiptStage, installReceipt);
      for (const index of [0, 1, 2]) {
        const checkpoint = run([
          'checkpoint',
          '--journal',
          journal,
          '--program',
          program,
          '--phase',
          `reinstall-committed-${index}`,
          '--committed-index',
          String(index),
        ]);
        expect(checkpoint.status, checkpoint.stderr).toBe(0);
      }
      writeFileSync(
        installCommit,
        `${JSON.stringify({
          schema: 'nexus.sonarqube-install-commit.v2',
          status: 'committed',
          installTransactionId: 'e'.repeat(64),
          sourceSha,
          archiveSha256: archiveSha,
          assetTransactionBindingSha256: 'f'.repeat(64),
          directoryPlanSha256: '1'.repeat(64),
          recoveryProgramSha256: sha(
            readFileSync(program, 'utf8'),
          ),
          committedAt: '2026-07-25T00:00:00Z',
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(installCommit, 0o600);
      const autoRecovered = run([
        'auto-recover',
        '--program',
        program,
        '--lock',
        lock,
        '--asset-journal',
        journal,
        '--asset-receipt',
        recoveryReceipt,
        '--directory-journal',
        join(control, 'directory-install-in-progress.v1.json'),
        '--directory-receipt',
        join(control, 'directory-install-recovery-receipt.v1.json'),
        '--anchor-intent',
        join(control, 'recovery-anchor-enrollment-in-progress.v2.json'),
        '--anchor-receipt',
        join(control, 'recovery-anchor-enrollment.v2.json'),
        '--unenroll-journal',
        join(
          control,
          'recovery-anchor-unenrollment-in-progress.v1.json',
        ),
        '--unenroll-result',
        join(control, 'recovery-anchor-unenrollment-result.v1.json'),
        '--install-commit',
        installCommit,
      ]);
      expect(autoRecovered.status, autoRecovered.stderr).toBe(0);
      expect(readFileSync(existingTarget, 'utf8')).toBe(oldAsset);
      expect(existsSync(newTarget)).toBe(false);
      expect(readFileSync(installReceipt, 'utf8')).toBe(oldReceipt);
      const reinstallEvidence = JSON.parse(
        readFileSync(recoveryReceipt, 'utf8'),
      );
      expect(reinstallEvidence.installTransactionId).toBe(
        reinstallTransactionId,
      );
      expect(JSON.parse(readFileSync(installCommit, 'utf8')))
        .toMatchObject({ installTransactionId: 'e'.repeat(64) });
      expect(statSync(lockConfig).ino).toBe(preservedLockConfig.ino);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects incomplete installer identity before any mutation', () => {
    const result = spawnSync(
      'bash',
      ['scripts/quality-sonar-systemd-install.sh'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      '<root-owned-source-root> <40-hex-source-sha>',
    );
    expect(result.stderr).toContain(
      '<root-owned-source-archive> <64-hex-archive-sha256>',
    );
  });

  it('pins the reviewed Community Build and PostgreSQL tags by immutable manifest digest', () => {
    const lock = read('ops/sonarqube/images.lock.env');
    const resolver = read('scripts/quality-sonar-resolve-images.sh');

    expect(lock).toContain('SONARQUBE_IMAGE_TAG=26.7.0.124771-community');
    expect(lock).toMatch(/SONARQUBE_IMAGE=sonarqube:26\.7\.0\.124771-community@sha256:[0-9a-f]{64}/);
    expect(lock).toContain('POSTGRES_IMAGE_TAG=17');
    expect(lock).toMatch(/POSTGRES_IMAGE=postgres:17@sha256:[0-9a-f]{64}/);
    expect(lock).not.toMatch(/:(latest|community)(?:\s|$)/);
    expect(resolver).toContain('--verify-lock-only');
    expect(resolver).toContain('Docker Hub returned an empty registry token');

    const output = execFileSync('bash', [
      'scripts/quality-sonar-resolve-images.sh',
      '--verify-lock-only',
    ], { encoding: 'utf8' });
    expect(output).toContain('sonar_image_lock_ok mode=offline');
  });

  it('keeps the database internal and publishes Sonar only on IPv4 loopback with bounded resources', () => {
    const compose = read('ops/sonarqube/compose.yaml');
    const postgresBlock = compose.slice(compose.indexOf('  postgres:'), compose.indexOf('  sonarqube:'));

    expect(compose).toContain('127.0.0.1:9000:9000');
    expect(compose).not.toContain('0.0.0.0:9000');
    expect(postgresBlock).not.toContain('ports:');
    expect(compose).toContain('internal: true');
    expect(postgresBlock).toContain('cpus: 1.0');
    expect(postgresBlock).toContain('mem_limit: 2g');
    expect(compose).toContain('cpus: 2.0');
    expect(compose).toContain('mem_limit: 6g');
    expect(compose).toContain('soft: 131072');
    expect(compose).toContain('soft: 8192');
    expect(compose).toContain('source: /srv/sonarqube/data/postgresql');
    expect(compose).toContain('source: /srv/sonarqube/data/sonarqube');
    expect(compose).toContain('create_host_path: false');
    expect(compose.match(/restart: "no"/g)).toHaveLength(2);
    expect(compose).not.toContain('restart: unless-stopped');
    expect(compose).not.toMatch(/^volumes:\s*$/m);
    expect(compose.toLowerCase()).not.toContain('watchtower');
  });

  it('declares a root-owned layout and external mode-0600 secrets without Docker-group authority', () => {
    const layout = read('ops/sonarqube/install-layout.tsv');
    const runbook = read('ops/sonarqube/README.md');
    const stack = read('scripts/quality-sonar-stack.sh');

    expect(layout).toContain('/srv/sonarqube/compose.yaml\troot:root\t0644');
    expect(layout).toContain('/usr/local/sbin/quality-sonar-stack\troot:root\t0755');
    expect(layout).toContain('/usr/local/sbin/nexus-ollama-observation-collector.mjs\troot:root\t0700');
    expect(layout).toContain('/usr/local/sbin/ollama-soak-evidence.mjs\troot:root\t0700');
    expect(layout).toContain('/usr/local/sbin/quality-sonar-start-evidence.mjs\troot:root\t0755');
    const dataLayout = read('ops/sonarqube/data-layout.tsv');
    expect(dataLayout).toContain('/srv/sonarqube\t0:0\t0750');
    expect(dataLayout).toContain('/srv/sonarqube/data/postgresql\t999:999\t0700');
    expect(dataLayout).toContain('/srv/sonarqube/data/sonarqube\t1000:1000\t0750');
    expect(runbook).toContain('/etc/sonarqube/sonarqube.env');
    expect(runbook).toContain('mode 0600');
    expect(runbook).toContain(
      'Do not add `dominguez` or `nexus-release` to the Docker group',
    );
    expect(runbook).toContain(
      'Docker-socket ownership, group, or named-ACL access',
    );
    expect(runbook).toContain('not a release, signing, application-health, or');
    expect(stack).toContain('Sonar secrets file must have mode 0600');
    expect(stack).toContain('validate_data_layout');
    expect(stack).toContain('verify_prepulled_images');
    expect(stack).toContain('"$DOCKER_BIN" image inspect "$image"');
    expect(stack).toContain('"${compose[@]}" up -d --pull never');
    expect(stack).toContain('verify_runtime_limits');
    expect(stack).toContain('Number(postgres.NanoCpus) !== 1_000_000_000');
    expect(stack).toContain('Number(postgres.Memory) !== 2 * 1024 * 1024 * 1024');
    expect(stack).toContain('Number(sonar.NanoCpus) !== 2_000_000_000');
    expect(stack).toContain('Number(sonar.Memory) !== 6 * 1024 * 1024 * 1024');
    expect(stack).toContain(
      'rendered service image differs from the immutable image lock',
    );
    expect(stack).toContain(
      'Sonar secrets file must not override immutable image references',
    );
    expect(stack.indexOf('verify_prepulled_images')).toBeLessThan(
      stack.indexOf('"${compose[@]}" up -d --pull never'),
    );
    expect(stack).not.toMatch(/docker\s+(system\s+prune|volume\s+prune|image\s+prune)/);
  });

  it('rejects duplicate lock identities and rendered image overrides', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-image-binding-'));
    const stackDir = join(temp, 'stack');
    const bin = join(temp, 'bin');
    const secrets = join(temp, 'sonarqube.env');
    const lockPath = join(stackDir, 'images.lock.env');
    const dockerPath = join(bin, 'docker');
    const lock = read('ops/sonarqube/images.lock.env');
    const values = Object.fromEntries(
      lock
        .split('\n')
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => {
          const equals = line.indexOf('=');
          return [line.slice(0, equals), line.slice(equals + 1)];
        }),
    );
    const rendered = (postgresImage: string, sonarImage: string) => ({
      services: {
        postgres: {
          image: postgresImage,
          restart: 'no',
          cpus: 1,
          mem_limit: String(2 * 1024 * 1024 * 1024),
          ports: [],
          volumes: [{
            type: 'bind',
            source: '/srv/sonarqube/data/postgresql',
            target: '/var/lib/postgresql/data',
            bind: { create_host_path: false },
          }],
        },
        sonarqube: {
          image: sonarImage,
          restart: 'no',
          cpus: 2,
          mem_limit: String(6 * 1024 * 1024 * 1024),
          ports: [{
            host_ip: '127.0.0.1',
            published: '9000',
            target: 9000,
          }],
          volumes: [
            ['/srv/sonarqube/data/sonarqube', '/opt/sonarqube/data'],
            ['/srv/sonarqube/data/extensions', '/opt/sonarqube/extensions'],
            ['/srv/sonarqube/data/logs', '/opt/sonarqube/logs'],
            ['/srv/sonarqube/data/temp', '/opt/sonarqube/temp'],
          ].map(([source, target]) => ({
            type: 'bind',
            source,
            target,
            bind: { create_host_path: false },
          })),
        },
      },
      networks: { sonar_backend: { internal: true } },
    });
    const writeDocker = (
      postgresImage: string,
      sonarImage: string,
      resourceLimits: 'approved' | 'missing' | 'expanded' = 'approved',
    ) => {
      const value = rendered(postgresImage, sonarImage);
      if (resourceLimits === 'missing') {
        Reflect.deleteProperty(value.services.postgres, 'cpus');
        Reflect.deleteProperty(value.services.postgres, 'mem_limit');
        Reflect.deleteProperty(value.services.sonarqube, 'cpus');
        Reflect.deleteProperty(value.services.sonarqube, 'mem_limit');
      } else if (resourceLimits === 'expanded') {
        value.services.sonarqube.cpus = 4;
        value.services.sonarqube.mem_limit = String(12 * 1024 * 1024 * 1024);
      }
      writeFileSync(
        dockerPath,
        `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(value)}\nJSON\n`,
        { mode: 0o755 },
      );
      chmodSync(dockerPath, 0o755);
    };

    try {
      mkdirSync(stackDir, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(stackDir, 'compose.yaml'), 'services: {}\n');
      writeFileSync(lockPath, lock);
      writeFileSync(secrets, 'SONAR_JDBC_USERNAME=sonar\n', { mode: 0o600 });
      chmodSync(secrets, 0o600);
      writeFileSync(
        join(bin, 'id'),
        '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'stat'),
        '#!/bin/sh\ncase "$*" in *%a*|*%Lp*) echo 600 ;; *%U*|*%Su*) echo root ;; *) exec /usr/bin/stat "$@" ;; esac\n',
        { mode: 0o755 },
      );
      chmodSync(join(bin, 'id'), 0o755);
      chmodSync(join(bin, 'stat'), 0o755);

      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SONAR_STACK_DIR: stackDir,
        SONAR_SECRETS_FILE: secrets,
      };
      const run = () =>
        spawnSync('bash', ['scripts/quality-sonar-stack.sh', 'config'], {
          encoding: 'utf8',
          env,
        });

      writeDocker(values.POSTGRES_IMAGE, values.SONARQUBE_IMAGE);
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('sonarqube_compose_config_ok');

      writeDocker(values.POSTGRES_IMAGE, values.SONARQUBE_IMAGE, 'missing');
      const missingLimits = run();
      expect(missingLimits.status).not.toBe(0);
      expect(missingLimits.stderr).toContain(
        'rendered CPU or memory limits differ from the approved Sonar envelope',
      );

      writeDocker(values.POSTGRES_IMAGE, values.SONARQUBE_IMAGE, 'expanded');
      const expandedLimits = run();
      expect(expandedLimits.status).not.toBe(0);
      expect(expandedLimits.stderr).toContain(
        'rendered CPU or memory limits differ from the approved Sonar envelope',
      );

      writeDocker(values.POSTGRES_IMAGE, 'evil-local:latest');
      const renderedOverride = run();
      expect(renderedOverride.status).not.toBe(0);
      expect(renderedOverride.stderr).toContain(
        'rendered service image differs from the immutable image lock',
      );

      writeFileSync(
        secrets,
        'SONAR_JDBC_USERNAME=sonar\nSONARQUBE_IMAGE=evil-local:latest\n',
        { mode: 0o600 },
      );
      const secretOverride = run();
      expect(secretOverride.status).not.toBe(0);
      expect(secretOverride.stderr).toContain(
        'Sonar secrets file must not override immutable image references',
      );

      writeFileSync(secrets, 'SONAR_JDBC_USERNAME=sonar\n', { mode: 0o600 });
      writeFileSync(
        lockPath,
        `${lock}SONARQUBE_IMAGE=${values.SONARQUBE_IMAGE}\n`,
      );
      const duplicateLock = run();
      expect(duplicateLock.status).not.toBe(0);
      expect(duplicateLock.stderr).toContain(
        'Sonar image lock must contain exactly one SONARQUBE_IMAGE',
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps host preflight read-only while proving capacity and capturing private snapshots', () => {
    const preflight = read('scripts/quality-sonar-preflight.sh');

    expect(preflight).toContain('MIN_AVAILABLE_GIB=16');
    expect(preflight).toContain('MIN_DISK_FREE_PERCENT=20');
    expect(preflight).toContain('active_swap_io');
    expect(preflight).toContain('kernel_oom_events_last_24h');
    expect(preflight).toContain('pm2_restart_or_status_regression');
    expect(preflight).toContain('load_15_at_or_above_6');
    expect(preflight).toContain('backend=not_installed');
    expect(preflight).toContain('no_authoritative_firewall_backend_snapshot');
    expect(preflight).toContain('quality-sonar-start-evidence');
    expect(preflight).toContain(
      '"$PROC_ROOT/sys/kernel/random/boot_id"',
    );
    expect(preflight).toContain('PM2_USER=dominguez');
    expect(preflight).toContain('PM2_HOME=/home/dominguez/.pm2');
    expect(preflight).toContain('PM2_BIN=/usr/local/bin/pm2');
    expect(preflight).toContain('PM2_VERSION=6.0.14');
    expect(preflight).toContain('ROOT_NODE_BIN=/usr/bin/node');
    expect(preflight).toContain('NODE_BIN="$ROOT_NODE_BIN"');
    expect(preflight).toContain(
      'PM2_CONTROL=/usr/local/sbin/nexus-release-promotion-control',
    );
    expect(preflight).toContain('verify_root_pm2_identity');
    expect(preflight).toContain('"$PM2_CONTROL" assert-root-pm2-ready');
    expect(preflight).toContain("value.schema !== 'nexus.pm2-root-install.v1'");
    expect(preflight).toContain('value.version !== expectedVersion');
    expect(preflight).toContain('value.closureDigest');
    expect(preflight).toContain('value.payloadDigest');
    expect(preflight).not.toContain('/home/dominguez/.npm-global/bin/pm2');
    expect(preflight).toContain('RUNUSER_BIN=/usr/sbin/runuser');
    expect(preflight).toContain(
      'RUNUSER_BIN="${NEXUS_SONAR_RUNUSER_BIN:-$RUNUSER_BIN}"',
    );
    expect(preflight).toContain('CLOUDFLARED_UNIT=nexus-cloudflared.service');
    expect(preflight).toContain('"$RUNUSER_BIN" -u "$PM2_USER" --');
    expect(preflight).toContain('/usr/bin/env -i');
    expect(preflight).toContain('PM2_HOME="$PM2_HOME"');
    expect(preflight).toContain(
      '"$SYSTEMCTL_BIN" show "$CLOUDFLARED_UNIT"',
    );
    expect(preflight).not.toContain('pm2_snapshot() {\n  "$PM2_BIN" jlist');
    expect(preflight).not.toMatch(/systemctl show (?:cloudflared|cloudflared\.service)\b/);
    for (const evidence of [
      'firewall-ufw.txt',
      'firewall-nft.txt',
      'firewall-iptables.txt',
      'listeners.txt',
      'routes.txt',
      'sysctl.txt',
      'tailscale.txt',
      'cloudflare.txt',
      'health.tsv',
    ]) expect(preflight).toContain(evidence);
    expect(preflight).not.toMatch(/systemctl\s+(restart|stop|start|enable)|apt(?:-get)?\s+(install|remove)|docker\s+(run|pull|compose\s+up)/);
  });

  it('blocks Sonar preflight when the governed root PM2 authority rejects its closure', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-pm2-authority-'));
    const bin = join(temp, 'bin');
    const control = join(temp, 'nexus-release-promotion-control');
    const rootNode = join(temp, 'root-node');
    mkdirSync(bin);
    chmodSync(temp, 0o700);
    try {
      writeFileSync(
        join(bin, 'id'),
        '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'stat'),
        '#!/bin/sh\ncase "$*" in *%U:%G:%a:%h*) echo root:root:755:1 ;; *) exec /usr/bin/stat "$@" ;; esac\n',
        { mode: 0o755 },
      );
      chmodSync(join(bin, 'id'), 0o755);
      chmodSync(join(bin, 'stat'), 0o755);
      writeFileSync(
        rootNode,
        `#!/bin/sh\n[ "\${1:-}" = --version ] && { echo v22.23.1; exit 0; }\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
        { mode: 0o755 },
      );
      chmodSync(rootNode, 0o755);
      const run = () => spawnSync(
        'bash',
        ['scripts/quality-sonar-preflight.sh', '--verify-pm2-only'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            NEXUS_RELEASE_TEST_MODE: '1',
            NEXUS_SONAR_PM2_CONTROL: control,
            NEXUS_SONAR_ROOT_NODE_BIN: rootNode,
          },
        },
      );

      writeFileSync(control, '#!/bin/sh\nexit 75\n', { mode: 0o755 });
      chmodSync(control, 0o755);
      const rejected = run();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'Governed root PM2 authority rejected the installed closure',
      );

      const identity = {
        ok: true,
        schema: 'nexus.pm2-root-install.v1',
        version: '6.0.14',
        closureDigest: 'a'.repeat(64),
        payloadDigest: 'b'.repeat(64),
        packageLockSha256: 'c'.repeat(64),
        launcher: '/usr/local/bin/pm2',
        launcherSha256: 'd'.repeat(64),
        node: {
          path: rootNode,
          version: 'v22.23.1',
          sha256: 'e'.repeat(64),
        },
        entrypoint: '/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2',
      };
      writeFileSync(
        control,
        `#!/bin/sh\n[ "\${1:-}" = assert-root-pm2-ready ] || exit 64\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
        { mode: 0o755 },
      );
      chmodSync(control, 0o755);
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('root_pm2_identity_ok version=6.0.14');

      identity.version = '6.0.15';
      writeFileSync(
        control,
        `#!/bin/sh\n[ "\${1:-}" = assert-root-pm2-ready ] || exit 64\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
        { mode: 0o755 },
      );
      chmodSync(control, 0o755);
      expect(run().status).not.toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('requires fresh same-boot preflight evidence and the exact completed small-model soak/cleanup chain before stack start', () => {
    const stack = read('scripts/quality-sonar-stack.sh');
    const validator = read('scripts/quality-sonar-start-evidence.mjs');
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-sonar-start-evidence-')));
    chmodSync(temp, 0o700);
    try {
      const capacity = [
        'MEM_AVAILABLE_KIB=20971520',
        'MIN_AVAILABLE_GIB=16',
        'DISK_FREE_PERCENT=70',
        'MIN_DISK_FREE_PERCENT=20',
        'VM_MAX_MAP_COUNT=524288',
        'FS_FILE_MAX=131072',
        'LOAD_15_MILLI=1000',
        'SWAP_IN_DELTA_PAGES=0',
        'SWAP_OUT_DELTA_PAGES=0',
        'OOM_EVENTS_LAST_24H=0',
        'SAMPLE_SECONDS=10',
      ].join('\n') + '\n';
      const snapshots: Record<string, string> = {
        'capacity.env': capacity,
        'cloudflare.txt': 'ActiveState=active\n',
        'docker.txt': 'client=27.0.0 server=27.0.0\n',
        'failures.txt': '',
        'firewall-iptables.txt': 'baseline\n',
        'firewall-nft.txt': 'baseline\n',
        'firewall-ufw.txt': 'baseline\n',
        'health.tsv': 'http://127.0.0.1:8200/health\t200\t2\tdigest\n',
        'listeners.txt': 'baseline\n',
        'pm2-after.json': '{"services":[]}\n',
        'pm2-before.json': '{"services":[]}\n',
        'routes.txt': 'baseline\n',
        'runtime-authority.json': `${JSON.stringify({
          schema: 'nexus.sonarqube-runtime-authority.v1',
          status: 'passed',
          host: 'serverdominguez',
          protectedAccounts: ['dominguez', 'nexus-release'],
          containerUserIds: [999, 1000],
          dockerAuthority: 'root_socket_userns_remap',
          dockerUserns: {
            schema: 'nexus.docker-userns-map.v1',
            status: 'passed',
            daemonSetting: 'default',
            account: 'dockremap',
            rangeSize: 65536,
            subuidBase: 231072,
            subgidBase: 296608,
            postgres: {
              containerUid: 999,
              containerGid: 999,
              hostUid: 232071,
              hostGid: 297607,
            },
            sonarqube: {
              containerUid: 1000,
              containerGid: 1000,
              hostUid: 232072,
              hostGid: 297608,
            },
            dockerRootDir: '/var/lib/docker',
            namespacedRoot: '/var/lib/docker/231072.296608',
          },
          automaticUpdaterCount: 0,
        })}\n`,
        'sysctl.txt': 'baseline\n',
        'tailscale.txt': 'ActiveState=active\n',
      };
      for (const [name, contents] of Object.entries(snapshots)) {
        const path = join(temp, name);
        writeFileSync(path, contents, { mode: 0o600 });
        chmodSync(path, 0o600);
      }
      const checksumLines = Object.keys(snapshots).sort().map((name) => {
        const digest = createHash('sha256').update(readFileSync(join(temp, name))).digest('hex');
        return `${digest}  ${join(temp, name)}`;
      });
      writeFileSync(join(temp, 'checksums.sha256'), `${checksumLines.join('\n')}\n`, { mode: 0o600 });
      chmodSync(join(temp, 'checksums.sha256'), 0o600);

      const bootId = '11111111-2222-3333-4444-555555555555';
      execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs',
        'record-preflight', '--directory', temp, '--host', 'serverdominguez', '--boot-id', bootId,
      ]);

      const retained = { tag: OLLAMA_RETAINED, digest: OLLAMA_DIGESTS.get(OLLAMA_RETAINED)! };
      const deleted = OLLAMA_DELETE.map((tag) => ({ tag, digest: OLLAMA_DIGESTS.get(tag)! }));
      const now = Date.now();
      const iso = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
      const staging = createObservationFixture({
        root: temp,
        phase: 'staging',
        startedAt: iso(48.3),
        intervalSeconds: 60 * 60,
      });
      const production = createObservationFixture({
        root: temp,
        phase: 'production',
        startedAt: iso(24.2),
        intervalSeconds: 60 * 60,
        previousObservation: staging,
      });
      const soakPath = production.resultPath;
      const soakRaw = readFileSync(soakPath);
      const resultPath = join(temp, 'ollama-cleanup.json');
      writeFileSync(resultPath, `${JSON.stringify({
        schema: 'nexus.ollama-large-model-cleanup-result.v1',
        host: 'serverdominguez',
        status: 'complete',
        startedAt: iso(0.09),
        completedAt: iso(0.08),
        plan: {
          schema: 'nexus.ollama-large-model-cleanup-plan.v1',
          host: 'serverdominguez',
          evidenceDigest: `sha256:${createHash('sha256').update(soakRaw).digest('hex')}`,
          inventoryFingerprint: `sha256:${'e'.repeat(64)}`,
          observationControl: {
            staging: staging.controlRequest,
            production: production.controlRequest,
          },
          retained,
          delete: deleted,
          ackPlan: `sha256:${'f'.repeat(64)}`,
        },
        finalInventory: [retained],
        retainedDigestVerifiedBeforeAndAfter: true,
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(resultPath, 0o600);

      const collectorTestEnv = { ...process.env, NEXUS_OLLAMA_COLLECTOR_TEST_MODE: '1' };
      const output = execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', bootId,
      ], { encoding: 'utf8', env: collectorTestEnv });
      expect(JSON.parse(output).status).toBe('passed');
      expect(JSON.parse(output).observationControl).toEqual({
        staging: staging.controlRequest,
        production: production.controlRequest,
      });
      expect(JSON.parse(readFileSync(join(temp, 'result.json'), 'utf8')).dockerEngineCaptured).toBe(true);
      const exactCleanup = readFileSync(resultPath);
      const tamperedCleanup = JSON.parse(exactCleanup.toString('utf8'));
      tamperedCleanup.plan.observationControl.production.requestSha256 =
        `sha256:${'9'.repeat(64)}`;
      writeFileSync(resultPath, `${JSON.stringify(tamperedCleanup)}\n`, { mode: 0o600 });
      chmodSync(resultPath, 0o600);
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', bootId,
      ], { stdio: 'pipe', env: collectorTestEnv })).toThrow();
      writeFileSync(resultPath, exactCleanup, { mode: 0o600 });
      chmodSync(resultPath, 0o600);
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ], { stdio: 'pipe', env: collectorTestEnv })).toThrow();
      writeFileSync(
        production.requestPath,
        `${readFileSync(production.requestPath, 'utf8')} `,
        { mode: 0o600 },
      );
      expect(() => execFileSync(process.execPath, [
        'scripts/quality-sonar-start-evidence.mjs', 'verify-start',
        '--preflight-directory', temp,
        '--ollama-soak-evidence', soakPath,
        '--ollama-cleanup-result', resultPath,
        '--current-boot-id', bootId,
      ], { stdio: 'pipe', env: collectorTestEnv })).toThrow();
      expect(stack).toContain('/run/lock/nexus-release-sonar.lock');
      expect(stack).toContain('verify_start_evidence');
      expect(stack.indexOf('verify_start_evidence')).toBeLessThan(stack.indexOf('"${compose[@]}" up -d'));
      expect(validator).toContain('PREFLIGHT_TTL_MS = 2 * 60 * 60 * 1000');
      expect(validator).toContain("from './ollama-soak-evidence.mjs'");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('scans a clean exact origin/main, reuses only SHA-bound coverage, and never runs tests', () => {
    const scan = read('scripts/quality-sonar-scan.sh');

    expect(scan).toContain("fetch --quiet origin main");
    expect(scan).toContain("worktree add --quiet --detach");
    expect(scan).toContain('show "$runtime_sha:ops/sonarqube/sonar-project.properties"');
    expect(scan).toContain("status --porcelain=v1 --untracked-files=all");
    expect(scan).toContain("value.schemaVersion !== 'SonarCoverageEvidenceV1'");
    expect(scan).toContain('value.runtimeSha !== runtimeSha');
    expect(scan).toContain('coverage digest mismatch');
    expect(scan).toContain("crypto.createHash('sha256')");
    expect(read('ops/sonarqube/coverage-manifest.example.json')).toContain('SonarCoverageEvidenceV1');
    expect(scan).toContain('prod-deploy.lock');
    expect(scan).toContain('staging-deploy.lock');
    expect(scan).toContain('/run/lock/nexus-release-sonar.lock');
    expect(scan).toContain('exec 8<>"$mutex"');
    expect(scan).toContain('flock -n 8');
    expect(scan).toContain('exec 9<>"$fifo"');
    expect(scan).toContain('remote_mutex_pid');
    expect(scan).toContain('report-task.txt');
    expect(scan).toContain('/api/ce/task?id=');
    expect(scan).toContain('-Dsonar.qualitygate.wait=false');
    expect(scan).toContain("advisory: true");
    expect(scan).toContain("releaseGate: false");
    expect(scan).not.toMatch(/\b(?:npm|npx)\s+(?:test|run\s+test)|\bvitest\b|\bpytest\b|\bjest\b/);
  });

  it('uses one shared release/Sonar mutex and exposes only an exact least-privilege project CE aggregate', () => {
    const scan = read('scripts/quality-sonar-scan.sh');
    const stack = read('scripts/quality-sonar-stack.sh');
    const monitor = read('scripts/quality-sonar-release-state.sh');
    const sudoers = read('ops/sonarqube/nexus-sonar-release-monitor.sudoers');

    expect(scan).toContain('/run/lock/nexus-release-sonar.lock');
    expect(stack).toContain('/run/lock/nexus-release-sonar.lock');
    expect(stack).toContain('flock -n 8');
    expect(stack).toContain('exec 8<>"$SHARED_MUTEX"');
    expect(read('ops/sonarqube/nexus-release-sonar-lock.conf')).toContain('0660 root dominguez');
    expect(read('ops/sonarqube/install-layout.tsv'))
      .not.toContain('/etc/tmpfiles.d/nexus-release-sonar-lock.conf');
    expect(read('scripts/quality-sonar-systemd-install.sh'))
      .toContain('"preservedDependencies": [{');
    expect(read('scripts/quality-sonar-backup.sh')).toContain('/run/lock/nexus-release-sonar.lock');
    expect(read('scripts/quality-sonar-restore-drill.sh')).toContain('/run/lock/nexus-release-sonar.lock');
    expect(sudoers).toContain('/usr/local/sbin/quality-sonar-release-state --project nexus-hub-backend --json');
    expect(sudoers).toContain('NOPASSWD: NEXUS_SONAR_RELEASE_STATE');
    expect(monitor).toContain('/etc/sonarqube/release-monitor.token');
    expect(monitor).toContain('Sonar release-monitor token must have mode 0600');
    expect(monitor).toContain('--data-urlencode "component=$PROJECT_KEY"');
    expect(monitor).toContain('"$SONAR_URL/api/ce/component"');
    expect(monitor).toContain('Array.isArray(value.queue)');
    expect(monitor).toContain("value.current.status === 'IN_PROGRESS'");
    expect(monitor).toContain('seen.has(task.id)');
    expect(monitor).not.toContain('/api/ce/activity');
    expect(monitor).toContain('nexus.sonarqube-release-state.v1');
    expect(monitor).toContain('printf \'Authorization: Bearer %s\\n\' "$token" >"$auth_header"');
    expect(monitor).not.toMatch(/echo\s+[^\n]*\$token/);
  });

  it('records a sequential before/after rollout comparison and fails above 5 percent p50 or p95 regression', () => {
    const script = resolve('scripts/quality-sonar-latency-gate.mjs');
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-latency-'));
    chmodSync(temp, 0o700);
    const writeSample = (path: string, phase: 'before' | 'after', latency: number, capturedAt: string) => {
      const samplesMs = Array.from({ length: 50 }, () => latency);
      writeFileSync(path, `${JSON.stringify({
        schema: 'nexus.sonarqube-app-latency-sample.v1',
        phase,
        runtimeSha: 'a'.repeat(40),
        service: 'nexus-hub',
        url: 'http://127.0.0.1:8200/health',
        sampleCount: 50,
        warmupCount: 5,
        timeoutMs: 5000,
        p50Ms: latency,
        p95Ms: latency,
        maxMs: latency,
        samplesMs,
        capturedAt,
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    };
    try {
      const before = join(temp, 'before.json');
      const after = join(temp, 'after.json');
      const now = Date.now();
      writeSample(before, 'before', 100, new Date(now - 3 * 60_000).toISOString());
      writeSample(after, 'after', 104, new Date(now - 60_000).toISOString());
      const scan = join(temp, 'scan.json');
      writeFileSync(scan, `${JSON.stringify({
        schemaVersion: 'SonarAdvisoryScanV1',
        advisory: true,
        releaseGate: false,
        runtimeSha: 'a'.repeat(40),
        ceTaskId: 'ce-task-001',
        analysisId: 'analysis-001',
        ceStatus: 'SUCCESS',
        qualityGateStatus: 'OK',
        coverageImported: true,
        completedAt: new Date(now - 2 * 60_000).toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(scan, 0o600);
      const pass = join(temp, 'pass.json');
      execFileSync(process.execPath, [script, 'compare', '--before', before, '--after', after, '--sonar-scan-evidence', scan, '--output', pass]);
      expect(JSON.parse(readFileSync(pass, 'utf8'))).toMatchObject({
        status: 'passed',
        rolloutGate: true,
        releaseGate: false,
        maximumRegressionPercent: 5,
        p50RegressionPercent: 4,
        p95RegressionPercent: 4,
      });

      const regressed = join(temp, 'regressed.json');
      writeSample(regressed, 'after', 106, new Date(now - 30_000).toISOString());
      const failure = join(temp, 'failure.json');
      expect(() => execFileSync(process.execPath, [script, 'compare', '--before', before, '--after', regressed, '--sonar-scan-evidence', scan, '--output', failure], { stdio: 'pipe' })).toThrow();
      expect(JSON.parse(readFileSync(failure, 'utf8')).status).toBe('failed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('encrypts database backups before S3 upload, retains 7/4, and restores into fresh drill volumes', () => {
    const backup = read('scripts/quality-sonar-backup.sh');
    const backupConfig = read('ops/sonarqube/backup.env.example');
    const awsConfig = read('ops/sonarqube/aws-config.example');
    const restore = read('scripts/quality-sonar-restore-drill.sh');
    const drillCompose = read('ops/sonarqube/compose.drill.yaml');
    const backupService = read(
      'ops/sonarqube/systemd/nexus-sonarqube-backup.service',
    );
    const runbook = read('ops/sonarqube/README.md');

    expect(backup).toContain('age --encrypt');
    expect(backup.indexOf('age --encrypt')).toBeLessThan(backup.indexOf('s3api put-object'));
    expect(backup).toContain('prune_tier daily 7');
    expect(backup).toContain('prune_tier weekly 4');
    expect(backup).toContain('quality-sonar-retention.mjs');
    expect(backup).toContain('--no-paginate');
    expect(backup).toContain('--max-keys 1000');
    expect(backup).toContain('SonarRetentionEvidenceV1');
    expect(backup).toContain('distinct-utc-days-and-iso-weeks');
    expect(backup).toContain('get-bucket-versioning');
    expect(backup).toContain('value.DeleteMarker !== true');
    expect(backup).toContain(
      'Sonar retention maturity regressed below an established target',
    );
    expect(backup).toContain('pg_restore --list');
    expect(backup).toContain('--enable-timer');
    expect(backup).toContain('SONAR_AWS_LIFECYCLE_EVIDENCE');
    expect(backup).toContain(
      "lifecycle.authorization?.mode !== 'lifecycle-transition'",
    );
    expect(backup).toContain(
      'lifecycle.authorization?.lifecycle?.successfulTransition !== true',
    );
    expect(backup).toContain('postDenialPositiveCredentialsPassed');
    expect(backup).toContain('revokedCredentialProcessFailed');
    expect(backup).toContain('--verify-freshness');
    expect(backup).toContain("schemaVersion: 'SonarBackupSuccessV2'");
    expect(backup).toContain('remoteObjectVerified: true');
    expect(backup).toContain('--metadata "encrypted-sha256=$encrypted_sha256"');
    expect(backup).toContain("metadata['encrypted-sha256'] !== expectedSha256");
    expect(backup).toContain(
      "method: 'version-pinned-head-content-length-metadata-and-s3-sha256'",
    );
    expect(backup).toContain('--checksum-algorithm SHA256');
    expect(backup).toContain('--checksum-mode ENABLED');
    expect(backup).toContain('SonarRetentionPointV1');
    expect(
      backup.indexOf('attest_retained_pairs "$tier" "$plan" "$attestations"'),
    ).toBeLessThan(
      backup.indexOf('s3api delete-object', backup.indexOf('prune_tier()')),
    );
    expect(
      backup.indexOf('revalidate_retained_pairs', backup.indexOf('prune_tier()')),
    ).toBeGreaterThan(
      backup.indexOf('s3api delete-object', backup.indexOf('prune_tier()')),
    );
    expect(backup).toContain('--version-id="$object_version_id"');
    expect(backup).toContain('Buffer.from(v,"utf8")');
    expect(backup).toContain('dailyObjectVersionId');
    expect(backup).toContain('dailyChecksumVersionId');
    expect(backup).toContain('AWS_CREDENTIAL_BOUNDARY_HELPER');
    expect(backup).toContain('--helper-sha256 "$SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256"');
    expect(backupConfig).toContain('AWS_SHARED_CREDENTIALS_FILE=/dev/null');
    expect(backupConfig).toContain('AWS_PROFILE=nexus-sonarqube-backup');
    expect(backupConfig).toContain(
      'SONAR_AWS_LIFECYCLE_EVIDENCE=/var/lib/nexus-sonarqube/aws/'
      + 'lifecycle-transition.v3.json',
    );
    expect(backupConfig).toContain(
      'SONAR_BACKUP_AWS_ROLE_ARN=arn:aws:iam::111122223333:role/nexus-sonarqube-backup',
    );
    expect(backupConfig).toContain(
      'SONAR_RESTORE_AWS_PROFILE=nexus-sonarqube-restore',
    );
    expect(backupConfig).toContain(
      'SONAR_RESTORE_AWS_ROLE_ARN=arn:aws:iam::111122223333:role/nexus-sonarqube-restore',
    );
    expect(backupConfig).not.toMatch(/^AWS_ACCESS_KEY_ID=/m);
    expect(backupConfig).not.toMatch(/^AWS_SECRET_ACCESS_KEY=/m);
    expect(awsConfig).toContain('[profile nexus-sonarqube-backup]');
    expect(awsConfig).toContain('[profile nexus-sonarqube-restore]');
    expect(awsConfig).toContain('nexus-sonarqube-aws-signing-helper credential-process');
    expect(backup).toContain('systemctl enable --now "$BACKUP_TIMER"');
    expect(backupService).toContain('Restart=on-failure');
    expect(backupService).toContain('RestartSec=15min');
    expect(backupService).toContain('TimeoutStartSec=30min');
    expect(runbook).toContain(
      'installation alone intentionally leaves the timer disabled',
    );
    expect(runbook).toContain('--max-age-hours 26');
    expect(runbook).toContain('AWS_SHARED_CREDENTIALS_FILE=/dev/null');
    expect(restore).toContain('age --decrypt');
    expect(restore).toContain('export AWS_PROFILE="$SONAR_RESTORE_AWS_PROFILE"');
    expect(restore).toContain('AWS_CREDENTIAL_BOUNDARY_HELPER');
    expect(restore).toContain('--backup-version-id');
    expect(restore).toContain('--checksum-version-id');
    expect(restore).toContain('--version-id="$BACKUP_VERSION_ID"');
    expect(restore).toContain('--version-id="$CHECKSUM_VERSION_ID"');
    expect(restore).toContain("Buffer.from(value, 'utf8')");
    expect(restore).toContain('Refusing restore drill while the live advisory Sonar stack is running');
    expect(restore).toContain('freshElasticsearchVolume: true');
    expect(restore).toContain('reindexStartupVerified: true');
    expect(restore).toContain('down --volumes --remove-orphans');
    expect(restore).toContain(
      'RESTORE_EVIDENCE_DIR=/var/lib/nexus-sonarqube/restore-evidence',
    );
    expect(restore).toContain('fs.constants.O_NOFOLLOW');
    expect(restore).toContain('fs.linkSync(stage, output)');
    expect(restore).toContain('evidence output must be a new path');
    expect(restore).not.toContain('mkdir -p "$(dirname "$OUTPUT")"');
    expect(drillCompose).toContain('127.0.0.1:19000:9000');
    expect(drillCompose).toContain('drill_sonarqube_data');
  });

  it('retains complete Sonar backup pairs by distinct UTC day and ISO week', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-retention-'));
    const helper = resolve('scripts/quality-sonar-retention.mjs');
    const makeKey = (tier: 'daily' | 'weekly', timestamp: string) =>
      `nexus-hub/sonarqube/${tier}/nexus-sonarqube-${timestamp}.dump.age`;
    const pair = (tier: 'daily' | 'weekly', timestamp: string) => {
      const key = makeKey(tier, timestamp);
      return [{ Key: key }, { Key: `${key}.sha256` }];
    };
    const runPlan = (
      tier: 'daily' | 'weekly',
      retain: number,
      timestamps: string[],
      protectedTimestamp: string,
      stem: string,
    ) => {
      const prefix = `nexus-hub/sonarqube/${tier}/`;
      const listing = join(temp, `${stem}-before.json`);
      const plan = join(temp, `${stem}-plan.json`);
      writeFileSync(
        listing,
        `${JSON.stringify({
          IsTruncated: false,
          Contents: timestamps.flatMap((timestamp) => pair(tier, timestamp)),
        })}\n`,
      );
      execFileSync(process.execPath, [
        helper,
        'plan',
        '--listing',
        listing,
        '--prefix',
        prefix,
        '--tier',
        tier,
        '--retain',
        String(retain),
        '--protected-key',
        makeKey(tier, protectedTimestamp),
        '--output',
        plan,
      ]);
      return { prefix, plan, value: JSON.parse(readFileSync(plan, 'utf8')) };
    };

    try {
      const daily = runPlan(
        'daily',
        7,
        [
          '20260724T120000Z',
          '20260724T110000Z',
          '20260723T120000Z',
          '20260722T120000Z',
          '20260721T120000Z',
          '20260720T120000Z',
          '20260719T120000Z',
          '20260718T120000Z',
          '20260717T120000Z',
        ],
        '20260724T120000Z',
        'daily',
      );
      expect(daily.value.selectedPeriods).toEqual([
        '2026-07-24',
        '2026-07-23',
        '2026-07-22',
        '2026-07-21',
        '2026-07-20',
        '2026-07-19',
        '2026-07-18',
      ]);
      expect(daily.value.deleteKeys).toContain(
        makeKey('daily', '20260724T110000Z'),
      );
      expect(daily.value.deleteKeys).toContain(
        `${makeKey('daily', '20260717T120000Z')}.sha256`,
      );

      const dailyAfter = join(temp, 'daily-after.json');
      writeFileSync(
        dailyAfter,
        `${JSON.stringify({
          IsTruncated: false,
          Contents: daily.value.selectedKeys.flatMap((key: string) => [
            { Key: key },
            { Key: `${key}.sha256` },
          ]),
        })}\n`,
      );
      const dailyInventoryEvidence = join(
        temp,
        'daily-inventory-evidence.json',
      );
      execFileSync(process.execPath, [
        helper,
        'verify',
        '--listing',
        dailyAfter,
        '--prefix',
        daily.prefix,
        '--tier',
        'daily',
        '--retain',
        '7',
        '--plan',
        daily.plan,
        '--output',
        dailyInventoryEvidence,
      ]);
      const dailyInventory = JSON.parse(
        readFileSync(dailyInventoryEvidence, 'utf8'),
      );
      expect(dailyInventory).toMatchObject({
        retainedDistinctPeriods: 7,
        targetReached: true,
        maturityStatus: 'mature',
        completePairNamesVerified: true,
        completePairsVerified: false,
        excessObjectsAbsent: true,
      });
      const dailyAttestations = join(temp, 'daily-attestations.jsonl');
      const dataChecksumSha256 = Buffer.from(
        'a'.repeat(64),
        'hex',
      ).toString('base64');
      const checksumObjectChecksumSha256 = Buffer.from(
        'b'.repeat(64),
        'hex',
      ).toString('base64');
      writeFileSync(
        dailyAttestations,
        `${dailyInventory.selectedKeys
          .map((key: string, index: number) =>
            JSON.stringify({
              schemaVersion: 'SonarRetentionPointV1',
              tier: 'daily',
              period: dailyInventory.selectedPeriods[index],
              key,
              checksumKey: `${key}.sha256`,
              dataVersionId: `--opaque-data-${index}-✓|`,
              checksumVersionId: `--opaque-checksum-${index}-✓|`,
              encryptedSha256: 'a'.repeat(64),
              encryptedSizeBytes: 1024 + index,
              checksumSizeBytes: 120,
              dataChecksumSha256,
              checksumObjectChecksumSha256,
            }))
          .join('\n')}\n`,
      );
      const dailyEvidence = join(temp, 'daily-evidence.json');
      execFileSync(process.execPath, [
        helper,
        'bind',
        '--evidence',
        dailyInventoryEvidence,
        '--attestations',
        dailyAttestations,
        '--output',
        dailyEvidence,
      ]);
      expect(JSON.parse(readFileSync(dailyEvidence, 'utf8'))).toMatchObject({
        retainedDistinctPeriods: 7,
        targetReached: true,
        completePairsVerified: true,
        remotePairsVerified: true,
        postPruneVerified: true,
      });

      const weekly = runPlan(
        'weekly',
        4,
        [
          '20260104T120000Z',
          '20260103T120000Z',
          '20251228T120000Z',
          '20251221T120000Z',
          '20251214T120000Z',
          '20251207T120000Z',
        ],
        '20260104T120000Z',
        'weekly',
      );
      expect(weekly.value.selectedPeriods).toEqual([
        '2026-W01',
        '2025-W52',
        '2025-W51',
        '2025-W50',
      ]);
      expect(weekly.value.deleteKeys).toContain(
        makeKey('weekly', '20260103T120000Z'),
      );
      expect(weekly.value.deleteKeys).toContain(
        makeKey('weekly', '20251207T120000Z'),
      );

      const warming = runPlan(
        'daily',
        7,
        ['20260724T120000Z', '20260723T120000Z'],
        '20260724T120000Z',
        'warming',
      );
      const warmingAfter = join(temp, 'warming-after.json');
      writeFileSync(
        warmingAfter,
        `${JSON.stringify({
          IsTruncated: false,
          Contents: warming.value.selectedKeys.flatMap((key: string) => [
            { Key: key },
            { Key: `${key}.sha256` },
          ]),
        })}\n`,
      );
      const warmingEvidence = join(temp, 'warming-evidence.json');
      execFileSync(process.execPath, [
        helper,
        'verify',
        '--listing',
        warmingAfter,
        '--prefix',
        warming.prefix,
        '--tier',
        'daily',
        '--retain',
        '7',
        '--plan',
        warming.plan,
        '--output',
        warmingEvidence,
      ]);
      expect(JSON.parse(readFileSync(warmingEvidence, 'utf8'))).toMatchObject({
        retainedDistinctPeriods: 2,
        targetReached: false,
        maturityStatus: 'warming',
        completePairsVerified: false,
      });

      const orphanListing = join(temp, 'orphan.json');
      const orphanPlan = join(temp, 'orphan-plan.json');
      writeFileSync(
        orphanListing,
        `${JSON.stringify({
          IsTruncated: false,
          Contents: [{ Key: makeKey('daily', '20260724T120000Z') }],
        })}\n`,
      );
      expect(() =>
        execFileSync(process.execPath, [
          helper,
          'plan',
          '--listing',
          orphanListing,
          '--prefix',
          'nexus-hub/sonarqube/daily/',
          '--tier',
          'daily',
          '--retain',
          '7',
          '--protected-key',
          makeKey('daily', '20260724T120000Z'),
          '--output',
          orphanPlan,
        ], { stdio: 'pipe' }),
      ).toThrow();

      const truncatedListing = join(temp, 'truncated.json');
      writeFileSync(
        truncatedListing,
        `${JSON.stringify({ IsTruncated: true, Contents: [] })}\n`,
      );
      expect(() =>
        execFileSync(process.execPath, [
          helper,
          'plan',
          '--listing',
          truncatedListing,
          '--prefix',
          'nexus-hub/sonarqube/daily/',
          '--tier',
          'daily',
          '--retain',
          '7',
          '--output',
          join(temp, 'truncated-plan.json'),
        ], { stdio: 'pipe' }),
      ).toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails closed when the remote Sonar backup success receipt is stale or invalid', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-backup-freshness-'));
    const bin = join(temp, 'bin');
    const receipt = join(temp, 'last-backup-success.v2.json');
    mkdirSync(bin);
    chmodSync(temp, 0o700);
    const writeReceipt = (
      completedAt: string,
      remoteObjectVerified = true,
      dailyObjectVersionId = '--opaque-daily-✓|1',
      dailyChecksumVersionId = '--opaque-checksum-✓|2',
    ) => {
      const dailyKey =
        'nexus-hub/sonarqube/daily/nexus-sonarqube-20260724T120000Z.dump.age';
      writeFileSync(receipt, `${JSON.stringify({
        schemaVersion: 'SonarBackupSuccessV2',
        encrypted: true,
        remoteObjectVerified,
        dailyKey,
        encryptedSha256: 'a'.repeat(64),
        encryptedSizeBytes: 1234,
        dailyObjectVersionId,
        dailyChecksumVersionId,
        weeklyUploaded: false,
        weeklyKey: null,
        weeklyObjectVersionId: null,
        weeklyChecksumVersionId: null,
        remoteVerification: {
          method:
            'version-pinned-head-content-length-metadata-and-s3-sha256',
          daily: true,
          weekly: false,
        },
        retention: {
          daily: 7,
          weekly: 4,
          basis: 'distinct-utc-days-and-iso-weeks',
        },
        retentionEvidence: {
          daily: {
            schemaVersion: 'SonarRetentionEvidenceV1',
            tier: 'daily',
            periodKind: 'utc-day',
            targetDistinctPeriods: 7,
            retainedDistinctPeriods: 1,
            targetReached: false,
            maturityStatus: 'warming',
            selectedPeriods: ['2026-07-24'],
            selectedKeys: [dailyKey],
            selectedPoints: [{
              schemaVersion: 'SonarRetentionPointV1',
              tier: 'daily',
              period: '2026-07-24',
              key: dailyKey,
              checksumKey: `${dailyKey}.sha256`,
              dataVersionId: dailyObjectVersionId,
              checksumVersionId: dailyChecksumVersionId,
              encryptedSha256: 'a'.repeat(64),
              encryptedSizeBytes: 1234,
              checksumSizeBytes: 120,
              dataChecksumSha256: Buffer.from(
                'a'.repeat(64),
                'hex',
              ).toString('base64'),
              checksumObjectChecksumSha256: Buffer.from(
                'b'.repeat(64),
                'hex',
              ).toString('base64'),
            }],
            protectedKeyVerified: true,
            completePairNamesVerified: true,
            completePairsVerified: true,
            remotePairsVerified: true,
            postPruneVerified: true,
            excessObjectsAbsent: true,
            verifiedAt: completedAt,
          },
          weekly: {
            schemaVersion: 'SonarRetentionEvidenceV1',
            tier: 'weekly',
            periodKind: 'iso-week',
            targetDistinctPeriods: 4,
            retainedDistinctPeriods: 0,
            targetReached: false,
            maturityStatus: 'warming',
            selectedPeriods: [],
            selectedKeys: [],
            selectedPoints: [],
            protectedKeyVerified: false,
            completePairNamesVerified: true,
            completePairsVerified: true,
            remotePairsVerified: true,
            postPruneVerified: true,
            excessObjectsAbsent: true,
            verifiedAt: completedAt,
          },
        },
        completedAt,
      })}\n`, { mode: 0o600 });
      chmodSync(receipt, 0o600);
    };
    try {
      writeFileSync(
        join(bin, 'id'),
        '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'stat'),
        '#!/bin/sh\ncase "$*" in *%U:%G:%a:%h*) echo root:root:600:1 ;; *) exec /usr/bin/stat "$@" ;; esac\n',
        { mode: 0o755 },
      );
      chmodSync(join(bin, 'id'), 0o755);
      chmodSync(join(bin, 'stat'), 0o755);
      const run = () => spawnSync(
        'bash',
        [
          'scripts/quality-sonar-backup.sh',
          '--verify-freshness',
          '--max-age-hours',
          '26',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            NEXUS_RELEASE_TEST_MODE: '1',
            SONAR_BACKUP_SUCCESS_RECEIPT: receipt,
          },
        },
      );

      writeReceipt(new Date().toISOString());
      const fresh = run();
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(fresh.stdout).toContain('sonar_backup_fresh');

      const falseFloor = JSON.parse(readFileSync(receipt, 'utf8'));
      falseFloor.retentionEvidence.daily.retainedDistinctPeriods = 7;
      falseFloor.retentionEvidence.daily.targetReached = true;
      falseFloor.retentionEvidence.daily.maturityStatus = 'mature';
      writeFileSync(receipt, `${JSON.stringify(falseFloor)}\n`, { mode: 0o600 });
      chmodSync(receipt, 0o600);
      expect(run().status).not.toBe(0);

      writeReceipt(new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString());
      expect(run().status).not.toBe(0);

      writeReceipt(new Date().toISOString(), false);
      expect(run().status).not.toBe(0);

      writeReceipt(new Date().toISOString(), true, 'null');
      expect(run().status).not.toBe(0);

      writeReceipt(new Date().toISOString(), true, '--opaque-daily-✓|1', 'null');
      expect(run().status).not.toBe(0);

      writeReceipt(new Date().toISOString(), true, 'é'.repeat(512), 'é'.repeat(512));
      expect(run().status).toBe(0);

      for (const unsafe of [
        'unsafe\nversion',
        'unsafe\u007fversion',
        `${'é'.repeat(512)}a`,
      ]) {
        writeReceipt(new Date().toISOString(), true, unsafe, unsafe);
        expect(run().status).not.toBe(0);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps every shell asset syntactically valid', () => {
    const scripts = [
      'quality-sonar-backup.sh',
      'quality-sonar-health.sh',
      'quality-sonar-preflight.sh',
      'quality-sonar-resolve-images.sh',
      'quality-sonar-release-state.sh',
      'quality-sonar-restore-drill.sh',
      'quality-sonar-scan.sh',
      'quality-sonar-stack.sh',
      'quality-sonar-systemd-install.sh',
    ];
    for (const script of scripts) {
      expect(() => execFileSync('bash', ['-n', `scripts/${script}`])).not.toThrow();
    }
    for (const script of [
      'ollama-observation-collector.mjs',
      'ollama-soak-evidence.mjs',
      'quality-sonar-start-evidence.mjs',
      'quality-sonar-latency-gate.mjs',
      'quality-sonar-retention.mjs',
    ]) {
      expect(() => execFileSync(process.execPath, ['--check', `scripts/${script}`])).not.toThrow();
    }
  });
});
