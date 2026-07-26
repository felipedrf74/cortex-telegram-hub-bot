import { spawnSync } from 'node:child_process';
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_SHA = 'a'.repeat(40);
const ARCHIVE_SHA = 'b'.repeat(64);
const USERNS_SHA = 'c'.repeat(64);
const INSTALL_TRANSACTION_ID = 'd'.repeat(64);

describe('SonarQube install directory transaction', () => {
  it('recovers exact empty transaction-created directories child-first before Sonar state exists', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-directory-tx-'));
    const root = join(realpathSync(temp), 'root');
    const controlParent = join(root, 'var/lib/nexus-release-promotion');
    const control = join(controlParent, 'sonarqube-install-control');
    const controlIntent = join(
      controlParent,
      'sonarqube-install-control-in-progress.v1.json',
    );
    const controlReceipt = join(
      controlParent,
      'sonarqube-install-control.v1.json',
    );
    const program = join(control, 'install-recovery-program.v2.py');
    const plan = join(control, '.directory-plan.test');
    const journal = join(control, 'directory-install-in-progress.v1.json');
    const receipt = join(
      control,
      'directory-install-recovery-receipt.v1.json',
    );
    const lock = join(root, 'run/lock/nexus-release-sonar.lock');
    const systemctl = join(temp, 'systemctl');
    const uid = process.geteuid?.() ?? 0;
    const gid = process.getegid?.() ?? 0;
    const paths = [
      '/usr/local/sbin/lib',
      '/etc/systemd/system/ollama.service.d',
      '/etc/sonarqube',
      '/var/lib/nexus-sonarqube',
      '/var/lib/nexus-sonarqube/restore-evidence',
      '/srv/sonarqube',
      '/srv/sonarqube/data',
      '/srv/sonarqube/data/postgresql',
      '/srv/sonarqube/data/sonarqube',
      '/srv/sonarqube/data/extensions',
      '/srv/sonarqube/data/logs',
      '/srv/sonarqube/data/temp',
    ].map((path) => join(root, path));
    const modes = [
      0o755, 0o755, 0o700, 0o700, 0o700, 0o750,
      0o750, 0o700, 0o750, 0o750, 0o750, 0o750,
    ];

    try {
      for (const directory of [
        root,
        controlParent,
        join(root, 'run/lock'),
        join(root, 'usr/local/sbin'),
        join(root, 'etc/systemd/system'),
        join(root, 'srv'),
      ]) {
        mkdirSync(directory, { recursive: true, mode: 0o755 });
      }
      mkdirSync(paths[0], { mode: modes[0] });
      const preserved = statSync(paths[0]);
      const boundaryEnv = {
        ...process.env,
        NEXUS_RELEASE_TEST_MODE: '1',
        NEXUS_SONAR_INSTALL_TEST_ROOT: root,
      };
      const bootstrapArgs = [
        resolve('scripts/quality-sonar-install-transaction.py'),
        'bootstrap-control-root',
        '--parent', controlParent,
        '--root', control,
        '--intent', controlIntent,
        '--receipt', controlReceipt,
        '--source-sha', SOURCE_SHA,
        '--archive-sha256', ARCHIVE_SHA,
      ];
      const interruptedBootstrap = spawnSync('python3', bootstrapArgs, {
        encoding: 'utf8',
        env: {
          ...boundaryEnv,
          NEXUS_SONAR_INSTALL_TEST_CRASH_CONTROL_ROOT: 'after-mkdir',
        },
      });
      expect(interruptedBootstrap.status).toBe(95);
      expect((statSync(control).mode & 0o7777)).toBe(0o700);
      expect(existsSync(controlIntent)).toBe(true);
      const interruptedReceipt = spawnSync('python3', bootstrapArgs, {
        encoding: 'utf8',
        env: {
          ...boundaryEnv,
          NEXUS_SONAR_INSTALL_TEST_CRASH_CONTROL_ROOT: 'after-receipt',
        },
      });
      expect(interruptedReceipt.status).toBe(95);
      expect(existsSync(controlIntent)).toBe(true);
      expect(existsSync(controlReceipt)).toBe(true);
      const resumedBootstrap = spawnSync('python3', bootstrapArgs, {
        encoding: 'utf8',
        env: boundaryEnv,
      });
      expect(resumedBootstrap.status, resumedBootstrap.stderr).toBe(0);
      expect(existsSync(controlIntent)).toBe(false);
      expect(existsSync(controlReceipt)).toBe(true);
      writeFileSync(
        program,
        readFileSync(resolve('scripts/quality-sonar-install-transaction.py')),
        { mode: 0o600 },
      );
      chmodSync(program, 0o600);
      writeFileSync(lock, '', { mode: 0o600 });
      chmodSync(lock, 0o600);
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

      const rows = paths.map((path, index) => {
        if (index === 0) {
          return [
            index, path, uid, gid, modes[index].toString(8).padStart(4, '0'),
            true, preserved.uid, preserved.gid,
            (preserved.mode & 0o7777).toString(8).padStart(4, '0'),
            preserved.dev, preserved.ino,
          ].join('\t');
        }
        return [
          index, path, uid, gid, modes[index].toString(8).padStart(4, '0'),
          false, '-', '-', '-', '-', '-',
        ].join('\t');
      });
      writeFileSync(plan, `${rows.join('\n')}\n`, { mode: 0o600 });
      chmodSync(plan, 0o600);

      const baseEnv = {
        ...boundaryEnv,
        NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL: systemctl,
      };
      const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
        spawnSync('python3', [program, ...args], {
          encoding: 'utf8',
          env: { ...baseEnv, ...extraEnv },
        });
      const begun = run([
        'begin-directories',
        '--journal', journal,
        '--plan', plan,
        '--program', program,
        '--install-transaction-id', INSTALL_TRANSACTION_ID,
        '--source-sha', SOURCE_SHA,
        '--archive-sha256', ARCHIVE_SHA,
        '--userns-map-sha256', USERNS_SHA,
      ]);
      expect(begun.status, begun.stderr).toBe(0);
      const prepared = JSON.parse(readFileSync(journal, 'utf8'));
      expect(prepared.phase).toBe('prepared');
      expect(prepared.directories[0]).toMatchObject({
        path: paths[0],
        hadDirectory: true,
        predecessorDev: preserved.dev,
        predecessorIno: preserved.ino,
      });
      expect(existsSync(join(root, 'var/lib/nexus-sonarqube'))).toBe(false);

      for (let index = 0; index <= 8; index += 1) {
        const created = run(
          [
            'create-directory',
            '--journal', journal,
            '--program', program,
            '--index', String(index),
          ],
          index === 8
            ? { NEXUS_SONAR_INSTALL_TEST_CRASH_DIRECTORY: 'after-mkdir:8' }
            : {},
        );
        expect(created.status, created.stderr).toBe(index === 8 ? 92 : 0);
      }
      const interrupted = JSON.parse(readFileSync(journal, 'utf8'));
      expect(interrupted.directories[8].state).toBe('creating');
      expect(existsSync(paths[8])).toBe(true);
      // Model power loss between mkdir and the final chmod. A `creating`
      // checkpoint may safely bind the installer's restrictive bootstrap mode.
      chmodSync(paths[8], 0o700);

      const marker = join(paths[8], 'not-empty');
      writeFileSync(marker, 'do not delete\n');
      const autoArgs = [
        'auto-recover',
        '--program', program,
        '--lock', lock,
        '--asset-journal', join(control, 'asset-install-in-progress.v2'),
        '--asset-receipt',
        join(control, 'asset-install-recovery-receipt.v1.json'),
        '--directory-journal', journal,
        '--directory-receipt', receipt,
        '--anchor-intent',
        join(control, 'recovery-anchor-enrollment-in-progress.v2.json'),
        '--anchor-receipt',
        join(control, 'recovery-anchor-enrollment.v2.json'),
        '--unenroll-journal',
        join(control, 'recovery-anchor-unenrollment-in-progress.v1.json'),
        '--unenroll-result',
        join(control, 'recovery-anchor-unenrollment-result.v1.json'),
        '--install-commit', join(control, 'install-commit.v1.json'),
      ];
      const rejected = run(autoArgs);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'transaction-created directory is not empty',
      );
      expect(existsSync(journal)).toBe(true);

      rmSync(marker);
      const recovered = run(autoArgs);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(statSync(paths[0]).ino).toBe(preserved.ino);
      for (const path of paths.slice(1)) {
        expect(existsSync(path)).toBe(false);
      }
      expect(existsSync(join(root, 'var/lib/nexus-sonarqube'))).toBe(false);
      expect(existsSync(journal)).toBe(false);
      const evidence = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(evidence).toMatchObject({
        schema: 'nexus.sonarqube-directory-install-recovery.v1',
        status: 'rolled_back',
        preservedDirectories: 1,
        removedDirectories: 8,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('requires exact owner acknowledgments and resumes anchor removal while preserving predecessors', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nexus-sonar-anchor-tx-'));
    const root = join(realpathSync(temp), 'root');
    const control = join(
      root,
      'var/lib/nexus-release-promotion/sonarqube-install-control',
    );
    const sourceRoot = join(root, 'bootstrap/source');
    const sourceProgram = join(
      sourceRoot,
      'scripts/quality-sonar-install-transaction.py',
    );
    const sourceUnit = join(
      sourceRoot,
      'ops/sonarqube/systemd/nexus-sonarqube-install-recovery.service',
    );
    const sourceLockConfig = join(
      sourceRoot,
      'ops/sonarqube/nexus-release-sonar-lock.conf',
    );
    const retained = join(control, 'install-recovery-program.v2.py');
    const installed = join(
      root,
      'usr/local/sbin/quality-sonar-install-transaction.py',
    );
    const targetUnit = join(
      root,
      'etc/systemd/system/nexus-sonarqube-install-recovery.service',
    );
    const targetLockConfig = join(
      root,
      'etc/tmpfiles.d/nexus-release-sonar-lock.conf',
    );
    const wants = join(
      root,
      'etc/systemd/system/multi-user.target.wants/' +
        'nexus-sonarqube-install-recovery.service',
    );
    const continuationUnit = join(
      root,
      'etc/systemd/system/' +
        'nexus-sonarqube-anchor-unenroll-recovery.service',
    );
    const continuationWants = join(
      root,
      'etc/systemd/system/multi-user.target.wants/' +
        'nexus-sonarqube-anchor-unenroll-recovery.service',
    );
    const intent = join(
      control,
      'recovery-anchor-enrollment-in-progress.v2.json',
    );
    const receipt = join(control, 'recovery-anchor-enrollment.v2.json');
    const journal = join(
      control,
      'recovery-anchor-unenrollment-in-progress.v1.json',
    );
    const result = join(
      control,
      'recovery-anchor-unenrollment-result.v1.json',
    );
    const resultArchive = join(
      control,
      'recovery-anchor-unenrollment-result-archive.v1.json',
    );
    const cleanupGeneration = join(
      control,
      'recovery-anchor-cleanup-generation.v1.json',
    );
    const lock = join(root, 'run/lock/nexus-release-sonar.lock');
    const systemctl = join(temp, 'systemctl');
    const systemctlLog = join(temp, 'systemctl.log');
    const systemdAnalyze = join(temp, 'systemd-analyze');
    const tmpfiles = join(temp, 'systemd-tmpfiles');
    const systemdPython = join(temp, 'systemd-python');

    try {
      for (const directory of [
        control,
        join(sourceRoot, 'scripts'),
        join(sourceRoot, 'ops/sonarqube/systemd'),
        join(root, 'usr/local/sbin'),
        join(root, 'etc/systemd/system/multi-user.target.wants'),
        join(root, 'etc/tmpfiles.d'),
        join(root, 'run/lock'),
      ]) {
        mkdirSync(directory, { recursive: true, mode: 0o755 });
      }
      chmodSync(control, 0o700);
      writeFileSync(
        sourceProgram,
        readFileSync(resolve('scripts/quality-sonar-install-transaction.py')),
        { mode: 0o600 },
      );
      chmodSync(sourceProgram, 0o600);
      writeFileSync(
        sourceUnit,
        readFileSync(
          resolve(
            'ops/sonarqube/systemd/' +
              'nexus-sonarqube-install-recovery.service',
          ),
        ),
        { mode: 0o644 },
      );
      chmodSync(sourceUnit, 0o644);
      writeFileSync(
        sourceLockConfig,
        readFileSync(resolve('ops/sonarqube/nexus-release-sonar-lock.conf')),
        { mode: 0o644 },
      );
      chmodSync(sourceLockConfig, 0o644);
      writeFileSync(lock, '', { mode: 0o600 });
      chmodSync(lock, 0o600);
      writeFileSync(
        systemctl,
        [
          '#!/usr/bin/env bash',
          'root="${NEXUS_SONAR_INSTALL_TEST_ROOT:?}"',
          'log="${NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL_LOG:?}"',
          'printf "%s:%s\\n" "$1" "${2:-}" >> "$log"',
          'primary=nexus-sonarqube-install-recovery.service',
          'continuation=nexus-sonarqube-anchor-unenroll-recovery.service',
          'wants_for() {',
          '  printf "%s/etc/systemd/system/multi-user.target.wants/%s" "$root" "$1"',
          '}',
          'case "$1:$2" in',
          '  daemon-reload:*) exit 0 ;;',
          '  enable:$primary|enable:$continuation)',
          '    wants="$(wants_for "$2")"',
          '    [ -L "$wants" ] || /bin/ln -s "../$2" "$wants"',
          '    exit 0 ;;',
          '  disable:$primary|disable:$continuation)',
          '    /bin/rm -f "$(wants_for "$2")"; exit 0 ;;',
          '  stop:*) exit 97 ;;',
          '  show:$primary)',
          '    case "${3:-}" in',
          '      --property=InvocationID)',
          '        printf "%s\\n" "${INVOCATION_ID:-}"; exit 0 ;;',
          '      --property=ExecMainPID)',
          '        printf "%s\\n" "${SYSTEMD_EXEC_PID:-}"; exit 0 ;;',
          '      --property=FragmentPath)',
          '        printf "%s/etc/systemd/system/%s\\n" "$root" "$primary";',
          '        exit 0 ;;',
          '      --property=Type)',
          '        printf "oneshot\\n"; exit 0 ;;',
          '      --property=RemainAfterExit)',
          '        printf "no\\n"; exit 0 ;;',
          '    esac',
          '    exit 1 ;;',
          '  is-active:$primary)',
          '    if [ "${NEXUS_SONAR_TEST_PRIMARY_ACTIVE:-0}" = 1 ]; then',
          '      printf "activating\\n"; exit 0',
          '    fi',
          '    printf "inactive\\n"; exit 3 ;;',
          '  is-active:*) printf "inactive\\n"; exit 3 ;;',
          '  is-enabled:$primary|is-enabled:$continuation)',
          '    wants="$(wants_for "$2")"',
          '    if [ -L "$wants" ]; then printf "enabled\\n"; exit 0; fi',
          '    printf "disabled\\n"; exit 1 ;;',
          '  is-enabled:nexus-sonarqube-backup.service)',
          '    printf "static\\n"; exit 0 ;;',
          '  is-enabled:*) printf "disabled\\n"; exit 1 ;;',
          'esac',
          'exit 1',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(systemctl, 0o755);
      writeFileSync(
        systemdPython,
        [
          '#!/bin/sh',
          'SYSTEMD_EXEC_PID=$$',
          'export SYSTEMD_EXEC_PID',
          'exec python3 "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(systemdPython, 0o755);
      for (const executable of [systemdAnalyze, tmpfiles]) {
        writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        chmodSync(executable, 0o755);
      }

      const baseEnv = {
        ...process.env,
        NEXUS_RELEASE_TEST_MODE: '1',
        NEXUS_SONAR_INSTALL_TEST_ROOT: root,
        NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL: systemctl,
        NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL_LOG: systemctlLog,
        NEXUS_SONAR_INSTALL_TEST_SYSTEMD_ANALYZE: systemdAnalyze,
        NEXUS_SONAR_INSTALL_TEST_TMPFILES: tmpfiles,
      };
      const run = (
        executable: string,
        args: string[],
        extraEnv: NodeJS.ProcessEnv = {},
      ) =>
        spawnSync('python3', [executable, ...args], {
          encoding: 'utf8',
          env: { ...baseEnv, ...extraEnv },
        });
      const runAsPrimaryOneshot = (
        executable: string,
        args: string[],
      ) =>
        spawnSync(systemdPython, [executable, ...args], {
          encoding: 'utf8',
          env: {
            ...baseEnv,
            INVOCATION_ID: 'e'.repeat(32),
            NEXUS_SONAR_TEST_PRIMARY_ACTIVE: '1',
          },
        });
      const enrollArgs = [
        'enroll-anchors',
        '--intent', intent,
        '--receipt', receipt,
        '--source-root', sourceRoot,
        '--source-sha', SOURCE_SHA,
        '--archive-sha256', ARCHIVE_SHA,
      ];
      const missingGlobalLockConfig = run(sourceProgram, enrollArgs);
      expect(
        missingGlobalLockConfig.status,
        missingGlobalLockConfig.stderr,
      ).not.toBe(0);
      expect(missingGlobalLockConfig.stderr).toContain(
        'shared release/Sonar tmpfiles config must preexist',
      );
      expect(existsSync(intent)).toBe(false);
      expect(existsSync(retained)).toBe(false);

      writeFileSync(targetLockConfig, readFileSync(sourceLockConfig), {
        mode: 0o644,
      });
      chmodSync(targetLockConfig, 0o644);
      const preservedLock = statSync(targetLockConfig);
      const interruptedEnrollment = run(
        sourceProgram,
        enrollArgs,
        { NEXUS_SONAR_INSTALL_TEST_CRASH_ANCHOR: 'after-receipt' },
      );
      expect(interruptedEnrollment.status).toBe(93);
      expect(existsSync(intent)).toBe(true);
      expect(existsSync(receipt)).toBe(true);
      const enrolled = run(sourceProgram, enrollArgs);
      expect(enrolled.status, enrolled.stderr).toBe(0);
      expect(existsSync(intent)).toBe(false);
      expect(existsSync(retained)).toBe(true);
      expect(existsSync(installed)).toBe(true);
      expect(existsSync(targetUnit)).toBe(true);
      expect(existsSync(wants)).toBe(true);
      expect(statSync(targetLockConfig).ino).toBe(preservedLock.ino);

      const originalLockLink = join(temp, 'preserved-lock-config');
      const replacementLock = join(temp, 'replacement-lock-config');
      linkSync(targetLockConfig, originalLockLink);
      writeFileSync(replacementLock, readFileSync(targetLockConfig), {
        mode: 0o644,
      });
      chmodSync(replacementLock, 0o644);
      renameSync(replacementLock, targetLockConfig);
      const rejectedReplacedDependency = run(retained, [
        'validate-anchor-current',
        '--receipt', receipt,
      ]);
      expect(rejectedReplacedDependency.status).not.toBe(0);
      expect(rejectedReplacedDependency.stderr).toContain(
        'inode identity differs',
      );
      renameSync(originalLockLink, targetLockConfig);
      expect(statSync(targetLockConfig).ino).toBe(preservedLock.ino);

      const installReceipt = join(
        root,
        'var/lib/nexus-sonarqube/install-receipt.v1.json',
      );
      mkdirSync(join(root, 'var/lib/nexus-sonarqube'), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(installReceipt, '{}\n', { mode: 0o600 });
      chmodSync(installReceipt, 0o600);
      const guarded = run(retained, [
        'anchor-plan',
        '--receipt', receipt,
        '--lock', lock,
      ]);
      expect(guarded.status).not.toBe(0);
      expect(guarded.stderr).toContain(
        'anchor unenrollment is blocked by',
      );
      rmSync(installReceipt);

      const planned = run(retained, [
        'anchor-plan',
        '--receipt', receipt,
        '--lock', lock,
      ]);
      expect(planned.status, planned.stderr).toBe(0);
      const planValue = JSON.parse(planned.stdout);
      expect(planValue.steps.at(-1)).toBe(
        'remove-retainedRecoveryProgram',
      );
      expect(planValue.preservedAnchors).toContain('lockConfig');

      const unauthorized = run(retained, [
        'anchor-unenroll',
        '--receipt', receipt,
        '--journal', journal,
        '--result', result,
        '--lock', lock,
        '--ack-plan', planValue.ackPlan,
        '--ack-receipt', planValue.ackReceipt,
      ]);
      expect(unauthorized.status).not.toBe(0);
      expect(unauthorized.stderr).toContain('--owner-authorized is required');

      const wrongAcknowledgment = run(
        retained,
        [
          'anchor-unenroll',
          '--receipt', receipt,
          '--journal', journal,
          '--result', result,
          '--lock', lock,
          '--ack-plan', `sha256:${'d'.repeat(64)}`,
          '--ack-receipt', planValue.ackReceipt,
          '--owner-authorized',
        ],
        { NEXUS_SONAR_OWNER_AUTHORIZED: '1' },
      );
      expect(wrongAcknowledgment.status).not.toBe(0);
      expect(wrongAcknowledgment.stderr).toContain(
        'plan acknowledgment is invalid',
      );

      const interrupted = run(
        retained,
        [
          'anchor-unenroll',
          '--receipt', receipt,
          '--journal', journal,
          '--result', result,
          '--lock', lock,
          '--ack-plan', planValue.ackPlan,
          '--ack-receipt', planValue.ackReceipt,
          '--owner-authorized',
        ],
        {
          NEXUS_SONAR_OWNER_AUTHORIZED: '1',
          NEXUS_SONAR_INSTALL_TEST_CRASH_UNENROLL:
            'remove-retainedRecoveryProgram',
        },
      );
      expect(interrupted.status, interrupted.stderr).toBe(94);
      expect(existsSync(journal)).toBe(true);
      expect(existsSync(retained)).toBe(true);
      expect(existsSync(targetUnit)).toBe(false);
      expect(existsSync(continuationUnit)).toBe(true);
      expect(existsSync(continuationWants)).toBe(true);

      const activePrimary = spawnSync(
        systemctl,
        ['is-active', 'nexus-sonarqube-install-recovery.service'],
        {
          encoding: 'utf8',
          env: {
            ...baseEnv,
            NEXUS_SONAR_TEST_PRIMARY_ACTIVE: '1',
          },
        },
      );
      expect(activePrimary.status, activePrimary.stderr).toBe(0);
      expect(activePrimary.stdout.trim()).toBe('activating');

      const resumed = run(
        retained,
        [
          'auto-recover',
          '--program', retained,
          '--lock', lock,
          '--asset-journal', join(control, 'asset-install-in-progress.v2'),
          '--asset-receipt',
          join(control, 'asset-install-recovery-receipt.v1.json'),
          '--directory-journal',
          join(control, 'directory-install-in-progress.v1.json'),
          '--directory-receipt',
          join(control, 'directory-install-recovery-receipt.v1.json'),
          '--anchor-intent', intent,
          '--anchor-receipt', receipt,
          '--unenroll-journal', journal,
          '--unenroll-result', result,
          '--install-commit', join(control, 'install-commit.v1.json'),
        ],
        { NEXUS_SONAR_TEST_PRIMARY_ACTIVE: '1' },
      );
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(existsSync(retained)).toBe(false);
      expect(existsSync(installed)).toBe(false);
      expect(existsSync(targetUnit)).toBe(false);
      expect(existsSync(wants)).toBe(false);
      expect(existsSync(continuationUnit)).toBe(false);
      expect(existsSync(continuationWants)).toBe(false);
      expect(existsSync(receipt)).toBe(false);
      expect(existsSync(journal)).toBe(false);
      expect(statSync(targetLockConfig).ino).toBe(preservedLock.ino);
      const terminal = JSON.parse(readFileSync(result, 'utf8'));
      expect(terminal).toMatchObject({
        schema:
          'nexus.sonarqube-recovery-anchor-unenrollment-result.v1',
        status: 'complete',
        preservedAnchors: ['lockConfig'],
        retainedProgramRemovedLast: true,
      });
      expect(terminal.completedCleanupSteps.at(-1)).toBe(
        'remove-retainedRecoveryProgram',
      );
      expect(terminal.cleanupBindingSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(terminal.continuationAuthorityRemovedAfterCommit).toBe(true);
      const firstGeneration = JSON.parse(
        readFileSync(cleanupGeneration, 'utf8'),
      );
      expect(statSync(cleanupGeneration).mode & 0o7777).toBe(0o600);
      expect(statSync(cleanupGeneration).nlink).toBe(1);
      expect(firstGeneration).toMatchObject({
        schema:
          'nexus.sonarqube-recovery-anchor-cleanup-generation.v1',
        status: 'current',
        cleanupBindingSha256: terminal.cleanupBindingSha256,
        receiptBindingSha256: terminal.receiptBindingSha256,
        predecessorCleanupBindingSha256: null,
      });
      expect(readFileSync(systemctlLog, 'utf8')).toContain(
        'is-active:nexus-sonarqube-install-recovery.service',
      );
      expect(readFileSync(systemctlLog, 'utf8')).not.toContain('stop:');

      const completedResult = readFileSync(result, 'utf8');
      const retiredFirstResult = run(sourceProgram, [
        'retire-anchor-cleanup-result',
        '--result', result,
        '--archive', resultArchive,
        '--lock', lock,
      ]);
      expect(retiredFirstResult.status, retiredFirstResult.stderr).toBe(0);
      expect(existsSync(result)).toBe(false);
      expect(existsSync(cleanupGeneration)).toBe(true);
      expect(JSON.parse(readFileSync(resultArchive, 'utf8')))
        .toMatchObject({
          status: 'complete',
          cleanupBindingSha256: terminal.cleanupBindingSha256,
        });

      writeFileSync(retained, readFileSync(sourceProgram), { mode: 0o600 });
      chmodSync(retained, 0o600);
      writeFileSync(targetUnit, readFileSync(sourceUnit), { mode: 0o644 });
      chmodSync(targetUnit, 0o644);
      symlinkSync(
        '../nexus-sonarqube-install-recovery.service',
        wants,
      );
      const preservedRetained = statSync(retained);
      const preservedPrimaryUnit = statSync(targetUnit);
      expect(readFileSync(targetUnit, 'utf8')).not.toContain(
        'RemainAfterExit=',
      );
      const reenrolled = run(sourceProgram, enrollArgs);
      expect(reenrolled.status, reenrolled.stderr).toBe(0);
      const normalInstallerRerun = run(sourceProgram, enrollArgs);
      expect(
        normalInstallerRerun.status,
        normalInstallerRerun.stderr,
      ).toBe(0);
      expect(existsSync(result)).toBe(false);
      expect(existsSync(receipt)).toBe(true);
      const secondReceipt = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(
        secondReceipt.anchors.find(
          (anchor: { name: string }) =>
            anchor.name === 'retainedRecoveryProgram',
        ).createdFromAbsence,
      ).toBe(false);
      expect(
        secondReceipt.anchors.find(
          (anchor: { name: string }) => anchor.name === 'recoveryUnit',
        ).createdFromAbsence,
      ).toBe(false);
      const secondPlan = run(retained, [
        'anchor-plan',
        '--receipt', receipt,
        '--lock', lock,
      ]);
      expect(secondPlan.status, secondPlan.stderr).toBe(0);
      const secondPlanValue = JSON.parse(secondPlan.stdout);
      expect(secondPlanValue.steps).toEqual([
        'enroll-unenrollRecoveryUnit',
        'remove-installedRecoveryProgram',
      ]);
      const secondReversal = run(
        retained,
        [
          'anchor-unenroll',
          '--receipt', receipt,
          '--journal', journal,
          '--result', result,
          '--lock', lock,
          '--ack-plan', secondPlanValue.ackPlan,
          '--ack-receipt', secondPlanValue.ackReceipt,
          '--owner-authorized',
        ],
        {
          NEXUS_SONAR_OWNER_AUTHORIZED: '1',
          NEXUS_SONAR_INSTALL_TEST_CRASH_UNENROLL:
            'remove-installedRecoveryProgram',
        },
      );
      expect(secondReversal.status, secondReversal.stderr).toBe(94);
      expect(existsSync(journal)).toBe(true);
      expect(existsSync(result)).toBe(false);
      expect(existsSync(receipt)).toBe(true);
      expect(existsSync(continuationUnit)).toBe(true);
      expect(existsSync(continuationWants)).toBe(true);

      const autoRecoverArgs = [
        'auto-recover',
        '--program', retained,
        '--lock', lock,
        '--asset-journal', join(control, 'asset-install-in-progress.v2'),
        '--asset-receipt',
        join(control, 'asset-install-recovery-receipt.v1.json'),
        '--directory-journal',
        join(control, 'directory-install-in-progress.v1.json'),
        '--directory-receipt',
        join(control, 'directory-install-recovery-receipt.v1.json'),
        '--anchor-intent', intent,
        '--anchor-receipt', receipt,
        '--unenroll-journal', journal,
        '--unenroll-result', result,
        '--install-commit', join(control, 'install-commit.v1.json'),
      ];
      const rejectedUnboundInvoker = run(
        retained,
        autoRecoverArgs,
        { NEXUS_SONAR_TEST_PRIMARY_ACTIVE: '1' },
      );
      expect(rejectedUnboundInvoker.status).not.toBe(0);
      expect(rejectedUnboundInvoker.stderr).toContain(
        'preexisting recovery service active state changed',
      );
      expect(existsSync(journal)).toBe(true);
      expect(existsSync(result)).toBe(false);

      const completedSecondCleanup = runAsPrimaryOneshot(
        retained,
        autoRecoverArgs,
      );
      expect(
        completedSecondCleanup.status,
        completedSecondCleanup.stderr,
      ).toBe(0);
      expect(existsSync(journal)).toBe(false);
      expect(existsSync(receipt)).toBe(false);
      expect(existsSync(continuationUnit)).toBe(false);
      expect(existsSync(continuationWants)).toBe(false);
      expect(existsSync(retained)).toBe(true);
      expect(existsSync(targetUnit)).toBe(true);
      expect(existsSync(wants)).toBe(true);
      expect(statSync(retained).ino).toBe(preservedRetained.ino);
      expect(statSync(targetUnit).ino).toBe(preservedPrimaryUnit.ino);
      expect(readFileSync(systemctlLog, 'utf8')).not.toContain('stop:');
      const secondTerminal = JSON.parse(readFileSync(result, 'utf8'));
      expect(secondTerminal.cleanupBindingSha256).not.toBe(
        terminal.cleanupBindingSha256,
      );
      const secondCompletedResult = readFileSync(result, 'utf8');
      const secondGeneration = JSON.parse(
        readFileSync(cleanupGeneration, 'utf8'),
      );
      expect(secondGeneration).toMatchObject({
        status: 'current',
        cleanupBindingSha256: secondTerminal.cleanupBindingSha256,
        receiptBindingSha256: secondTerminal.receiptBindingSha256,
        predecessorCleanupBindingSha256:
          terminal.cleanupBindingSha256,
      });

      writeFileSync(result, completedResult, { mode: 0o600 });
      const rejectedCompletedReplay = run(sourceProgram, [
        'resume-anchor-cleanup',
        '--result', result,
        '--lock', lock,
      ]);
      expect(rejectedCompletedReplay.status).not.toBe(0);
      expect(rejectedCompletedReplay.stderr).toContain(
        'active anchor-cleanup result is not the current generation',
      );

      writeFileSync(result, completedResult, { mode: 0o600 });
      const rejectedTerminalReplay = run(sourceProgram, [
        'retire-anchor-cleanup-result',
        '--result', result,
        '--archive', resultArchive,
        '--lock', lock,
      ]);
      expect(rejectedTerminalReplay.status).not.toBe(0);
      expect(rejectedTerminalReplay.stderr).toContain(
        'active anchor-cleanup result is not the current generation',
      );
      expect(JSON.parse(readFileSync(cleanupGeneration, 'utf8')))
        .toMatchObject({
          cleanupBindingSha256: secondTerminal.cleanupBindingSha256,
        });
      expect(JSON.parse(readFileSync(resultArchive, 'utf8')))
        .toMatchObject({
          cleanupBindingSha256: terminal.cleanupBindingSha256,
        });

      writeFileSync(result, secondCompletedResult, { mode: 0o600 });
      const interruptedSecondRetirement = run(
        sourceProgram,
        [
          'retire-anchor-cleanup-result',
          '--result', result,
          '--archive', resultArchive,
          '--lock', lock,
        ],
        {
          NEXUS_SONAR_INSTALL_TEST_CRASH_ANCHOR_RETIRE:
            'after-archive-write',
        },
      );
      expect(
        interruptedSecondRetirement.status,
        interruptedSecondRetirement.stderr,
      ).toBe(92);
      expect(existsSync(result)).toBe(true);
      expect(JSON.parse(readFileSync(resultArchive, 'utf8')))
        .toMatchObject({
          cleanupBindingSha256: secondTerminal.cleanupBindingSha256,
        });

      const retiredSecondResult = run(sourceProgram, [
        'retire-anchor-cleanup-result',
        '--result', result,
        '--archive', resultArchive,
        '--lock', lock,
      ]);
      expect(retiredSecondResult.status, retiredSecondResult.stderr).toBe(0);
      expect(existsSync(result)).toBe(false);
      expect(JSON.parse(readFileSync(resultArchive, 'utf8')))
        .toMatchObject({
          status: 'complete',
          cleanupBindingSha256: secondTerminal.cleanupBindingSha256,
        });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps a boot-resume authority through power loss at every systemd reversal step', () => {
    const crashPhases = [
      'continuation-unit-created',
      'continuation-enabled',
      'disable-recovery-service',
      'remove-recoveryUnit',
      'reload-systemd',
      'after-reversal-commit',
      'cleanup-remove-anchor-receipt',
      'cleanup-disable-continuation-service',
      'cleanup-remove-continuation-unit',
      'cleanup-reload-systemd-after-continuation',
      'cleanup-remove-retainedRecoveryProgram',
    ] as const;
    let staleCleanupResult: string | undefined;

    for (const crashPhase of crashPhases) {
      const temp = mkdtempSync(
        join(tmpdir(), `nexus-sonar-anchor-${crashPhase}-`),
      );
      const root = join(realpathSync(temp), 'root');
      const control = join(
        root,
        'var/lib/nexus-release-promotion/sonarqube-install-control',
      );
      const sourceRoot = join(root, 'bootstrap/source');
      const sourceProgram = join(
        sourceRoot,
        'scripts/quality-sonar-install-transaction.py',
      );
      const sourceUnit = join(
        sourceRoot,
        'ops/sonarqube/systemd/' +
          'nexus-sonarqube-install-recovery.service',
      );
      const sourceLockConfig = join(
        sourceRoot,
        'ops/sonarqube/nexus-release-sonar-lock.conf',
      );
      const targetLockConfig = join(
        root,
        'etc/tmpfiles.d/nexus-release-sonar-lock.conf',
      );
      const retained = join(control, 'install-recovery-program.v2.py');
      const primaryUnit = join(
        root,
        'etc/systemd/system/nexus-sonarqube-install-recovery.service',
      );
      const primaryWants = join(
        root,
        'etc/systemd/system/multi-user.target.wants/' +
          'nexus-sonarqube-install-recovery.service',
      );
      const continuationUnit = join(
        root,
        'etc/systemd/system/' +
          'nexus-sonarqube-anchor-unenroll-recovery.service',
      );
      const continuationWants = join(
        root,
        'etc/systemd/system/multi-user.target.wants/' +
          'nexus-sonarqube-anchor-unenroll-recovery.service',
      );
      const intent = join(
        control,
        'recovery-anchor-enrollment-in-progress.v2.json',
      );
      const receipt = join(control, 'recovery-anchor-enrollment.v2.json');
      const journal = join(
        control,
        'recovery-anchor-unenrollment-in-progress.v1.json',
      );
      const result = join(
        control,
        'recovery-anchor-unenrollment-result.v1.json',
      );
      const resultArchive = join(
        control,
        'recovery-anchor-unenrollment-result-archive.v1.json',
      );
      const lock = join(root, 'run/lock/nexus-release-sonar.lock');
      const systemctl = join(temp, 'systemctl');
      const systemctlLog = join(temp, 'systemctl.log');
      const systemdAnalyze = join(temp, 'systemd-analyze');
      const tmpfiles = join(temp, 'systemd-tmpfiles');

      try {
        for (const directory of [
          control,
          join(sourceRoot, 'scripts'),
          join(sourceRoot, 'ops/sonarqube/systemd'),
          join(root, 'usr/local/sbin'),
          join(root, 'etc/systemd/system/multi-user.target.wants'),
          join(root, 'etc/tmpfiles.d'),
          join(root, 'run/lock'),
        ]) {
          mkdirSync(directory, { recursive: true, mode: 0o755 });
        }
        chmodSync(control, 0o700);
        writeFileSync(
          sourceProgram,
          readFileSync(
            resolve('scripts/quality-sonar-install-transaction.py'),
          ),
          { mode: 0o600 },
        );
        chmodSync(sourceProgram, 0o600);
        writeFileSync(
          sourceUnit,
          readFileSync(
            resolve(
              'ops/sonarqube/systemd/' +
                'nexus-sonarqube-install-recovery.service',
            ),
          ),
          { mode: 0o644 },
        );
        chmodSync(sourceUnit, 0o644);
        writeFileSync(
          sourceLockConfig,
          readFileSync(
            resolve('ops/sonarqube/nexus-release-sonar-lock.conf'),
          ),
          { mode: 0o644 },
        );
        chmodSync(sourceLockConfig, 0o644);
        writeFileSync(targetLockConfig, readFileSync(sourceLockConfig), {
          mode: 0o644,
        });
        chmodSync(targetLockConfig, 0o644);
        const preservedLockConfig = statSync(targetLockConfig);
        writeFileSync(
          systemctl,
          [
            '#!/usr/bin/env bash',
            'root="${NEXUS_SONAR_INSTALL_TEST_ROOT:?}"',
            'log="${NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL_LOG:?}"',
            'printf "%s:%s\\n" "$1" "${2:-}" >> "$log"',
            'primary=nexus-sonarqube-install-recovery.service',
            'continuation=nexus-sonarqube-anchor-unenroll-recovery.service',
            'wants_for() {',
            '  printf "%s/etc/systemd/system/multi-user.target.wants/%s" "$root" "$1"',
            '}',
            'case "$1:$2" in',
            '  daemon-reload:*) exit 0 ;;',
            '  enable:$primary|enable:$continuation)',
            '    wants="$(wants_for "$2")"',
            '    [ -L "$wants" ] || /bin/ln -s "../$2" "$wants"',
            '    exit 0 ;;',
            '  disable:$primary|disable:$continuation)',
            '    /bin/rm -f "$(wants_for "$2")"; exit 0 ;;',
            '  stop:*) exit 97 ;;',
            '  is-active:$primary)',
            '    if [ "${NEXUS_SONAR_TEST_PRIMARY_ACTIVE:-0}" = 1 ]; then',
            '      printf "activating\\n"; exit 0',
            '    fi',
            '    printf "inactive\\n"; exit 3 ;;',
            '  is-active:*) printf "inactive\\n"; exit 3 ;;',
            '  is-enabled:$primary|is-enabled:$continuation)',
            '    wants="$(wants_for "$2")"',
            '    if [ -L "$wants" ]; then printf "enabled\\n"; exit 0; fi',
            '    if [ -f "$root/etc/systemd/system/$2" ]; then',
            '      printf "disabled\\n"; exit 1',
            '    fi',
            '    printf "not-found\\n"; exit 4 ;;',
            '  is-enabled:nexus-sonarqube-backup.service)',
            '    printf "static\\n"; exit 0 ;;',
            '  is-enabled:*) printf "disabled\\n"; exit 1 ;;',
            'esac',
            'exit 1',
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
        chmodSync(systemctl, 0o755);
        writeFileSync(systemdAnalyze, '#!/bin/sh\nexit 0\n', {
          mode: 0o755,
        });
        chmodSync(systemdAnalyze, 0o755);
        writeFileSync(
          tmpfiles,
          [
            '#!/usr/bin/env bash',
            'set -eu',
            'root="${NEXUS_SONAR_INSTALL_TEST_ROOT:?}"',
            'config="$root/etc/tmpfiles.d/nexus-release-sonar-lock.conf"',
            'lock="$root/run/lock/nexus-release-sonar.lock"',
            '[ "${1:-}" = --create ]',
            '[ "${2:-}" = "$config" ]',
            '[ -f "$config" ] && [ ! -L "$config" ]',
            ': >"$lock"',
            'chmod 0600 "$lock"',
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
        chmodSync(tmpfiles, 0o755);

        const baseEnv = {
          ...process.env,
          INVOCATION_ID: `boot-${crashPhase}`,
          SYSTEMD_EXEC_PID: String(process.pid),
          NEXUS_RELEASE_TEST_MODE: '1',
          NEXUS_SONAR_INSTALL_TEST_ROOT: root,
          NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL: systemctl,
          NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL_LOG: systemctlLog,
          NEXUS_SONAR_INSTALL_TEST_SYSTEMD_ANALYZE: systemdAnalyze,
          NEXUS_SONAR_INSTALL_TEST_TMPFILES: tmpfiles,
        };
        const run = (
          executable: string,
          args: string[],
          extraEnv: NodeJS.ProcessEnv = {},
        ) =>
          spawnSync('python3', [executable, ...args], {
            encoding: 'utf8',
            env: { ...baseEnv, ...extraEnv },
          });
        const enrollArgs = [
          'enroll-anchors',
          '--intent', intent,
          '--receipt', receipt,
          '--source-root', sourceRoot,
          '--source-sha', SOURCE_SHA,
          '--archive-sha256', ARCHIVE_SHA,
        ];
        const enrolled = run(sourceProgram, enrollArgs);
        expect(enrolled.status, `${crashPhase}: ${enrolled.stderr}`).toBe(0);
        const planned = run(retained, [
          'anchor-plan',
          '--receipt', receipt,
          '--lock', lock,
        ]);
        expect(planned.status, `${crashPhase}: ${planned.stderr}`).toBe(0);
        const planValue = JSON.parse(planned.stdout);
        expect(planValue.steps[0]).toBe('enroll-unenrollRecoveryUnit');
        expect(planValue.steps).not.toContain('stop-recovery-service');
        expect(planValue.steps).not.toContain('remove-lockConfig');
        expect(planValue.preservedAnchors).toContain('lockConfig');

        const interrupted = run(
          retained,
          [
            'anchor-unenroll',
            '--receipt', receipt,
            '--journal', journal,
            '--result', result,
            '--lock', lock,
            '--ack-plan', planValue.ackPlan,
            '--ack-receipt', planValue.ackReceipt,
            '--owner-authorized',
          ],
          {
            NEXUS_SONAR_OWNER_AUTHORIZED: '1',
            NEXUS_SONAR_INSTALL_TEST_CRASH_UNENROLL: crashPhase,
          },
        );
        expect(
          interrupted.status,
          `${crashPhase}: ${interrupted.stderr}`,
        ).toBe(94);
        expect(statSync(targetLockConfig).ino).toBe(
          preservedLockConfig.ino,
        );
        rmSync(lock);
        expect(existsSync(lock)).toBe(false);
        const bootTmpfiles = spawnSync(
          tmpfiles,
          ['--create', targetLockConfig],
          {
            encoding: 'utf8',
            env: baseEnv,
          },
        );
        expect(
          bootTmpfiles.status,
          `${crashPhase}: ${bootTmpfiles.stderr}`,
        ).toBe(0);
        expect(existsSync(lock)).toBe(true);
        expect(statSync(targetLockConfig).ino).toBe(
          preservedLockConfig.ino,
        );
        const postCommit =
          crashPhase === 'after-reversal-commit' ||
          crashPhase.startsWith('cleanup-');
        if (postCommit) {
          expect(existsSync(journal)).toBe(false);
          expect(existsSync(result)).toBe(true);
          const cleanupValue = JSON.parse(readFileSync(result, 'utf8'));
          expect(cleanupValue.status).toBe('cleanup_pending');
          expect(cleanupValue.continuationAuthority.unitPath).toBe(
            continuationUnit,
          );
          expect(cleanupValue.continuationAuthority.wantsLink).toBe(
            continuationWants,
          );
          if (crashPhase === 'after-reversal-commit') {
            expect(cleanupValue.currentCleanupStep).toBeNull();
            expect(existsSync(receipt)).toBe(true);
            expect(existsSync(continuationUnit)).toBe(true);
            expect(existsSync(continuationWants)).toBe(true);
            expect(existsSync(retained)).toBe(true);
            expect(readFileSync(continuationUnit, 'utf8')).toContain(
              'ConditionPathExists=|' +
                '/var/lib/nexus-release-promotion/' +
                'sonarqube-install-control/' +
                'recovery-anchor-unenrollment-result.v1.json',
            );
            const untampered = readFileSync(result, 'utf8');
            staleCleanupResult = untampered;
            const originalValue = JSON.parse(untampered);
            const tamperedValues = [
              {
                ...originalValue,
                removedAnchors: originalValue.removedAnchors.slice(1),
              },
              {
                ...originalValue,
                preservedAnchors: [],
              },
              {
                ...originalValue,
                completedSteps: originalValue.completedSteps.slice(0, -1),
              },
              {
                ...originalValue,
                cleanupBindingSha256: '0'.repeat(64),
              },
            ];
            for (const tamperedValue of tamperedValues) {
              writeFileSync(result, `${JSON.stringify(tamperedValue)}\n`, {
                mode: 0o600,
              });
              const rejectedTamper = run(sourceProgram, [
                'resume-anchor-cleanup',
                '--result', result,
                '--lock', lock,
              ]);
              expect(
                rejectedTamper.status,
                `${crashPhase}: ${rejectedTamper.stderr}`,
              ).not.toBe(0);
            }
            writeFileSync(result, untampered, { mode: 0o600 });
          } else {
            expect(cleanupValue.currentCleanupStep).toBe(
              crashPhase.replace('cleanup-', ''),
            );
          }
          if (
            crashPhase === 'cleanup-remove-anchor-receipt' &&
            staleCleanupResult
          ) {
            const currentResult = readFileSync(result, 'utf8');
            writeFileSync(result, staleCleanupResult, { mode: 0o600 });
            const rejectedReplay = run(sourceProgram, [
              'resume-anchor-cleanup',
              '--result', result,
              '--lock', lock,
            ]);
            expect(
              rejectedReplay.status,
              `${crashPhase}: ${rejectedReplay.stderr}`,
            ).not.toBe(0);
            writeFileSync(result, currentResult, { mode: 0o600 });
          }
          if (crashPhase === 'cleanup-remove-anchor-receipt') {
            expect(existsSync(receipt)).toBe(false);
            expect(existsSync(continuationWants)).toBe(true);
            expect(existsSync(retained)).toBe(true);
          }
          if (crashPhase === 'cleanup-disable-continuation-service') {
            expect(existsSync(receipt)).toBe(false);
            expect(existsSync(continuationUnit)).toBe(true);
            expect(existsSync(continuationWants)).toBe(false);
            expect(existsSync(retained)).toBe(true);
          }
          if (
            crashPhase === 'cleanup-remove-continuation-unit' ||
            crashPhase ===
              'cleanup-reload-systemd-after-continuation'
          ) {
            expect(existsSync(receipt)).toBe(false);
            expect(existsSync(continuationUnit)).toBe(false);
            expect(existsSync(continuationWants)).toBe(false);
            expect(existsSync(retained)).toBe(true);
          }
          if (
            crashPhase === 'cleanup-remove-retainedRecoveryProgram'
          ) {
            expect(existsSync(receipt)).toBe(false);
            expect(existsSync(continuationUnit)).toBe(false);
            expect(existsSync(continuationWants)).toBe(false);
            expect(existsSync(retained)).toBe(false);
          }
        } else {
          expect(existsSync(journal)).toBe(true);
          expect(existsSync(retained)).toBe(true);
          const journalValue = JSON.parse(readFileSync(journal, 'utf8'));
          if (crashPhase === 'continuation-unit-created') {
            expect(existsSync(primaryUnit)).toBe(true);
            expect(existsSync(primaryWants)).toBe(true);
            expect(existsSync(continuationUnit)).toBe(true);
            expect(existsSync(continuationWants)).toBe(false);
            expect(journalValue.continuationAuthority.state).toBe(
              'planned',
            );
          } else {
            expect(existsSync(continuationUnit)).toBe(true);
            expect(existsSync(continuationWants)).toBe(true);
            if (crashPhase === 'continuation-enabled') {
              expect(existsSync(primaryUnit)).toBe(true);
              expect(existsSync(primaryWants)).toBe(true);
              expect(journalValue.continuationAuthority.state).toBe(
                'unit-created',
              );
            } else {
              expect(journalValue.continuationAuthority.state).toBe(
                'enabled',
              );
            }
          }
          if (
            crashPhase === 'remove-recoveryUnit' ||
            crashPhase === 'reload-systemd'
          ) {
            expect(existsSync(primaryUnit)).toBe(false);
            expect(existsSync(primaryWants)).toBe(false);
          }
        }

        const autoRecoverArgs = [
          'auto-recover',
          '--program', retained,
          '--lock', lock,
          '--asset-journal',
          join(control, 'asset-install-in-progress.v2'),
          '--asset-receipt',
          join(control, 'asset-install-recovery-receipt.v1.json'),
          '--directory-journal',
          join(control, 'directory-install-in-progress.v1.json'),
          '--directory-receipt',
          join(control, 'directory-install-recovery-receipt.v1.json'),
          '--anchor-intent', intent,
          '--anchor-receipt', receipt,
          '--unenroll-journal', journal,
          '--unenroll-result', result,
          '--install-commit', join(control, 'install-commit.v1.json'),
        ];
        const needsProtectedSourceRecovery =
          crashPhase === 'cleanup-disable-continuation-service' ||
          crashPhase === 'cleanup-remove-continuation-unit' ||
          crashPhase ===
            'cleanup-reload-systemd-after-continuation' ||
          crashPhase === 'cleanup-remove-retainedRecoveryProgram';
        const resumed = needsProtectedSourceRecovery
          ? run(sourceProgram, [
              'resume-anchor-cleanup',
              '--result', result,
              '--lock', lock,
            ])
          : run(retained, autoRecoverArgs, {
              NEXUS_SONAR_TEST_PRIMARY_ACTIVE: '1',
            });
        expect(resumed.status, `${crashPhase}: ${resumed.stderr}`).toBe(0);
        expect(existsSync(journal)).toBe(false);
        expect(existsSync(receipt)).toBe(false);
        expect(existsSync(retained)).toBe(false);
        expect(existsSync(primaryUnit)).toBe(false);
        expect(existsSync(primaryWants)).toBe(false);
        expect(existsSync(continuationUnit)).toBe(false);
        expect(existsSync(continuationWants)).toBe(false);
        expect(readFileSync(systemctlLog, 'utf8')).not.toContain('stop:');
        const completedResult = JSON.parse(readFileSync(result, 'utf8'));
        expect(completedResult).toMatchObject({
          status: 'complete',
          continuationAuthorityRemovedAfterCommit: true,
        });
        expect(completedResult.cleanupBindingSha256)
          .toMatch(/^[0-9a-f]{64}$/);
        if (postCommit) {
          rmSync(lock);
          const futureBootTmpfiles = spawnSync(
            tmpfiles,
            ['--create', targetLockConfig],
            {
              encoding: 'utf8',
              env: baseEnv,
            },
          );
          expect(
            futureBootTmpfiles.status,
            `${crashPhase}: ${futureBootTmpfiles.stderr}`,
          ).toBe(0);
          const futureInstallerCleanup = run(sourceProgram, [
            'resume-anchor-cleanup',
            '--result', result,
            '--lock', lock,
          ]);
          expect(
            futureInstallerCleanup.status,
            `${crashPhase}: ${futureInstallerCleanup.stderr}`,
          ).toBe(0);
          const futureResultRetirement = run(sourceProgram, [
            'retire-anchor-cleanup-result',
            '--result', result,
            '--archive', resultArchive,
            '--lock', lock,
          ]);
          expect(
            futureResultRetirement.status,
            `${crashPhase}: ${futureResultRetirement.stderr}`,
          ).toBe(0);
          expect(existsSync(result)).toBe(false);
          expect(existsSync(resultArchive)).toBe(true);
          const futureEnrollment = run(sourceProgram, enrollArgs);
          expect(
            futureEnrollment.status,
            `${crashPhase}: ${futureEnrollment.stderr}`,
          ).toBe(0);
          expect(existsSync(retained)).toBe(true);
          expect(existsSync(primaryUnit)).toBe(true);
          expect(existsSync(primaryWants)).toBe(true);
          expect(existsSync(continuationUnit)).toBe(false);
          expect(existsSync(continuationWants)).toBe(false);
          expect(statSync(targetLockConfig).ino).toBe(
            preservedLockConfig.ino,
          );
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
