import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const adapter = path.resolve(
  'scripts/rollback-drill-legacy-staging-adapter.mjs',
);
const broker = path.resolve(
  'scripts/remote-rollback-drill-legacy-staging-broker.sh',
);
const installer = path.resolve(
  'scripts/remote-rollback-drill-legacy-staging-install.sh',
);
const transactionUnit = path.resolve(
  'scripts/systemd/nexus-rollback-drill-legacy-staging@.service',
);
const recoveryUnit = path.resolve(
  'scripts/systemd/nexus-rollback-drill-legacy-staging-recovery.service',
);
const installRecoveryUnit = path.resolve(
  'scripts/systemd/nexus-rollback-drill-legacy-staging-install-recovery.service',
);
const v4InstallRecoveryUnit = path.resolve(
  'scripts/systemd/'
  + 'nexus-rollback-drill-v4-prelayout-staging-install-recovery.service',
);
const v4RecoveryUnit = path.resolve(
  'scripts/systemd/'
  + 'nexus-rollback-drill-v4-prelayout-staging-recovery.service',
);
const v4Pm2RecoveryDropIn = path.resolve(
  'scripts/systemd/'
  + '15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf',
);
const v4PromotionRecoveryDropIn = path.resolve(
  'scripts/systemd/'
  + '15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf',
);
const pm2RecoveryDropIn = path.resolve(
  'scripts/systemd/10-nexus-rollback-drill-legacy-staging-recovery.conf',
);
const releaseOperator = path.resolve('scripts/release-operator.sh');
const layoutActivationInstaller = path.resolve(
  'scripts/remote-release-layout-activation-install.sh',
);
const layoutActivationControl = path.resolve(
  'scripts/remote-release-layout-activation-control.sh',
);
const sqliteToolSource = path.resolve('scripts/application-dr-sqlite.py');
const filesystemHelper = path.resolve(
  'scripts/rollback-drill-legacy-staging-fs.py',
);
const runtimeSha = 'a'.repeat(40);
const controlSha = '8'.repeat(64);
const requestId = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function executable(root: string, name: string, body: string) {
  const file = path.join(root, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function makeTreeWritable(root: string) {
  const observed = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!observed || observed.isSymbolicLink()) return;
  if (observed.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root)) {
      makeTreeWritable(path.join(root, entry));
    }
  } else if (observed.isFile()) {
    fs.chmodSync(root, 0o600);
  }
}

function fixtureParent(
  platform: NodeJS.Platform = process.platform,
  linuxHome = os.homedir(),
) {
  if (platform !== 'linux') return os.tmpdir();
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (typeof uid !== 'number' || typeof gid !== 'number'
      || !Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error('Linux fixture ownership is unavailable');
  }
  const home = fs.realpathSync(linuxHome);
  const filesystemRoot = path.parse(home).root;
  if (!path.isAbsolute(home) || home === filesystemRoot) {
    throw new Error('Linux fixture home is unsafe');
  }
  let current = filesystemRoot;
  for (const component of path.relative(filesystemRoot, home).split(path.sep)) {
    current = path.join(current, component);
    const observed = fs.lstatSync(current);
    if (observed.isSymbolicLink()
        || !observed.isDirectory()
        || ![0, uid].includes(observed.uid)
        || (observed.mode & 0o022) !== 0) {
      throw new Error('Linux fixture home ancestry is unsafe');
    }
  }
  const observed = fs.lstatSync(home);
  if (observed.uid !== uid || observed.gid !== gid) {
    throw new Error('Linux fixture home is not runner-owned');
  }
  return home;
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(fixtureParent(), 'nexus-legacy-drill-adapter-')),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const base = path.join(root, 'legacy-staging');
  const data = path.join(base, 'data');
  const bundle = path.join(root, 'bundle');
  const transactionRoot = path.join(root, 'transactions');
  const sqliteHelper = path.join(root, 'application-dr-sqlite.py');
  const fuser = path.join(root, 'fuser');
  const python = execFileSync('/usr/bin/which', ['python3'], {
    encoding: 'utf8',
  }).trim();
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o755);
  fs.mkdirSync(path.join(base, 'releases'), { mode: 0o755 });
  fs.mkdirSync(bundle, { mode: 0o700 });
  fs.mkdirSync(transactionRoot, { mode: 0o700 });
  fs.copyFileSync(sqliteToolSource, sqliteHelper);
  fs.chmodSync(sqliteHelper, 0o644);
  fs.writeFileSync(
    fuser,
    '#!/bin/sh\n[ "$1" != "--" ] || exit 2\nprintf "%s\\n" "$PPID"\nexit 0\n',
    { mode: 0o755 },
  );
  const database = path.join(data, 'bot.db');
  execFileSync(python, ['-c', [
    'import sqlite3,sys',
    'connection=sqlite3.connect(sys.argv[1])',
    "connection.execute('CREATE TABLE release_state(value TEXT NOT NULL)')",
    "connection.execute(\"INSERT INTO release_state VALUES ('predecessor')\")",
    'connection.commit()',
    'connection.close()',
  ].join(';'), database]);
  const bundleFiles = new Map<string, Buffer>([
    ['.nexus-installed-runtime.json', Buffer.from('candidate installed\n')],
    ['.nexus-recovery-runtime.json', Buffer.from('candidate recovery\n')],
    ['ecosystem.release.config.js', Buffer.from('module.exports = {};\n')],
    ['scripts/remote-release-preflight.sh', Buffer.from('#!/bin/sh\nexit 0\n')],
    ['scripts/remote-release-readiness.sh', Buffer.from('#!/bin/sh\nexit 0\n')],
  ]);
  for (const [relative, body] of bundleFiles) {
    const output = path.join(bundle, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, body, {
      mode: relative.endsWith('.sh') ? 0o755 : 0o644,
    });
  }
  const files = [...bundleFiles].map(([relative, body]) => ({
    path: relative,
    size: body.length,
    sha256: sha256(body),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const artifactDigest = sha256(JSON.stringify({
    schema: 'nexus.release-artifact-manifest.v1',
    files,
  }));
  fs.writeFileSync(
    path.join(bundle, 'artifact-manifest.json'),
    `${JSON.stringify({
      schema: 'nexus.release-artifact-manifest.v1',
      git: { sha: runtimeSha },
      files,
      fileCount: files.length,
      digest: artifactDigest,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(bundle, '.complete.json'),
    `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha,
      artifactDigest,
      fileCount: files.length,
    }, null, 2)}\n`,
  );
  const key = generateKeyPairSync('ed25519');
  const publicKey = path.join(root, 'release-public.pem');
  fs.writeFileSync(
    publicKey,
    key.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const generatedAt = new Date(Date.now() - 60_000).toISOString();
  const payload = {
    schema: 'nexus.release-manifest-payload.v2',
    runtimeSha,
    packageVersion: '4.14.999',
    artifact: { digest: artifactDigest, fileCount: files.length, files },
    source: { dirty: false },
    ci: { runId: '40001' },
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 60 * 60_000).toISOString(),
  };
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, `${JSON.stringify({
    schema: 'nexus.release-manifest.v2',
    keyId: 'github-environment-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(payload)),
      key.privateKey,
    ).toString('base64'),
  }, null, 2)}\n`);
  const inspection = path.join(root, 'inspection.json');
  fs.writeFileSync(inspection, `${JSON.stringify({
    schema: 'nexus.rollback-drill-legacy-staging-broker-inspection.v1',
    promotionAllowed: false,
    base,
    workerUser: 'dominguez',
    broker: {
      version: 'nexus-rollback-drill-legacy-staging-broker.v1',
      sha256: '3'.repeat(64),
      adapterSha256: '4'.repeat(64),
    },
    control: {
      version: 'nexus-release-promotion-control.v2',
      sha256: controlSha,
    },
  }, null, 2)}\n`);
  return {
    root,
    base,
    bundle,
    database,
    transactionRoot,
    sqliteHelper,
    fuser,
    python,
    artifactDigest,
    manifest,
    publicKey,
    privateKey: key.privateKey,
    inspection,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEXUS_LEGACY_DRILL_BASE: base,
      NEXUS_LEGACY_DRILL_DATABASE_TRANSACTION_ROOT: transactionRoot,
      NEXUS_LEGACY_DRILL_SQLITE_HELPER: sqliteHelper,
      NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER: filesystemHelper,
      NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:
        sha256(fs.readFileSync(sqliteHelper)),
      NEXUS_LEGACY_DRILL_PYTHON_BIN: python,
      NEXUS_LEGACY_DRILL_FUSER_BIN: fuser,
      NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256: controlSha,
    },
  };
}

function installerBootstrap(
  state: ReturnType<typeof fixture>,
  label: string,
  profile: 'control-v2' | 'v4-prelayout' = 'control-v2',
) {
  const bootstrapBase = path.join(state.root, `bootstrap-${label}`);
  const pending = path.join(bootstrapBase, 'pending');
  const pendingSource = path.join(pending, 'source');
  fs.mkdirSync(pendingSource, { recursive: true, mode: 0o700 });
  const required = [
    'scripts/remote-rollback-drill-legacy-staging-install.sh',
    'scripts/remote-rollback-drill-legacy-staging-broker.sh',
    'scripts/rollback-drill-legacy-staging-adapter.mjs',
    'scripts/release-runtime-dependencies.mjs',
    'scripts/release-installed-tree-attestation.mjs',
    'scripts/release-recovery-runtime-identity.mjs',
    'scripts/application-dr-sqlite.py',
    'scripts/rollback-drill-legacy-staging-fs.py',
    'docs/release/evidence/release-evidence-public-key.pem',
  ];
  required.push(...(profile === 'v4-prelayout'
    ? [
        'scripts/systemd/nexus-rollback-drill-v4-prelayout-staging@.service',
        'scripts/systemd/nexus-rollback-drill-v4-prelayout-staging-recovery.service',
        'scripts/systemd/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service',
        'scripts/systemd/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf',
        'scripts/systemd/15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf',
      ]
    : [
        'scripts/systemd/nexus-rollback-drill-legacy-staging@.service',
        'scripts/systemd/nexus-rollback-drill-legacy-staging-recovery.service',
        'scripts/systemd/nexus-rollback-drill-legacy-staging-install-recovery.service',
        'scripts/systemd/10-nexus-rollback-drill-legacy-staging-recovery.conf',
      ]));
  for (const relative of required) {
    const source = path.resolve(relative);
    const destination = path.join(pendingSource, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o7777);
  }
  execFileSync('git', ['init', '-q'], { cwd: pendingSource });
  execFileSync('git', ['add', '.'], { cwd: pendingSource });
  execFileSync('git', [
    '-c', 'user.name=Nexus Test',
    '-c', 'user.email=nexus-test@example.invalid',
    'commit', '-qm', 'fixture',
  ], { cwd: pendingSource });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: pendingSource,
    encoding: 'utf8',
  }).trim();
  const bootstrapRoot = path.join(bootstrapBase, sourceSha);
  fs.renameSync(pending, bootstrapRoot);
  const sourceRoot = path.join(bootstrapRoot, 'source');
  const sourceArchive = path.join(bootstrapRoot, 'source.tar.gz');
  execFileSync('git', [
    'archive',
    '--format=tar.gz',
    '--prefix=source/',
    `--output=${sourceArchive}`,
    sourceSha,
  ], { cwd: sourceRoot });
  return {
    bootstrapBase,
    sourceRoot,
    sourceSha,
    sourceArchive,
    archiveSha256: sha256(fs.readFileSync(sourceArchive)),
  };
}

function remoteServices(releaseDir: string) {
  return [
    {
      name: 'nexus-hub-staging',
      status: 'online',
      cwd: releaseDir,
      executable: `${releaseDir}/dist/index.js`,
      interpreter: 'node',
      releaseSha: runtimeSha,
      sentryRelease: runtimeSha,
    },
    {
      name: 'content-engine-staging',
      status: 'online',
      cwd: `${releaseDir}/content-engine`,
      executable: `${releaseDir}/content-engine/.venv/bin/python3.12`,
      interpreter: 'none',
      releaseSha: runtimeSha,
      sentryRelease: runtimeSha,
    },
  ];
}

function brokerEnvironment(state: ReturnType<typeof fixture>) {
  const control = executable(state.root, 'control', `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v2 ;;
  assert-idle) exit 0 ;;
  *) exit 64 ;;
esac
`);
  const flock = executable(state.root, 'flock', '#!/bin/sh\nexit 0\n');
  const systemctl = executable(
    state.root,
    'systemctl',
    '#!/bin/sh\nexit 0\n',
  );
  const procRoot = path.join(state.root, 'proc');
  fs.mkdirSync(procRoot, { mode: 0o700 });
  return {
    ...state.env,
    NEXUS_LEGACY_DRILL_TEST_MODE: '1',
    NEXUS_LEGACY_DRILL_STATE_ROOT: state.root,
    NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
    NEXUS_LEGACY_DRILL_WORKER_HOME: path.join(state.root, 'worker-home'),
    NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
    NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
      sha256(fs.readFileSync(control)),
    NEXUS_LEGACY_DRILL_ADAPTER_BIN: adapter,
    NEXUS_LEGACY_DRILL_RELEASE_PUBLIC_KEY: state.publicKey,
    NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
    NEXUS_LEGACY_DRILL_PYTHON_BIN: state.python,
    NEXUS_LEGACY_DRILL_ENV_BIN: '/usr/bin/env',
    NEXUS_LEGACY_DRILL_FLOCK_BIN: flock,
    NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN: systemctl,
    NEXUS_LEGACY_DRILL_PROC_ROOT: procRoot,
    NEXUS_PROMOTION_STATE_ROOT: path.join(state.root, 'promotion-state'),
    NEXUS_LEGACY_DRILL_SONAR_LOCK: path.join(state.root, 'sonar.lock'),
  };
}

function installedV4PrelayoutFixture(
  label: string,
  powerLossAfter = '',
) {
  const state = fixture();
  const bootstrap = installerBootstrap(state, label, 'v4-prelayout');
  const targetRoot = path.join(state.root, `${label}-target`);
  const installState = path.join(state.root, `${label}-state`);
  const promotionState = path.join(state.root, `${label}-promotion`);
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  fs.mkdirSync(promotionState, { mode: 0o700 });
  fs.writeFileSync(path.join(promotionState, '.control.lock'), '', {
    mode: 0o600,
  });
  const activationRoot = path.join(promotionState, 'layout-activation');
  fs.mkdirSync(activationRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(activationRoot, '.activation.lock'), '', {
    mode: 0o600,
  });
  const sonarLock = path.join(state.root, `${label}-sonar.lock`);
  fs.writeFileSync(sonarLock, '', { mode: 0o600 });
  const control = executable(
    state.root,
    `${label}-control`,
    `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v4 ;;
  assert-idle) exit 0 ;;
  assert-boot-recovery-prepared)
    { [ "$2" = v4-prelayout ] || [ "$2" = layout ]; } || exit 64
    if [ -n "\${NEXUS_TEST_BOOT_PROFILE_LOG:-}" ]; then
      printf '%s\\n' "$2" >>"\$NEXUS_TEST_BOOT_PROFILE_LOG"
    fi
    ;;
  *) exit 64 ;;
esac
`,
  );
  fs.chmodSync(control, 0o755);
  const layoutControl = executable(
    state.root,
    `${label}-layout-control`,
    `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-layout-activation-control.v1 ;;
  assert-boot-safe)
    [ "\${NEXUS_TEST_LAYOUT_ASSERT_MUST_BE_SKIPPED:-0}" != 1 ] || exit 91
    ;;
  *) exit 64 ;;
esac
`,
  );
  fs.chmodSync(layoutControl, 0o755);
  const phaseAReceipt = path.join(state.root, `${label}-phase-a-receipt.v1.json`);
  const controlDigest = sha256(fs.readFileSync(control));
  fs.writeFileSync(phaseAReceipt, `${JSON.stringify({
    schema: 'nexus.release-layout-phase-a-receipt.v1',
    status: 'completed',
    sourceSha: bootstrap.sourceSha,
    sourceArchiveSha256: bootstrap.archiveSha256,
    phaseARecoveryGuard: true,
    legacyV2AdapterRetired: false,
    legacyRetirementSha256: null,
    installedAssets: [
      { path: control, sha256: controlDigest },
      { path: layoutControl, sha256: sha256(fs.readFileSync(layoutControl)) },
    ],
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(phaseAReceipt, 0o600);
  const sqliteTarget = path.join(
    targetRoot,
    'usr/local/libexec/nexus-application-dr/application-dr-sqlite.py',
  );
  fs.mkdirSync(path.dirname(sqliteTarget), {
    recursive: true,
    mode: 0o755,
  });
  fs.copyFileSync(sqliteToolSource, sqliteTarget);
  fs.chmodSync(sqliteTarget, 0o644);
  const sourceInstaller = path.join(
    bootstrap.sourceRoot,
    'scripts',
    'remote-rollback-drill-legacy-staging-install.sh',
  );
  const absentV2Active = path.join(state.root, `${label}-absent-v2-active.json`);
  const absentV2Retired = path.join(
    state.root,
    `${label}-absent-v2-retired.json`,
  );
  const env = {
    ...process.env,
    NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE: '1',
    NEXUS_LEGACY_DRILL_TEST_MODE: '1',
    NEXUS_LEGACY_DRILL_PROFILE: 'v4-prelayout',
    NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: targetRoot,
    NEXUS_LEGACY_DRILL_STATE_ROOT: installState,
    NEXUS_LEGACY_DRILL_BOOTSTRAP_BASE: bootstrap.bootstrapBase,
    NEXUS_PROMOTION_STATE_ROOT: promotionState,
    NEXUS_LEGACY_DRILL_SONAR_LOCK: sonarLock,
    NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
    NEXUS_LEGACY_DRILL_LAYOUT_CONTROL_BIN: layoutControl,
    NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256: controlDigest,
    NEXUS_LEGACY_DRILL_PHASE_A_RECEIPT: phaseAReceipt,
    NEXUS_LEGACY_DRILL_V2_ACTIVE_RECEIPT: absentV2Active,
    NEXUS_LEGACY_DRILL_V2_RETIRED_RECEIPT: absentV2Retired,
    NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:
      sha256(fs.readFileSync(sqliteTarget)),
    NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
    NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN: '/usr/bin/true',
    NEXUS_LEGACY_DRILL_FLOCK_BIN: '/usr/bin/true',
    NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
    NEXUS_LEGACY_DRILL_TEST_POWER_LOSS_AFTER: powerLossAfter,
  };
  const installed = spawnSync('bash', [
    sourceInstaller,
    'activate-from-phase-a',
    'none',
  ], { encoding: 'utf8', env });
  expect(
    installed.status,
    `${installed.stdout}\n${installed.stderr}`,
  ).toBe(powerLossAfter ? 197 : 0);
  const fixed = (relative: string) => path.join(targetRoot, relative);
  const fixedInstaller = fixed(
    'usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-install',
  );
  const fixedBroker = fixed(
    'usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-broker',
  );
  const brokerEnv = {
    ...env,
    NEXUS_LEGACY_DRILL_BASE: fixed(
      'home/dominguez/telegram-hub-bot-staging',
    ),
    NEXUS_LEGACY_DRILL_INSTALLER_BIN: fixedInstaller,
    NEXUS_LEGACY_DRILL_INSTALL_RECOVERY_UNIT: fixed(
      'etc/systemd/system/'
      + 'nexus-rollback-drill-v4-prelayout-staging-install-recovery.service',
    ),
    NEXUS_LEGACY_DRILL_ADAPTER_BIN: fixed(
      'usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-adapter.mjs',
    ),
    NEXUS_LEGACY_DRILL_DEPENDENCY_BIN: fixed(
      'usr/local/libexec/nexus-rollback-drill-v4-prelayout-runtime-dependencies.mjs',
    ),
    NEXUS_LEGACY_DRILL_INSTALLED_ATTESTOR: fixed(
      'usr/local/libexec/nexus-rollback-drill-v4-prelayout-installed-tree-attestation.mjs',
    ),
    NEXUS_LEGACY_DRILL_RECOVERY_ATTESTOR: fixed(
      'usr/local/libexec/nexus-rollback-drill-v4-prelayout-recovery-runtime-identity.mjs',
    ),
    NEXUS_LEGACY_DRILL_RELEASE_PUBLIC_KEY: fixed(
      'etc/nexus-release/'
      + 'rollback-drill-v4-prelayout-release-evidence-public-key.pem',
    ),
    NEXUS_LEGACY_DRILL_TRANSACTION_UNIT: fixed(
      'etc/systemd/system/nexus-rollback-drill-v4-prelayout-staging@.service',
    ),
    NEXUS_LEGACY_DRILL_RECOVERY_UNIT: fixed(
      'etc/systemd/system/'
      + 'nexus-rollback-drill-v4-prelayout-staging-recovery.service',
    ),
    NEXUS_LEGACY_DRILL_PM2_DOMINGUEZ_DROP_IN: fixed(
      'etc/systemd/system/pm2-dominguez.service.d/'
      + '15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf',
    ),
    NEXUS_LEGACY_DRILL_PM2_ROOT_DROP_IN: fixed(
      'etc/systemd/system/pm2-root.service.d/'
      + '15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf',
    ),
    NEXUS_LEGACY_DRILL_PROMOTION_RECOVERY_DROP_IN: fixed(
      'etc/systemd/system/nexus-release-promotion-recovery.service.d/'
      + '15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf',
    ),
    NEXUS_LEGACY_DRILL_SUDOERS_FILE: fixed(
      'etc/sudoers.d/nexus-rollback-drill-v4-prelayout-staging',
    ),
    NEXUS_LEGACY_DRILL_SQLITE_HELPER: sqliteTarget,
    NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER: fixed(
      'usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-fs.py',
    ),
    NEXUS_LEGACY_DRILL_INSTALL_RECEIPT: path.join(
      installState,
      'install-receipt.v1.json',
    ),
    NEXUS_LEGACY_DRILL_PERMANENT_PM2_DROP_IN: fixed(
      'etc/systemd/system/pm2-dominguez.service.d/nexus-release-recovery.conf',
    ),
  };
  return {
    state,
    bootstrap,
    targetRoot,
    installState,
    promotionState,
    control,
    layoutControl,
    controlDigest,
    phaseAReceipt,
    env,
    brokerEnv,
    fixedInstaller,
    fixedBroker,
    installed,
  };
}

function writeValidV4DrillEvidence(
  installed: ReturnType<typeof installedV4PrelayoutFixture>,
) {
  const { state, installState, fixedBroker, controlDigest, phaseAReceipt } =
    installed;
  const base = installed.brokerEnv.NEXUS_LEGACY_DRILL_BASE!;
  const releaseDir =
    `${base}/releases/${runtimeSha}-${state.artifactDigest.slice(0, 12)}`;
  const predecessor =
    `${base}/releases/${'1'.repeat(40)}-${'2'.repeat(12)}`;
  const selector = (target: string, ino: string) => ({
    path: `${base}/current`,
    target,
    dev: '10',
    ino,
    uid: 1000,
    gid: 1000,
    mode: 0o777,
  });
  const installedIdentity = {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha,
    artifactDigest: state.artifactDigest,
  };
  const recoveryIdentity = {
    schema: 'nexus.recovery-installed-runtime-identity.v1',
    runtimeSha,
    artifactDigest: state.artifactDigest,
  };
  const manifestBody = fs.readFileSync(state.manifest);
  const manifestValue = JSON.parse(manifestBody.toString('utf8'));
  const now = Date.now();
  const endpoint = (uptime: number) => ({
    backendSnapshotSha256: 'c'.repeat(64),
    backendVersion: '4.14.999',
    backendUptime: uptime,
    contentReadySha256: 'd'.repeat(64),
    contentStatus: 'ready',
    internalAuthConfigured: true,
  });
  const evidence = {
    schema: 'nexus.rollback-drill-legacy-staging-evidence.v1',
    status: 'completed',
    promotionAllowed: false,
    requestId,
    runtimeSha,
    artifactDigest: state.artifactDigest,
    base,
    releaseDir,
    broker: {
      version: 'nexus-rollback-drill-v4-prelayout-staging-broker.v1',
      sha256: sha256(fs.readFileSync(fixedBroker)),
      adapterSha256: sha256(fs.readFileSync(path.join(
        installed.targetRoot,
        'usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-adapter.mjs',
      ))),
    },
    control: {
      version: 'nexus-release-promotion-control.v4',
      sha256: controlDigest,
    },
    phaseA: {
      sourceSha: installed.bootstrap.sourceSha,
      archiveSha256: installed.bootstrap.archiveSha256,
      receiptSha256: sha256(fs.readFileSync(phaseAReceipt)),
    },
    sourceProvenance: {
      rootRequestSha256: 'b'.repeat(64),
      releaseManifestSha256: sha256(manifestBody),
      releaseManifestPayloadSha256:
        sha256(canonicalJson(manifestValue.payload)),
      releaseManifestSignatureSha256:
        sha256(Buffer.from(manifestValue.signature, 'base64')),
      releaseManifestSigningRunId: String(manifestValue.payload.ci.runId),
      releaseManifestSigningRunSha256:
        sha256(canonicalJson(manifestValue.payload.ci)),
    },
    predecessor: {
      runtime: predecessor,
      runtimeSha: '1'.repeat(40),
      artifactDigest: '2'.repeat(64),
      markerSha256: '5'.repeat(64),
      installedAttestationSha256: '8'.repeat(64),
      recoveryAttestationSha256: '9'.repeat(64),
      metadataSha256: 'e'.repeat(64),
      runtimeIdentity: {
        dev: '10',
        ino: '30',
        uid: 0,
        gid: 0,
        mode: 0o555,
      },
      selector: selector(predecessor, '20'),
    },
    currentSelector: selector(releaseDir, '21'),
    installedRuntimeAttestation: {
      schema: 'nexus.installed-runtime-attestation.v1',
      identity: installedIdentity,
      aggregateDigest: sha256(canonicalJson(installedIdentity)),
    },
    recoveryRuntimeAttestation: {
      schema: 'nexus.recovery-runtime-attestation.v1',
      identity: recoveryIdentity,
      aggregateDigest: sha256(canonicalJson(recoveryIdentity)),
    },
    remoteIdentity: {
      schema: 'nexus.pm2-release-identity.v1',
      services: remoteServices(releaseDir),
    },
    remoteReadiness: {
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha,
      checkedAt: new Date(now - 5_000).toISOString(),
      stabilitySeconds: 60,
      stabilityStartedAt: new Date(now - 70_000).toISOString(),
      stabilityCompletedAt: new Date(now - 8_000).toISOString(),
      stabilityObservedSeconds: 60,
      readinessAttempts: 1,
      soak: {
        schema: 'nexus.release-readiness-soak.v1',
        clock: 'monotonic',
        requiredSeconds: 60,
        startedMonotonicNs: '1000000000',
        completedMonotonicNs: '61000000000',
        observedNanoseconds: '60000000000',
        initial: endpoint(100),
        final: endpoint(160),
      },
      services: remoteServices(releaseDir),
      checks: {
        nativeBinding: true,
        sqliteIntegrity: true,
        sqliteForeignKeys: true,
        backendHealth: true,
        authenticatedBackendSnapshot: true,
        authenticatedContentEngine: true,
        pm2ExactIdentity: true,
        pm2RestartStable: true,
      },
    },
    transaction: {
      databaseBackupSha256: '7'.repeat(64),
      databaseBackupSizeBytes: 4096,
      journalSha256: '6'.repeat(64),
      preparedAt: new Date(now - 20_000).toISOString(),
      selectorSwitchedAt: new Date(now - 15_000).toISOString(),
      readinessCompletedAt: new Date(now - 12_000).toISOString(),
      publishedAt: new Date(now - 10_000).toISOString(),
      stabilitySeconds: 60,
      recoveryTargetSeconds: 120,
    },
  };
  const transaction = path.join(installState, 'transactions', requestId);
  fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
  const evidenceFile = path.join(transaction, 'evidence.json');
  const evidenceBody = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(evidenceFile, evidenceBody, { mode: 0o600 });
  const journalFile = path.join(transaction, 'journal.json');
  fs.writeFileSync(journalFile, `${JSON.stringify({
    schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
    requestId,
    phase: 'completed',
    evidenceSha256: sha256(evidenceBody),
  }, null, 2)}\n`, { mode: 0o600 });
  return { evidenceFile, journalFile };
}

function installV4PhaseBGuard(
  installed: ReturnType<typeof installedV4PrelayoutFixture>,
) {
  const pm2DropIn = installed.brokerEnv
    .NEXUS_LEGACY_DRILL_PERMANENT_PM2_DROP_IN!;
  const ingressDropIn = path.join(
    installed.targetRoot,
    'etc/systemd/system/cloudflared.service.d/nexus-release-ordering.conf',
  );
  fs.mkdirSync(path.dirname(pm2DropIn), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(ingressDropIn), { recursive: true, mode: 0o755 });
  fs.writeFileSync(pm2DropIn, `[Unit]
Requires=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service
After=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service
[Service]
ExecCondition=+/usr/local/sbin/nexus-release-layout-activation-control assert-boot-safe
ExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck
`, { mode: 0o644 });
  fs.writeFileSync(ingressDropIn, '[Unit]\n', { mode: 0o644 });
  const receipt = path.join(
    installed.promotionState,
    'layout-activation/phase-b-receipt.v1.json',
  );
  fs.writeFileSync(receipt, `${JSON.stringify({
    schema: 'nexus.release-layout-phase-b-receipt.v1',
    status: 'completed',
    sourceSha: installed.bootstrap.sourceSha,
    sourceArchiveSha256: installed.bootstrap.archiveSha256,
    layoutAttestationSha256: 'a'.repeat(64),
    phaseAReceiptSha256: sha256(fs.readFileSync(installed.phaseAReceipt)),
    completedAt: new Date().toISOString(),
    runningServiceIdentity: { runtimeUnchanged: true },
    handoverTargets: [
      { path: pm2DropIn, sha256: sha256(fs.readFileSync(pm2DropIn)) },
      { path: ingressDropIn, sha256: sha256(fs.readFileSync(ingressDropIn)) },
    ],
    serviceRestarted: false,
    ingressRestarted: false,
    rebootRequired: true,
  }, null, 2)}\n`, { mode: 0o600 });
}

function waitForPath(file: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(file)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    makeTreeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy staging drill adapter', () => {
  it('binds a production-signed manifest to the exact broker and bundle', () => {
    const state = fixture();
    const request = path.join(state.root, 'transaction-request.json');
    const built = JSON.parse(execFileSync(process.execPath, [
      adapter,
      'build-transaction-request',
      '--manifest', state.manifest,
      '--inspection', state.inspection,
      '--request-id', requestId,
      '--public-key', state.publicKey,
      '--output', request,
    ], { encoding: 'utf8', env: state.env }));
    expect(built).toMatchObject({
      ok: true,
      promotable: false,
      requestId,
      runtimeSha,
      artifactDigest: state.artifactDigest,
    });
    const validated = JSON.parse(execFileSync(process.execPath, [
      adapter,
      'validate-transaction-request',
      '--request', request,
      '--public-key', state.publicKey,
      '--expect-request-id', requestId,
      '--expect-broker-sha256', '3'.repeat(64),
      '--expect-adapter-sha256', '4'.repeat(64),
    ], { encoding: 'utf8', env: state.env }));
    expect(validated.promotable).toBe(false);
    expect(JSON.parse(fs.readFileSync(request, 'utf8'))).toMatchObject({
      purpose: 'isolated-kvm-first-drill',
      promotionAllowed: false,
      base: state.base,
    });
    expect(JSON.parse(execFileSync(process.execPath, [
      adapter,
      'verify-bundle',
      '--bundle', state.bundle,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', state.artifactDigest,
    ], { encoding: 'utf8', env: state.env }))).toMatchObject({
      ok: true,
      fileCount: 5,
    });

    const mutated = JSON.parse(fs.readFileSync(request, 'utf8'));
    mutated.promotionAllowed = true;
    const tampered = path.join(state.root, 'tampered-request.json');
    fs.writeFileSync(tampered, `${JSON.stringify(mutated, null, 2)}\n`);
    const rejected = spawnSync(process.execPath, [
      adapter,
      'validate-transaction-request',
      '--request', tampered,
      '--public-key', state.publicKey,
    ], { encoding: 'utf8', env: state.env });
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`)
      .toContain('transaction request identity is invalid');
  });

  it('persists the exact operator request checkpoint across a disconnect', () => {
    const state = fixture();
    const evidenceDirectory = path.join(state.root, 'operator-evidence');
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    fs.chmodSync(evidenceDirectory, 0o700);
    const evidenceBase = path.join(
      evidenceDirectory,
      `${runtimeSha}-${state.artifactDigest}-${requestId}`,
    );
    const checkpoint = `${evidenceBase}.checkpoint.json`;
    const releaseDir = path.join(
      state.base,
      'releases',
      `${runtimeSha}-${state.artifactDigest.slice(0, 12)}`,
    );
    const args = [
      adapter,
      'ensure-operator-checkpoint',
      '--output', checkpoint,
      '--manifest', state.manifest,
      '--request-id', requestId,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', state.artifactDigest,
      '--release-dir', releaseDir,
      '--server', 'dominguez@serverdominguez',
      '--base', state.base,
      '--broker',
      '/usr/local/sbin/nexus-rollback-drill-legacy-staging-broker',
      '--evidence-base', evidenceBase,
    ];
    const created = JSON.parse(execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: state.env,
    }));
    expect(created).toMatchObject({
      ok: true,
      promotable: false,
      requestId,
      runtimeSha,
      artifactDigest: state.artifactDigest,
      checkpoint,
      resumed: false,
    });
    expect(fs.statSync(checkpoint).mode & 0o7777).toBe(0o600);
    const checkpointBody = fs.readFileSync(checkpoint);

    // This request exists before broker submission. A lost Mac/SSH session must
    // reuse both it and the immutable checkpoint instead of choosing a new id.
    execFileSync(process.execPath, [
      adapter,
      'build-transaction-request',
      '--manifest', state.manifest,
      '--inspection', state.inspection,
      '--request-id', requestId,
      '--public-key', state.publicKey,
      '--output', `${evidenceBase}.transaction-request.json`,
    ], { env: state.env });
    const resumed = JSON.parse(execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: state.env,
    }));
    expect(resumed).toMatchObject({
      checkpointSha256: sha256(checkpointBody),
      resumed: true,
    });
    expect(fs.readFileSync(checkpoint)).toEqual(checkpointBody);

    fs.appendFileSync(state.manifest, '\n');
    const drifted = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: state.env,
    });
    expect(drifted.status).not.toBe(0);
    expect(`${drifted.stdout}${drifted.stderr}`)
      .toContain('releaseManifestSha256 differs');
    expect(fs.readFileSync(checkpoint)).toEqual(checkpointBody);
  });

  it('snapshots a stopped SQLite database before switch and restores it fail-closed', () => {
    const state = fixture();
    const transactionDirectory = path.join(state.transactionRoot, requestId);
    fs.mkdirSync(transactionDirectory, { mode: 0o700 });
    const snapshot = JSON.parse(execFileSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], { encoding: 'utf8', env: state.env }));
    expect(Object.keys(snapshot)).toEqual(['databaseBackup']);
    expect(snapshot.databaseBackup).toMatchObject({
      schema: 'nexus.rollback-drill-legacy-staging-database-backup.v1',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sizeBytes: expect.any(Number),
      uid: fs.statSync(state.database).uid,
      gid: fs.statSync(state.database).gid,
      mode: fs.statSync(state.database).mode & 0o7777,
    });
    expect(JSON.stringify(snapshot)).not.toContain(state.root);
    const backup = path.join(transactionDirectory, 'rollback-database.db');
    expect(fs.statSync(backup).mode & 0o7777).toBe(0o600);
    expect(sha256(fs.readFileSync(backup)))
      .toBe(snapshot.databaseBackup.sha256);

    execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "connection.execute(\"UPDATE release_state SET value='candidate'\")",
      'connection.commit()',
      'connection.close()',
    ].join(';'), state.database]);
    fs.writeFileSync(`${state.database}-wal`, 'candidate wal', { mode: 0o600 });
    fs.writeFileSync(`${state.database}-shm`, 'candidate shm', { mode: 0o600 });
    const journal = path.join(transactionDirectory, 'journal.json');
    fs.writeFileSync(journal, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      phase: 'selector_switched',
      requestId,
      databaseBackup: snapshot.databaseBackup,
    }, null, 2)}\n`, { mode: 0o600 });
    const restored = JSON.parse(execFileSync(process.execPath, [
      adapter,
      'restore-database',
      '--request-id', requestId,
      '--journal', journal,
    ], { encoding: 'utf8', env: state.env }));
    expect(restored).toEqual({
      ok: true,
      databaseBackupSha256: snapshot.databaseBackup.sha256,
      databaseBackupSizeBytes: snapshot.databaseBackup.sizeBytes,
    });
    expect(fs.existsSync(`${state.database}-wal`)).toBe(false);
    expect(fs.existsSync(`${state.database}-shm`)).toBe(false);
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('predecessor');

    const originalMode = snapshot.databaseBackup.mode;
    fs.rmSync(state.database);
    execFileSync(process.execPath, [
      adapter,
      'restore-database',
      '--request-id', requestId,
      '--journal', journal,
    ], { encoding: 'utf8', env: state.env });
    expect(fs.statSync(state.database).mode & 0o7777).toBe(originalMode);
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('predecessor');

    fs.truncateSync(state.database, 0);
    execFileSync(process.execPath, [
      adapter,
      'restore-database',
      '--request-id', requestId,
      '--journal', journal,
    ], { encoding: 'utf8', env: state.env });
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('predecessor');

    execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "connection.execute(\"UPDATE release_state SET value='must-survive-failure'\")",
      'connection.commit()',
      'connection.close()',
    ].join(';'), state.database]);
    fs.writeFileSync(backup, 'corrupt recovery point', { mode: 0o600 });
    const corrupt = spawnSync(process.execPath, [
      adapter,
      'restore-database',
      '--request-id', requestId,
      '--journal', journal,
    ], { encoding: 'utf8', env: state.env });
    expect(corrupt.status).not.toBe(0);
    expect(`${corrupt.stdout}${corrupt.stderr}`).not.toContain(state.root);
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('must-survive-failure');

    fs.rmSync(backup);
    const missing = spawnSync(process.execPath, [
      adapter,
      'restore-database',
      '--request-id', requestId,
      '--journal', journal,
    ], { encoding: 'utf8', env: state.env });
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).not.toContain(state.root);
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('must-survive-failure');
  });

  it('includes committed stopped-state WAL frames in the recovery point', () => {
    const state = fixture();
    const transactionDirectory = path.join(state.transactionRoot, requestId);
    fs.mkdirSync(transactionDirectory, { mode: 0o700 });
    const preservedMain = path.join(state.root, 'preserved-wal-main.db');
    const preservedWal = path.join(state.root, 'preserved-wal.db-wal');
    const preservedShm = path.join(state.root, 'preserved-wal.db-shm');
    execFileSync(state.python, ['-c', [
      'import shutil,sqlite3,sys',
      'database,main_copy,wal_copy,shm_copy=sys.argv[1:]',
      'connection=sqlite3.connect(database)',
      "connection.execute('PRAGMA journal_mode=WAL')",
      "connection.execute('PRAGMA wal_autocheckpoint=0')",
      "connection.execute(\"UPDATE release_state SET value='wal-only-commit'\")",
      'connection.commit()',
      'shutil.copy2(database,main_copy)',
      "shutil.copy2(database+'-wal',wal_copy)",
      "shutil.copy2(database+'-shm',shm_copy)",
      'connection.close()',
      'shutil.copy2(main_copy,database)',
      "shutil.copy2(wal_copy,database+'-wal')",
      "shutil.copy2(shm_copy,database+'-shm')",
    ].join(';'), state.database, preservedMain, preservedWal, preservedShm]);
    expect(fs.statSync(`${state.database}-wal`).size).toBeGreaterThan(0);

    execFileSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], { encoding: 'utf8', env: state.env });
    const backup = path.join(transactionDirectory, 'rollback-database.db');
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), backup], { encoding: 'utf8' }).trim())
      .toBe('wal-only-commit');
  });

  it('rejects a tampered trusted SQLite helper before creating a recovery point', () => {
    const state = fixture();
    fs.mkdirSync(path.join(state.transactionRoot, requestId), { mode: 0o700 });
    fs.appendFileSync(state.sqliteHelper, '\n# unreviewed drift\n');
    const result = spawnSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], { encoding: 'utf8', env: state.env });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`)
      .toContain('SQLite recovery helper identity mismatch');
    expect(`${result.stdout}${result.stderr}`).not.toContain(state.root);
    expect(fs.existsSync(path.join(
      state.transactionRoot,
      requestId,
      'rollback-database.db',
    ))).toBe(false);
  });

  it('fails closed when the database handle probe itself errors', () => {
    const state = fixture();
    fs.mkdirSync(path.join(state.transactionRoot, requestId), { mode: 0o700 });
    const failingFuser = executable(
      state.root,
      'fuser-error',
      '#!/bin/sh\nexit 2\n',
    );
    const result = spawnSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], {
      encoding: 'utf8',
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_FUSER_BIN: failingFuser,
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`)
      .toContain('database handle check did not complete safely');
    expect(fs.existsSync(path.join(
      state.transactionRoot,
      requestId,
      'rollback-database.db',
    ))).toBe(false);
  });

  it('ignores only its own descriptor holder and rejects another reported PID', () => {
    const state = fixture();
    fs.mkdirSync(path.join(state.transactionRoot, requestId), { mode: 0o700 });
    const externalHolderFuser = executable(
      state.root,
      'fuser-external-holder',
      '#!/bin/sh\nprintf "%s 424242\\n" "$PPID"\nexit 0\n',
    );
    const result = spawnSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], {
      encoding: 'utf8',
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_FUSER_BIN: externalHolderFuser,
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`)
      .toContain('database still has an open process handle');
    expect(fs.existsSync(path.join(
      state.transactionRoot,
      requestId,
      'rollback-database.db',
    ))).toBe(false);
  });

  it('rejects malformed PID output from the database handle probe', () => {
    const state = fixture();
    fs.mkdirSync(path.join(state.transactionRoot, requestId), { mode: 0o700 });
    const malformedFuser = executable(
      state.root,
      'fuser-malformed-output',
      '#!/bin/sh\nprintf "%s unexpected\\n" "$PPID"\nexit 0\n',
    );
    const result = spawnSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], {
      encoding: 'utf8',
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_FUSER_BIN: malformedFuser,
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`)
      .toContain('database handle check returned malformed PID output');
  });

  it('accepts GNU fuser reporting only the helper PID on Linux', () => {
    if (process.platform !== 'linux' || !fs.existsSync('/usr/bin/fuser')) return;
    const state = fixture();
    fs.mkdirSync(path.join(state.transactionRoot, requestId), { mode: 0o700 });
    const result = spawnSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], {
      encoding: 'utf8',
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_FUSER_BIN: '/usr/bin/fuser',
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('rejects a database-parent rename while retained source FDs are active', async () => {
    const state = fixture();
    fs.mkdirSync(path.join(state.transactionRoot, requestId), { mode: 0o700 });
    const marker = path.join(state.root, 'database-fd-opened');
    const resume = path.join(state.root, 'database-fd-resume');
    const child = spawn(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], {
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_TEST_DATABASE_FD_OPEN_MARKER: marker,
        NEXUS_LEGACY_DRILL_TEST_DATABASE_FD_RESUME_MARKER: resume,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    waitForPath(marker);
    const originalParent = path.dirname(state.database);
    const retainedParent = `${originalParent}.retained`;
    fs.renameSync(originalParent, retainedParent);
    fs.mkdirSync(originalParent, { mode: 0o700 });
    const decoy = Buffer.from('decoy database parent must remain untouched\n');
    fs.writeFileSync(state.database, decoy, { mode: 0o600 });
    fs.writeFileSync(resume, 'resume\n', { mode: 0o600 });
    const status = child.exitCode ?? await new Promise<number | null>(
      (resolve) => child.on('exit', resolve),
    );
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`)
      .toContain('database parent changed during its descriptor-bound snapshot');
    expect(fs.readFileSync(state.database)).toEqual(decoy);
  });

  it('turns only completed root evidence into a drill-only staging request', () => {
    const state = fixture();
    const releaseDir =
      `${state.base}/releases/${runtimeSha}-${state.artifactDigest.slice(0, 12)}`;
    const predecessor =
      `${state.base}/releases/${'1'.repeat(40)}-${'2'.repeat(12)}`;
    const selector = (target: string, ino: string) => ({
      path: `${state.base}/current`,
      target,
      dev: '10',
      ino,
      uid: 1000,
      gid: 1000,
      mode: 0o777,
    });
    const installedIdentity = {
      schema: 'nexus.installed-runtime-identity.v1',
      runtimeSha,
      artifactDigest: state.artifactDigest,
    };
    const recoveryIdentity = {
      schema: 'nexus.recovery-installed-runtime-identity.v1',
      runtimeSha,
      artifactDigest: state.artifactDigest,
    };
    const now = Date.now();
    const manifestBody = fs.readFileSync(state.manifest);
    const manifestValue = JSON.parse(manifestBody.toString('utf8'));
    const sourceProvenance = {
      rootRequestSha256: 'b'.repeat(64),
      releaseManifestSha256: sha256(manifestBody),
      releaseManifestPayloadSha256:
        sha256(canonicalJson(manifestValue.payload)),
      releaseManifestSignatureSha256:
        sha256(Buffer.from(manifestValue.signature, 'base64')),
      releaseManifestSigningRunId: String(manifestValue.payload.ci.runId),
      releaseManifestSigningRunSha256:
        sha256(canonicalJson(manifestValue.payload.ci)),
    };
    const endpoint = (uptime: number) => ({
      backendSnapshotSha256: 'c'.repeat(64),
      backendVersion: '4.14.999',
      backendUptime: uptime,
      contentReadySha256: 'd'.repeat(64),
      contentStatus: 'ready',
      internalAuthConfigured: true,
    });
    const evidence = {
      schema: 'nexus.rollback-drill-legacy-staging-evidence.v1',
      status: 'completed',
      promotionAllowed: false,
      requestId,
      runtimeSha,
      artifactDigest: state.artifactDigest,
      base: state.base,
      releaseDir,
      broker: {
        version: 'nexus-rollback-drill-legacy-staging-broker.v1',
        sha256: '3'.repeat(64),
        adapterSha256: '4'.repeat(64),
      },
      control: {
        version: 'nexus-release-promotion-control.v2',
        sha256: controlSha,
      },
      sourceProvenance,
      predecessor: {
        runtime: predecessor,
        runtimeSha: '1'.repeat(40),
        artifactDigest: '2'.repeat(64),
        markerSha256: '5'.repeat(64),
        installedAttestationSha256: '8'.repeat(64),
        recoveryAttestationSha256: '9'.repeat(64),
        metadataSha256: 'e'.repeat(64),
        runtimeIdentity: {
          dev: '10',
          ino: '30',
          uid: 0,
          gid: 0,
          mode: 0o555,
        },
        selector: selector(predecessor, '20'),
      },
      currentSelector: selector(releaseDir, '21'),
      installedRuntimeAttestation: {
        schema: 'nexus.installed-runtime-attestation.v1',
        identity: installedIdentity,
        aggregateDigest: sha256(canonicalJson(installedIdentity)),
      },
      recoveryRuntimeAttestation: {
        schema: 'nexus.recovery-runtime-attestation.v1',
        identity: recoveryIdentity,
        aggregateDigest: sha256(canonicalJson(recoveryIdentity)),
      },
      remoteIdentity: {
        schema: 'nexus.pm2-release-identity.v1',
        services: remoteServices(releaseDir),
      },
      remoteReadiness: {
        schema: 'nexus.release-readiness.v1',
        role: 'staging',
        runtimeSha,
        checkedAt: new Date(now - 5_000).toISOString(),
        stabilitySeconds: 60,
        stabilityStartedAt: new Date(now - 70_000).toISOString(),
        stabilityCompletedAt: new Date(now - 8_000).toISOString(),
        stabilityObservedSeconds: 60,
        readinessAttempts: 1,
        soak: {
          schema: 'nexus.release-readiness-soak.v1',
          clock: 'monotonic',
          requiredSeconds: 60,
          startedMonotonicNs: '1000000000',
          completedMonotonicNs: '61000000000',
          observedNanoseconds: '60000000000',
          initial: endpoint(100),
          final: endpoint(160),
        },
        services: remoteServices(releaseDir),
        checks: {
          nativeBinding: true,
          sqliteIntegrity: true,
          sqliteForeignKeys: true,
          backendHealth: true,
          authenticatedBackendSnapshot: true,
          authenticatedContentEngine: true,
          pm2ExactIdentity: true,
          pm2RestartStable: true,
        },
      },
      transaction: {
        databaseBackupSha256: '7'.repeat(64),
        databaseBackupSizeBytes: 4096,
        journalSha256: '6'.repeat(64),
        preparedAt: new Date(now - 20_000).toISOString(),
        selectorSwitchedAt: new Date(now - 15_000).toISOString(),
        readinessCompletedAt: new Date(now - 12_000).toISOString(),
        publishedAt: new Date(now - 10_000).toISOString(),
        stabilitySeconds: 60,
        recoveryTargetSeconds: 120,
      },
    };
    const evidencePath = path.join(state.root, 'root-evidence.json');
    const staging = path.join(state.root, 'staging-request.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const built = JSON.parse(execFileSync(process.execPath, [
      adapter,
      'build-staging-request',
      '--manifest', state.manifest,
      '--evidence', evidencePath,
      '--public-key', state.publicKey,
      '--output', staging,
    ], { encoding: 'utf8', env: state.env }));
    expect(built).toMatchObject({
      ok: true,
      promotable: false,
      rollbackDrillEligible: false,
      reason: 'protected_drill_signature_required',
    });
    const request = JSON.parse(fs.readFileSync(staging, 'utf8'));
    expect(request).toMatchObject({
      releaseDir,
      smoke: {
        status: 'passed',
        command: 'scripts/remote-release-readiness.sh',
      },
      drillBootstrap: {
        profile: 'isolated-kvm-first-drill',
        promotionAllowed: false,
        brokerReceiptSha256: sha256(fs.readFileSync(evidencePath)),
      },
    });
    expect(JSON.parse(execFileSync(process.execPath, [
      adapter,
      'validate-staging-request',
      '--request', staging,
      '--expect-runtime-sha', runtimeSha,
    ], { encoding: 'utf8', env: state.env }))).toMatchObject({
      ok: true,
      promotable: false,
    });

    const resignedPayload = {
      ...manifestValue.payload,
      packageVersion: '4.14.998',
    };
    const resignedManifest = path.join(state.root, 'resigned-manifest.json');
    fs.writeFileSync(resignedManifest, `${JSON.stringify({
      schema: 'nexus.release-manifest.v2',
      keyId: 'github-environment-release-signing-2026-07',
      signatureAlgorithm: 'ed25519',
      payload: resignedPayload,
      signature: cryptoSign(
        null,
        Buffer.from(canonicalJson(resignedPayload)),
        state.privateKey,
      ).toString('base64'),
    }, null, 2)}\n`);
    const substituted = spawnSync(process.execPath, [
      adapter,
      'build-staging-request',
      '--manifest', resignedManifest,
      '--evidence', evidencePath,
      '--public-key', state.publicKey,
      '--output', path.join(state.root, 'substituted-staging-request.json'),
    ], { encoding: 'utf8', env: state.env });
    expect(substituted.status).not.toBe(0);
    expect(`${substituted.stdout}${substituted.stderr}`)
      .toContain('broker evidence differs from the release manifest');
  });
});

describe('root broker and installer contracts', () => {
  it('requires safe runner-owned ancestry for Linux fixture roots', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(fixtureParent(), 'nexus-linux-fixture-parent-')),
    );
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const home = path.join(root, 'runner-home');
    fs.mkdirSync(home, { mode: 0o700 });
    expect(fixtureParent('linux', home)).toBe(home);
    fs.chmodSync(home, 0o777);
    expect(() => fixtureParent('linux', home))
      .toThrow('Linux fixture home ancestry is unsafe');
  });

  it('does not publish a selector when the bound release pathname is swapped', async () => {
    const state = fixture();
    const releases = path.join(state.base, 'releases');
    const predecessor = path.join(releases, 'predecessor');
    const candidate = path.join(releases, 'candidate');
    fs.mkdirSync(predecessor, { mode: 0o700 });
    fs.mkdirSync(candidate, { mode: 0o700 });
    const predecessorStat = fs.statSync(predecessor);
    const candidateStat = fs.statSync(candidate);
    for (const [runtime, stat] of [
      [predecessor, predecessorStat],
      [candidate, candidateStat],
    ] as const) {
      execFileSync(state.python, [
        filesystemHelper,
        'seal',
        '--base', state.base,
        '--runtime', runtime,
        '--expect-dev', String(stat.dev),
        '--expect-ino', String(stat.ino),
        '--test-mode',
      ]);
    }
    fs.symlinkSync(predecessor, path.join(state.base, 'current'));
    const marker = path.join(state.root, 'switch-fd-opened');
    const resume = path.join(state.root, 'switch-fd-resume');
    const child = spawn(state.python, [
      filesystemHelper,
      'switch-selector',
      '--base', state.base,
      '--expected', predecessor,
      '--target', candidate,
      '--expect-dev', String(predecessorStat.dev),
      '--expect-ino', String(predecessorStat.ino),
      '--target-dev', String(candidateStat.dev),
      '--target-ino', String(candidateStat.ino),
      '--switch-marker', marker,
      '--switch-resume', resume,
      '--test-mode',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    waitForPath(marker);
    fs.renameSync(candidate, `${candidate}.retained`);
    fs.mkdirSync(candidate, { mode: 0o555 });
    fs.writeFileSync(resume, 'resume\n', { mode: 0o600 });
    const status = child.exitCode ?? await new Promise<number | null>(
      (resolve) => child.on('exit', resolve),
    );
    expect(status).not.toBe(0);
    expect(fs.realpathSync(path.join(state.base, 'current'))).toBe(predecessor);
  });

  it('rejects writable descriptors, mappings, and incomplete procfs scans', () => {
    const state = fixture();
    const runtime = path.join(state.base, 'releases', 'proc-runtime');
    fs.mkdirSync(runtime, { mode: 0o700 });
    const payload = path.join(runtime, 'payload.bin');
    fs.writeFileSync(payload, 'sealed payload\n', { mode: 0o600 });
    const runtimeStat = fs.statSync(runtime);
    execFileSync(state.python, [
      filesystemHelper,
      'seal',
      '--base', state.base,
      '--runtime', runtime,
      '--expect-dev', String(runtimeStat.dev),
      '--expect-ino', String(runtimeStat.ino),
      '--test-mode',
    ]);
    const procRoot = path.join(state.root, 'fake-proc');
    const processRoot = path.join(procRoot, '4242');
    const descriptors = path.join(processRoot, 'fd');
    const descriptorInfo = path.join(processRoot, 'fdinfo');
    fs.mkdirSync(descriptors, { recursive: true, mode: 0o700 });
    fs.mkdirSync(descriptorInfo, { mode: 0o700 });
    fs.symlinkSync(payload, path.join(descriptors, '9'));
    fs.writeFileSync(path.join(descriptorInfo, '9'), 'flags:\t0100002\n');
    const command = [
      filesystemHelper,
      'assert-no-writable-references',
      '--base', state.base,
      '--runtime', runtime,
      '--expect-dev', String(runtimeStat.dev),
      '--expect-ino', String(runtimeStat.ino),
      '--proc-root', procRoot,
      '--test-mode',
    ];
    const writableDescriptor = spawnSync(state.python, command, {
      encoding: 'utf8',
    });
    expect(writableDescriptor.status).not.toBe(0);
    expect(`${writableDescriptor.stdout}${writableDescriptor.stderr}`)
      .toContain('writable file descriptor');

    fs.writeFileSync(path.join(descriptorInfo, '9'), 'flags:\t0100000\n');
    const incomplete = spawnSync(state.python, command, { encoding: 'utf8' });
    expect(incomplete.status).not.toBe(0);
    expect(`${incomplete.stdout}${incomplete.stderr}`)
      .toContain('mapping inventory is incomplete');

    fs.writeFileSync(path.join(processRoot, 'maps'), '');
    expect(execFileSync(state.python, command, { encoding: 'utf8' }))
      .toContain('"ok":true');
    const device = execFileSync(state.python, [
      '-c',
      'import os,sys; s=os.stat(sys.argv[1]); '
      + 'print(f"{os.major(s.st_dev):x}:{os.minor(s.st_dev):x}")',
      payload,
    ], { encoding: 'utf8' }).trim();
    const payloadStat = fs.statSync(payload);
    fs.writeFileSync(
      path.join(processRoot, 'maps'),
      `1000-2000 rw-p 00000000 ${device} ${payloadStat.ino} ${payload}\n`,
    );
    const writableMapping = spawnSync(state.python, command, {
      encoding: 'utf8',
    });
    expect(writableMapping.status).not.toBe(0);
    expect(`${writableMapping.stdout}${writableMapping.stderr}`)
      .toContain('writable file mapping');
  });

  it('rejects a symlinked worker ancestor without mutating its target', () => {
    const state = fixture();
    const outside = path.join(state.root, 'outside-upload');
    fs.mkdirSync(outside, { mode: 0o750 });
    fs.symlinkSync(outside, path.join(state.base, '.local'));
    const before = fs.statSync(outside);
    const result = spawnSync('bash', [broker, 'inspect'], {
      encoding: 'utf8',
      env: brokerEnvironment(state),
    });
    expect(result.status).not.toBe(0);
    const after = fs.statSync(outside);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('copies an opened request descriptor even when its pathname is swapped', async () => {
    const state = fixture();
    const releases = path.join(state.base, 'releases');
    const predecessor = path.join(
      releases,
      `${'1'.repeat(40)}-${'2'.repeat(12)}`,
    );
    fs.mkdirSync(predecessor, { recursive: true, mode: 0o700 });
    fs.symlinkSync(predecessor, path.join(state.base, 'current'));
    const env = brokerEnvironment(state);
    const prepared = JSON.parse(execFileSync('bash', [
      broker,
      'prepare',
      requestId,
      runtimeSha,
      state.artifactDigest,
    ], { encoding: 'utf8', env }));
    const inspection = path.join(state.root, 'broker-inspection.json');
    fs.writeFileSync(inspection, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-broker-inspection.v1',
      promotionAllowed: false,
      base: state.base,
      workerUser: 'dominguez',
      broker: {
        version: 'nexus-rollback-drill-legacy-staging-broker.v1',
        sha256: sha256(fs.readFileSync(broker)),
        adapterSha256: sha256(fs.readFileSync(adapter)),
      },
      control: {
        version: 'nexus-release-promotion-control.v2',
        sha256: env.NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256,
      },
    }, null, 2)}\n`);
    const request = path.join(state.root, 'worker-request.json');
    execFileSync(process.execPath, [
      adapter,
      'build-transaction-request',
      '--manifest', state.manifest,
      '--inspection', inspection,
      '--request-id', requestId,
      '--public-key', state.publicKey,
      '--output', request,
    ], {
      encoding: 'utf8',
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
          env.NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256,
      },
    });
    fs.copyFileSync(request, prepared.requestUpload);
    fs.chmodSync(prepared.requestUpload, 0o600);
    const opened = path.join(state.root, 'request-fd-opened');
    const resume = path.join(state.root, 'request-fd-resume');
    const child = spawn('bash', [broker, 'launch', requestId], {
      env: {
        ...env,
        NEXUS_LEGACY_DRILL_TEST_REQUEST_FD_OPEN_MARKER: opened,
        NEXUS_LEGACY_DRILL_TEST_REQUEST_FD_RESUME_MARKER: resume,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    waitForPath(opened);
    const uploadDirectory = path.dirname(prepared.requestUpload);
    const retainedDirectory = `${uploadDirectory}.retained`;
    fs.renameSync(uploadDirectory, retainedDirectory);
    fs.mkdirSync(uploadDirectory, { mode: 0o700 });
    fs.writeFileSync(prepared.requestUpload, '{}\n', { mode: 0o600 });
    fs.writeFileSync(resume, 'resume\n', { mode: 0o600 });
    const status = child.exitCode ?? await new Promise<number | null>(
      (resolve) => {
        child.on('exit', resolve);
      },
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      requestId,
      status: 'submitted',
    });
    const accepted = path.join(state.root, 'requests', `${requestId}.json`);
    expect(sha256(fs.readFileSync(accepted)))
      .toBe(sha256(fs.readFileSync(request)));
    expect(fs.readFileSync(prepared.requestUpload, 'utf8')).toBe('{}\n');
  });

  it('boot recovery restores the stopped database before the predecessor starts', () => {
    const state = fixture();
    const transactionDirectory = path.join(state.transactionRoot, requestId);
    fs.mkdirSync(transactionDirectory, { mode: 0o700 });
    const databaseBackup = JSON.parse(execFileSync(process.execPath, [
      adapter,
      'snapshot-database',
      '--request-id', requestId,
    ], { encoding: 'utf8', env: state.env })).databaseBackup;
    execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "connection.execute(\"UPDATE release_state SET value='candidate'\")",
      'connection.commit()',
      'connection.close()',
    ].join(';'), state.database]);
    fs.writeFileSync(`${state.database}-wal`, 'candidate wal', { mode: 0o600 });
    fs.writeFileSync(`${state.database}-shm`, 'candidate shm', { mode: 0o600 });

    const predecessor = path.join(
      state.base,
      'releases',
      `${'1'.repeat(40)}-${'2'.repeat(12)}`,
    );
    const candidate = path.join(
      state.base,
      'releases',
      `${runtimeSha}-${state.artifactDigest.slice(0, 12)}`,
    );
    fs.mkdirSync(predecessor, { recursive: true, mode: 0o700 });
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(predecessor, 'ecosystem.release.config.js'), '');
    const predecessorMarker = Buffer.from('predecessor marker\n');
    fs.writeFileSync(path.join(predecessor, '.complete.json'), predecessorMarker);
    const predecessorInstalled = Buffer.from('pinned predecessor installed\n');
    const predecessorRecovery = Buffer.from('pinned predecessor recovery\n');
    fs.writeFileSync(
      path.join(predecessor, '.nexus-installed-runtime.json'),
      predecessorInstalled,
    );
    fs.writeFileSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      predecessorRecovery,
    );
    fs.writeFileSync(
      path.join(transactionDirectory, 'predecessor-installed-runtime.json'),
      predecessorInstalled,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(transactionDirectory, 'predecessor-recovery-runtime.json'),
      predecessorRecovery,
      { mode: 0o600 },
    );
    const predecessorStat = fs.statSync(predecessor);
    const candidateStat = fs.statSync(candidate);
    const predecessorMetadata = path.join(
      transactionDirectory,
      'predecessor-metadata.json',
    );
    const candidateMetadata = path.join(
      transactionDirectory,
      'candidate-metadata.json',
    );
    for (const [runtime, stat, output] of [
      [predecessor, predecessorStat, predecessorMetadata],
      [candidate, candidateStat, candidateMetadata],
    ] as const) {
      execFileSync(state.python, [
        filesystemHelper,
        'capture',
        '--base', state.base,
        '--runtime', runtime,
        '--expect-dev', String(stat.dev),
        '--expect-ino', String(stat.ino),
        '--output', output,
        '--test-mode',
      ]);
    }
    execFileSync(state.python, [
      filesystemHelper,
      'seal',
      '--base', state.base,
      '--runtime', predecessor,
      '--expect-dev', String(predecessorStat.dev),
      '--expect-ino', String(predecessorStat.ino),
      '--test-mode',
    ]);
    fs.symlinkSync(candidate, path.join(state.base, 'current'));
    const journal = path.join(transactionDirectory, 'journal.json');
    fs.writeFileSync(journal, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      phase: 'candidate_started',
      requestId,
      candidateRuntime: candidate,
      candidateRuntimeIdentity: {
        dev: String(candidateStat.dev),
        ino: String(candidateStat.ino),
        uid: candidateStat.uid,
        gid: candidateStat.gid,
        mode: 0o700,
      },
      candidateMetadataSha256: sha256(fs.readFileSync(candidateMetadata)),
      predecessor: {
        runtime: predecessor,
        runtimeSha: '1'.repeat(40),
        artifactDigest: '2'.repeat(64),
        installedAttestationSha256: sha256(predecessorInstalled),
        recoveryAttestationSha256: sha256(predecessorRecovery),
        markerSha256: sha256(predecessorMarker),
        metadataSha256: sha256(fs.readFileSync(predecessorMetadata)),
        runtimeIdentity: {
          dev: String(predecessorStat.dev),
          ino: String(predecessorStat.ino),
          uid: predecessorStat.uid,
          gid: predecessorStat.gid,
          mode: 0o700,
        },
      },
      outageStartedEpoch: Math.floor(Date.now() / 1000),
      outageBootId: 'test-boot-id',
      outageStartedMonotonic: Number(process.hrtime.bigint() / 1_000_000_000n),
      outageStartedMonotonicNs: String(process.hrtime.bigint()),
      databaseBackup,
    }, null, 2)}\n`, { mode: 0o600 });

    const control = executable(state.root, 'control', `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v2 ;;
  assert-idle) exit 0 ;;
  *) exit 64 ;;
esac
`);
    const pm2Log = path.join(state.root, 'pm2.log');
    const pm2 = executable(state.root, 'pm2', `#!/bin/sh
if [ "$1" = jlist ]; then
  printf '%s\\n' '[{"name":"nexus-hub-staging"},{"name":"content-engine-staging"}]'
  exit 0
fi
printf '%s\\n' "$*" >> "$NEXUS_TEST_PM2_LOG"
`);
    const timeout = executable(state.root, 'timeout', `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --signal=*|--kill-after=*) shift ;;
    *s) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`);
    const readiness = executable(state.root, 'readiness', '#!/bin/sh\nexit 0\n');
    const flock = executable(state.root, 'flock', '#!/bin/sh\nexit 0\n');
    const workerHome = path.join(state.root, 'worker-home');
    const promotionRoot = path.join(state.root, 'promotion-state');
    const sonarLock = path.join(state.root, 'sonar.lock');
    const procRoot = path.join(state.root, 'recovery-proc');
    fs.mkdirSync(procRoot, { mode: 0o700 });
    const recoveryEnvironment = {
      ...state.env,
      NEXUS_LEGACY_DRILL_TEST_MODE: '1',
      NEXUS_LEGACY_DRILL_TEST_SKIP_DEPENDENCIES: '1',
      NEXUS_LEGACY_DRILL_STATE_ROOT: state.root,
      NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
      NEXUS_LEGACY_DRILL_WORKER_HOME: workerHome,
      NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
      NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
        sha256(fs.readFileSync(control)),
      NEXUS_LEGACY_DRILL_ADAPTER_BIN: adapter,
      NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
      NEXUS_LEGACY_DRILL_PM2_BIN: pm2,
      NEXUS_LEGACY_DRILL_BASH_BIN: readiness,
      NEXUS_LEGACY_DRILL_TIMEOUT_BIN: timeout,
      NEXUS_LEGACY_DRILL_ENV_BIN: '/usr/bin/env',
      NEXUS_LEGACY_DRILL_FLOCK_BIN: flock,
      NEXUS_PROMOTION_STATE_ROOT: promotionRoot,
      NEXUS_LEGACY_DRILL_SONAR_LOCK: sonarLock,
      NEXUS_LEGACY_DRILL_PROC_ROOT: procRoot,
      NEXUS_TEST_PM2_LOG: pm2Log,
    };
    fs.chmodSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      0o644,
    );
    fs.appendFileSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      'drift\n',
    );
    fs.chmodSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      0o444,
    );
    const drifted = spawnSync('bash', [broker, 'recover-all'], {
      encoding: 'utf8',
      env: recoveryEnvironment,
    });
    expect(drifted.status).not.toBe(0);
    expect(fs.existsSync(pm2Log) ? fs.readFileSync(pm2Log, 'utf8') : '')
      .not.toContain('start');
    fs.chmodSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      0o644,
    );
    fs.writeFileSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      predecessorRecovery,
    );
    fs.chmodSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      0o444,
    );
    for (const recoveryFailure of [
      'database',
      'selector',
      'pm2_start',
      'readiness',
      'metadata',
    ]) {
      const recoveryFailed = spawnSync('bash', [broker, 'recover-all'], {
        encoding: 'utf8',
        env: {
          ...recoveryEnvironment,
          NEXUS_LEGACY_DRILL_TEST_RECOVERY_FAIL_PHASE: recoveryFailure,
        },
      });
      expect(
        recoveryFailed.status,
        `${recoveryFailure}\n${recoveryFailed.stdout}\n${recoveryFailed.stderr}`,
      ).not.toBe(0);
      expect(`${recoveryFailed.stdout}${recoveryFailed.stderr}`).toContain(
        `injected recovery failure: ${recoveryFailure}`,
      );
      expect(JSON.parse(fs.readFileSync(journal, 'utf8'))).toMatchObject({
        phase: 'candidate_started',
      });
      expect(fs.existsSync(path.join(
        transactionDirectory,
        'evidence.json',
      ))).toBe(false);
    }
    const result = spawnSync('bash', [broker, 'recover-all'], {
      encoding: 'utf8',
      env: recoveryEnvironment,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(state.database);
    expect(result.status).toBe(0);
    expect(fs.realpathSync(path.join(state.base, 'current'))).toBe(predecessor);
    expect(JSON.parse(fs.readFileSync(journal, 'utf8'))).toMatchObject({
      phase: 'recovered',
      recoveryTargetMet: true,
      recoveryTargetSeconds: 120,
      recoveryClock: 'journaled_monotonic',
      sameBoot: true,
    });
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('predecessor');
    const pm2Actions = fs.readFileSync(pm2Log, 'utf8');
    expect(pm2Actions.indexOf('delete nexus-hub-staging'))
      .toBeLessThan(pm2Actions.indexOf('start'));
    expect(pm2Actions.indexOf('delete content-engine-staging'))
      .toBeLessThan(pm2Actions.indexOf('start'));
  }, 45_000);

  it('runs the full broker and restores after a post-switch candidate-start fault', () => {
    const state = fixture();
    const releases = path.join(state.base, 'releases');
    const predecessorSha = '1'.repeat(40);
    const predecessorDigest = '2'.repeat(64);
    const predecessor = path.join(
      releases,
      `${predecessorSha}-${predecessorDigest.slice(0, 12)}`,
    );
    fs.mkdirSync(predecessor, { mode: 0o700 });
    fs.writeFileSync(path.join(predecessor, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha: predecessorSha,
      artifactDigest: predecessorDigest,
      fileCount: 0,
    })}\n`);
    fs.writeFileSync(
      path.join(predecessor, '.nexus-installed-runtime.json'),
      'predecessor installed\n',
    );
    fs.writeFileSync(
      path.join(predecessor, '.nexus-recovery-runtime.json'),
      'predecessor recovery\n',
    );
    fs.writeFileSync(
      path.join(predecessor, 'ecosystem.release.config.js'),
      'module.exports = {};\n',
    );
    fs.mkdirSync(path.join(predecessor, 'scripts'));
    fs.writeFileSync(
      path.join(predecessor, 'scripts', 'remote-release-readiness.sh'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    );
    fs.symlinkSync(predecessor, path.join(state.base, 'current'));

    const pm2Log = path.join(state.root, 'full-broker-pm2.log');
    const pm2 = executable(state.root, 'full-broker-pm2', `#!/bin/sh
if [ "$1" = jlist ]; then
  printf '%s\\n' '[{"name":"nexus-hub-staging"},{"name":"content-engine-staging"}]'
  exit 0
fi
printf '%s\\n' "$*" >> "$NEXUS_TEST_PM2_LOG"
`);
    const timeout = executable(state.root, 'full-broker-timeout', `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in --signal=*|--kill-after=*) shift ;; *s) shift; break ;; *) break ;; esac
done
exec "$@"
`);
    const shell = executable(state.root, 'full-broker-shell', '#!/bin/sh\nexit 0\n');
    const env = {
      ...brokerEnvironment(state),
      NEXUS_LEGACY_DRILL_TEST_RUN_SYNC: '1',
      NEXUS_LEGACY_DRILL_TEST_SKIP_DEPENDENCIES: '1',
      NEXUS_LEGACY_DRILL_TEST_FAIL_PHASE: 'after_candidate_start',
      NEXUS_LEGACY_DRILL_TEST_OUTAGE_BOOT_ID: 'previous-test-boot-id',
      NEXUS_LEGACY_DRILL_PM2_BIN: pm2,
      NEXUS_LEGACY_DRILL_TIMEOUT_BIN: timeout,
      NEXUS_LEGACY_DRILL_BASH_BIN: shell,
      NEXUS_TEST_PM2_LOG: pm2Log,
    };
    const prepared = JSON.parse(execFileSync('bash', [
      broker,
      'prepare',
      requestId,
      runtimeSha,
      state.artifactDigest,
    ], { encoding: 'utf8', env }));
    fs.cpSync(state.bundle, prepared.releaseDir, { recursive: true });
    const inspection = path.join(state.root, 'full-broker-inspection.json');
    fs.writeFileSync(inspection, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-broker-inspection.v1',
      promotionAllowed: false,
      base: state.base,
      workerUser: 'dominguez',
      broker: {
        version: 'nexus-rollback-drill-legacy-staging-broker.v1',
        sha256: sha256(fs.readFileSync(broker)),
        adapterSha256: sha256(fs.readFileSync(adapter)),
      },
      control: {
        version: 'nexus-release-promotion-control.v2',
        sha256: env.NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256,
      },
    }, null, 2)}\n`);
    const request = path.join(state.root, 'full-broker-request.json');
    execFileSync(process.execPath, [
      adapter,
      'build-transaction-request',
      '--manifest', state.manifest,
      '--inspection', inspection,
      '--request-id', requestId,
      '--public-key', state.publicKey,
      '--output', request,
    ], {
      env: {
        ...state.env,
        NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
          env.NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256,
      },
    });
    fs.copyFileSync(request, prepared.requestUpload);
    fs.chmodSync(prepared.requestUpload, 0o600);
    const failed = spawnSync('bash', [broker, 'launch', requestId], {
      encoding: 'utf8',
      env,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.signal, JSON.stringify({
      status: failed.status,
      stdout: failed.stdout,
      stderr: failed.stderr,
      error: failed.error?.message,
    })).toBeNull();
    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).toBe(75);
    expect(fs.realpathSync(path.join(state.base, 'current'))).toBe(predecessor);
    const journal = JSON.parse(fs.readFileSync(
      path.join(state.transactionRoot, requestId, 'journal.json'),
      'utf8',
    ));
    expect(journal, `${failed.stdout}\n${failed.stderr}`).toMatchObject({
      phase: 'recovered',
      recoveryClock: 'cross_boot_unverifiable',
      recoveryTargetMet: false,
      sameBoot: false,
      outageBootId: 'previous-test-boot-id',
      recoveryBootId: 'test-boot-id',
    });
    expect(execFileSync(state.python, ['-c', [
      'import sqlite3,sys',
      'connection=sqlite3.connect(sys.argv[1])',
      "print(connection.execute('SELECT value FROM release_state').fetchone()[0])",
      'connection.close()',
    ].join(';'), state.database], { encoding: 'utf8' }).trim())
      .toBe('predecessor');
    expect(fs.existsSync(pm2Log), `${failed.stdout}\n${failed.stderr}`).toBe(true);
    expect(fs.readFileSync(pm2Log, 'utf8')).toContain(
      `start ${predecessor}/ecosystem.release.config.js --update-env`,
    );
  });

  it('recovers the initial adapter install after power loss at every PM2 mutation', () => {
    for (const checkpoint of [
      'install_recovery_enabled',
      'pm2_dominguez_dropin_installed',
      'pm2_root_dropin_installed',
    ]) {
      const state = fixture();
      const bootstrap = installerBootstrap(state, checkpoint);
      const targetRoot = path.join(state.root, `install-target-${checkpoint}`);
      const installState = path.join(state.root, `install-state-${checkpoint}`);
      const promotionState = path.join(
        state.root,
        `promotion-state-${checkpoint}`,
      );
      fs.mkdirSync(targetRoot, { mode: 0o700 });
      fs.mkdirSync(promotionState, { mode: 0o700 });
      fs.writeFileSync(path.join(promotionState, '.control.lock'), '', {
        mode: 0o600,
      });
      const sonarLock = path.join(state.root, `sonar-${checkpoint}.lock`);
      fs.writeFileSync(sonarLock, '', { mode: 0o600 });
      const control = executable(
        state.root,
        `control-${checkpoint}`,
        `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v2 ;;
  assert-idle) exit 0 ;;
  *) exit 64 ;;
esac
`,
      );
      fs.chmodSync(control, 0o700);
      const sqliteTarget = path.join(
        targetRoot,
        'usr/local/libexec/nexus-application-dr/application-dr-sqlite.py',
      );
      fs.mkdirSync(path.dirname(sqliteTarget), {
        recursive: true,
        mode: 0o755,
      });
      fs.copyFileSync(sqliteToolSource, sqliteTarget);
      fs.chmodSync(sqliteTarget, 0o644);
      const sourceInstaller = path.join(
        bootstrap.sourceRoot,
        'scripts',
        'remote-rollback-drill-legacy-staging-install.sh',
      );
      const env = {
        ...process.env,
        NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE: '1',
        NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: targetRoot,
        NEXUS_LEGACY_DRILL_STATE_ROOT: installState,
        NEXUS_LEGACY_DRILL_BOOTSTRAP_BASE: bootstrap.bootstrapBase,
        NEXUS_PROMOTION_STATE_ROOT: promotionState,
        NEXUS_LEGACY_DRILL_SONAR_LOCK: sonarLock,
        NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
        NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
          sha256(fs.readFileSync(control)),
        NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:
          sha256(fs.readFileSync(sqliteTarget)),
        NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
        NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN: '/usr/bin/true',
        NEXUS_LEGACY_DRILL_FLOCK_BIN: '/usr/bin/true',
        NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
        NEXUS_LEGACY_DRILL_TEST_POWER_LOSS_AFTER: checkpoint,
      };
      const crashed = spawnSync('bash', [
        sourceInstaller,
        'install',
        bootstrap.sourceRoot,
        bootstrap.sourceSha,
        bootstrap.sourceArchive,
        bootstrap.archiveSha256,
      ], { encoding: 'utf8', env });
      expect(
        crashed.status,
        `${checkpoint}\n${crashed.stdout}\n${crashed.stderr}`,
      ).toBe(197);
      const journal = path.join(
        installState,
        'install',
        'install-in-progress.v1.json',
      );
      const receipt = path.join(installState, 'install-receipt.v1.json');
      const fixedInstaller = path.join(
        targetRoot,
        'usr/local/sbin/nexus-rollback-drill-legacy-staging-install',
      );
      const installRecovery = path.join(
        targetRoot,
        'etc/systemd/system/'
        + 'nexus-rollback-drill-legacy-staging-install-recovery.service',
      );
      const pm2Dominguez = path.join(
        targetRoot,
        'etc/systemd/system/pm2-dominguez.service.d/'
        + '10-nexus-rollback-drill-legacy-staging-recovery.conf',
      );
      const pm2Root = path.join(
        targetRoot,
        'etc/systemd/system/pm2-root.service.d/'
        + '10-nexus-rollback-drill-legacy-staging-recovery.conf',
      );
      expect(fs.existsSync(journal)).toBe(true);
      expect(fs.existsSync(receipt)).toBe(false);
      expect(fs.existsSync(fixedInstaller)).toBe(true);
      expect(fs.existsSync(installRecovery)).toBe(true);
      expect(fs.existsSync(pm2Dominguez)).toBe(
        checkpoint !== 'install_recovery_enabled',
      );
      expect(fs.existsSync(pm2Root)).toBe(
        checkpoint === 'pm2_root_dropin_installed',
      );
      const journalValue = JSON.parse(fs.readFileSync(journal, 'utf8'));
      expect(journalValue).toMatchObject({
        predecessorInventory: {
          schema:
            'nexus.rollback-drill-legacy-staging-install-backup-inventory.v1',
        },
      });
      expect(journalValue.predecessorInventory.aggregateSha256)
        .toMatch(/^[a-f0-9]{64}$/u);
      if (checkpoint === 'pm2_dominguez_dropin_installed') {
        const predecessorMode = path.join(
          installState,
          'install',
          'predecessor',
          '0.mode',
        );
        const originalMode = fs.readFileSync(predecessorMode);
        fs.appendFileSync(predecessorMode, 'tampered\n');
        const blocked = spawnSync('bash', [
          fixedInstaller,
          'recover-journal',
        ], {
          encoding: 'utf8',
          env: {
            ...env,
            NEXUS_LEGACY_DRILL_TEST_POWER_LOSS_AFTER: '',
          },
        });
        expect(blocked.status).not.toBe(0);
        expect(`${blocked.stdout}${blocked.stderr}`)
          .toContain('install backup inventory');
        expect(fs.existsSync(journal)).toBe(true);
        fs.writeFileSync(predecessorMode, originalMode, { mode: 0o600 });
      }

      const recovered = spawnSync('bash', [
        fixedInstaller,
        'recover-journal',
      ], {
        encoding: 'utf8',
        env: {
          ...env,
          NEXUS_LEGACY_DRILL_TEST_POWER_LOSS_AFTER: '',
        },
      });
      expect(
        recovered.status,
        `${checkpoint}\n${recovered.stdout}\n${recovered.stderr}`,
      ).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        ok: true,
        installed: false,
        promotable: false,
        status: 'recovered_predecessor',
      });
      for (const restored of [
        fixedInstaller,
        installRecovery,
        pm2Dominguez,
        pm2Root,
      ]) {
        expect(fs.existsSync(restored), `${checkpoint}: ${restored}`).toBe(false);
      }
      expect(fs.existsSync(journal)).toBe(false);
      expect(fs.existsSync(receipt)).toBe(false);
      expect(fs.existsSync(sqliteTarget)).toBe(true);
    }
  }, 75_000);

  it('installs the first v4 pre-layout drill against the Phase A 0755 control', () => {
    const {
      bootstrap,
      targetRoot,
      installState,
      controlDigest,
      phaseAReceipt,
      env,
      brokerEnv,
      fixedInstaller,
      fixedBroker,
      installed,
    } = installedV4PrelayoutFixture('v4-prelayout');
    expect(JSON.parse(installed.stdout)).toMatchObject({
      ok: true,
      installed: true,
      promotable: false,
      sourceSha: bootstrap.sourceSha,
    });
    const receiptFile = path.join(installState, 'install-receipt.v1.json');
    const receiptBody = fs.readFileSync(receiptFile);
    const receipt = JSON.parse(receiptBody.toString('utf8'));
    expect(receipt).toMatchObject({
      schema: 'nexus.rollback-drill-v4-prelayout-staging-install-receipt.v1',
      promotionAllowed: false,
      control: {
        version: 'nexus-release-promotion-control.v4',
        sha256: controlDigest,
      },
      phaseA: {
        sourceSha: bootstrap.sourceSha,
        archiveSha256: bootstrap.archiveSha256,
        receiptSha256: sha256(fs.readFileSync(phaseAReceipt)),
      },
    });
    const promotionRecoveryDropIn = path.join(
      targetRoot,
      'etc/systemd/system/nexus-release-promotion-recovery.service.d/'
      + '15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf',
    );
    expect(receipt.installed.promotionRecoveryDropIn).toBe(
      sha256(fs.readFileSync(promotionRecoveryDropIn)),
    );
    expect(fs.existsSync(fixedBroker)).toBe(true);
    const sudoers = path.join(
      targetRoot,
      'etc/sudoers.d/nexus-rollback-drill-v4-prelayout-staging',
    );
    expect(fs.readFileSync(sudoers, 'utf8')).not.toContain(
      'activate-from-phase-a',
    );
    fs.chmodSync(fixedBroker, 0o755);
    const drifted = spawnSync('bash', [fixedInstaller, 'status'], {
      encoding: 'utf8',
      env,
    });
    expect(drifted.status).not.toBe(0);
    fs.chmodSync(fixedBroker, 0o700);
    expect(JSON.parse(execFileSync('bash', [
      fixedInstaller,
      'status',
    ], { encoding: 'utf8', env }))).toMatchObject({
      ok: true,
      installed: true,
      promotable: false,
    });
    const inspectEnv = {
      ...brokerEnv,
      NEXUS_LEGACY_DRILL_TEST_VALIDATE_INSTALL_RECEIPT: '1',
    };
    expect(JSON.parse(execFileSync('bash', [
      fixedBroker,
      'inspect',
    ], { encoding: 'utf8', env: inspectEnv }))).toMatchObject({
      promotionAllowed: false,
      control: { version: 'nexus-release-promotion-control.v4' },
    });
    const missingDependency = JSON.parse(receiptBody.toString('utf8'));
    delete missingDependency.installed.promotionRecoveryDropIn;
    fs.writeFileSync(
      receiptFile,
      `${JSON.stringify(missingDependency, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect(spawnSync('bash', [
      fixedBroker,
      'inspect',
    ], { encoding: 'utf8', env: inspectEnv }).status).not.toBe(0);
    fs.writeFileSync(receiptFile, receiptBody, { mode: 0o600 });
    fs.chmodSync(promotionRecoveryDropIn, 0o600);
    expect(spawnSync('bash', [
      fixedBroker,
      'inspect',
    ], { encoding: 'utf8', env: inspectEnv }).status).not.toBe(0);
    fs.chmodSync(promotionRecoveryDropIn, 0o644);
  }, 30_000);

  it('recovers V4 activation after the promotion dependency is durably installed', () => {
    const installed = installedV4PrelayoutFixture(
      'v4-promotion-dependency-power-loss',
      'promotion_recovery_dropin_installed',
    );
    const promotionRecoveryDropIn = path.join(
      installed.targetRoot,
      'etc/systemd/system/nexus-release-promotion-recovery.service.d/'
      + '15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf',
    );
    const journal = path.join(
      installed.installState,
      'install/install-in-progress.v1.json',
    );
    const receipt = path.join(
      installed.installState,
      'install-receipt.v1.json',
    );
    expect(fs.existsSync(promotionRecoveryDropIn)).toBe(true);
    expect(fs.existsSync(journal)).toBe(true);
    expect(fs.existsSync(receipt)).toBe(false);

    const recovered = spawnSync('bash', [
      installed.fixedInstaller,
      'recover-journal',
    ], {
      encoding: 'utf8',
      env: {
        ...installed.brokerEnv,
        NEXUS_LEGACY_DRILL_TEST_POWER_LOSS_AFTER: '',
      },
    });
    expect(
      recovered.status,
      `${recovered.stdout}\n${recovered.stderr}`,
    ).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      installed: false,
      promotable: false,
      status: 'recovered_predecessor',
    });
    expect(fs.existsSync(promotionRecoveryDropIn)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.existsSync(receipt)).toBe(false);
  }, 30_000);

  it('keeps v4 boot recovery ordered and retires it only inside Phase B locks', () => {
    const installRecovery = fs.readFileSync(v4InstallRecoveryUnit, 'utf8');
    const recovery = fs.readFileSync(v4RecoveryUnit, 'utf8');
    const pm2Guard = fs.readFileSync(v4Pm2RecoveryDropIn, 'utf8');
    const promotionRecoveryGuard = fs.readFileSync(
      v4PromotionRecoveryDropIn,
      'utf8',
    );
    const installerBody = fs.readFileSync(installer, 'utf8');
    const brokerBody = fs.readFileSync(broker, 'utf8');
    const activation = fs.readFileSync(layoutActivationInstaller, 'utf8');
    const activationControl = fs.readFileSync(
      layoutActivationControl,
      'utf8',
    );
    const operator = fs.readFileSync(releaseOperator, 'utf8');

    expect(installRecovery).toContain(
      'Before=nexus-rollback-drill-v4-prelayout-staging-recovery.service '
      + 'nexus-release-layout-install-recovery.service '
      + 'nexus-release-promotion-recovery.service '
      + 'pm2-dominguez.service pm2-root.service',
    );
    expect(recovery).toContain(
      'Requires=nexus-rollback-drill-v4-prelayout-staging-install-recovery.service '
      + 'nexus-release-layout-install-recovery.service '
      + 'nexus-release-layout-recovery.service',
    );
    expect(recovery).toContain(
      'After=local-fs.target '
      + 'nexus-rollback-drill-v4-prelayout-staging-install-recovery.service '
      + 'nexus-release-layout-install-recovery.service '
      + 'nexus-release-layout-recovery.service',
    );
    expect(recovery).toContain(
      'Before=network.target network-online.target multi-user.target '
      + 'nexus-release-promotion-recovery.service',
    );
    expect(recovery).toContain(
      'ExecStartPre=/usr/local/sbin/nexus-release-boot-health start-temporary',
    );
    expect(recovery).toContain(
      'ExecStartPre=/usr/local/sbin/nexus-release-boot-health preflight-temporary',
    );
    expect(pm2Guard).toContain(
      'ExecStartPre=+/usr/local/sbin/'
      + 'nexus-rollback-drill-v4-prelayout-staging-broker assert-boot-safe',
    );
    expect(promotionRecoveryGuard).toContain(
      'Requires=nexus-rollback-drill-v4-prelayout-staging-recovery.service',
    );
    expect(promotionRecoveryGuard).toContain(
      'After=nexus-rollback-drill-v4-prelayout-staging-recovery.service',
    );
    expect(installerBody).toContain(
      'atomic_install "$PROMOTION_RECOVERY_DROP_IN_SOURCE"',
    );
    expect(installerBody).toContain(
      'durable_remove_retirement_asset promotionRecoveryDropIn',
    );
    expect(brokerBody).toContain(
      '[ "$CONTROL_SHA256" = "$PHASE_A_CONTROL_SHA256" ]',
    );
    expect(installerBody).toContain(
      'EXPECTED_CONTROL_SHA256="$PHASE_A_CONTROL_SHA256"',
    );
    expect(brokerBody).not.toContain(
      'cbca74ac7da46b8c3f40a399b001fd12670969daff66523a3e25d6b539930dad',
    );
    expect(installerBody).not.toContain(
      'cbca74ac7da46b8c3f40a399b001fd12670969daff66523a3e25d6b539930dad',
    );
    expect(activation).toContain('exec 6<>"$ACTIVATION_LOCK"');
    expect(activation).toContain('"$FLOCK_BIN" -x 6');
    expect(activation).toContain(
      'NEXUS_V4_RETIRE_INHERITED_ACTIVATION_LOCK_FD='
      + '"$PHASE_B_ACTIVATION_LOCK_FD"',
    );
    expect(activation).toContain(
      'NEXUS_V4_RETIRE_INHERITED_CONTROL_LOCK_FD=7',
    );
    expect(activation).toContain(
      'NEXUS_V4_RETIRE_INHERITED_SONAR_LOCK_FD=8',
    );
    expect(activation).toContain(
      '"$V4_PRELAYOUT_INSTALLER" retire-for-layout',
    );
    expect(activationControl).toContain(
      'NEXUS_LAYOUT_INHERITED_ACTIVATION_LOCK_FD=9',
    );
    expect(operator).toContain(
      'the release operator never receives installer or retirement sudo authority',
    );
    expect(operator).not.toContain('sudo -n "$V4_PRELAYOUT_INSTALLER"');
  });

  it('reuses the caller-held activation lock for idle and journaled Phase B recovery', () => {
    const root = fs.mkdtempSync(path.join(
      fixtureParent(),
      'nexus-layout-nested-handover-',
    ));
    roots.push(root);
    const stateRoot = path.join(root, 'promotion');
    const activationRoot = path.join(stateRoot, 'layout-activation');
    const activationLock = path.join(activationRoot, '.activation.lock');
    const pm2Target = path.join(root, 'pm2', 'nexus-release-recovery.conf');
    const ingressTarget = path.join(root, 'ingress', 'nexus-release-ready.conf');
    const retirementLog = path.join(root, 'retirement.log');
    const v4Installer = executable(root, 'v4-installer', `#!/bin/sh
[ "$1" = retire-for-layout ] || exit 64
[ "$NEXUS_V4_RETIRE_INHERITED_ACTIVATION_LOCK_FD" = 9 ] || exit 65
[ "$NEXUS_V4_RETIRE_INHERITED_CONTROL_LOCK_FD" = 7 ] || exit 66
[ "$NEXUS_V4_RETIRE_INHERITED_SONAR_LOCK_FD" = 8 ] || exit 67
[ -e /dev/fd/9 ] && [ -e /dev/fd/7 ] && [ -e /dev/fd/8 ] || exit 68
printf 'retired\\n' >>${JSON.stringify(retirementLog)}
`);
    fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(activationLock, '', { mode: 0o600 });
    const env = {
      ...process.env,
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_LAYOUT_ACTIVATION_ROOT: activationRoot,
      NEXUS_LAYOUT_ACTIVATION_LOCK: activationLock,
      NEXUS_LAYOUT_CONTROL_LOCK: path.join(stateRoot, '.control.lock'),
      NEXUS_RELEASE_MUTEX: path.join(root, 'release-sonar.lock'),
      NEXUS_LEGACY_DRILL_STATE_ROOT: path.join(root, 'legacy-state'),
      NEXUS_LAYOUT_PM2_DROPIN: pm2Target,
      NEXUS_LAYOUT_INGRESS_DROPIN: ingressTarget,
      NEXUS_LAYOUT_SYSTEMCTL_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LAYOUT_NODE_BIN: process.execPath,
      NEXUS_LAYOUT_PYTHON_BIN: process.env.PYTHON ?? 'python3',
      NEXUS_LAYOUT_V4_PRELAYOUT_INSTALLER: v4Installer,
    };
    const nested = () => spawnSync('bash', [
      '-c',
      'exec 9<>"$2"; '
      + 'NEXUS_LAYOUT_INHERITED_ACTIVATION_LOCK_FD=9 '
      + 'exec bash "$1" recover-handover',
      'nested-phase-b-recovery',
      layoutActivationInstaller,
      activationLock,
    ], { encoding: 'utf8', env });
    const idle = nested();
    expect(idle.status, `${idle.stdout}\n${idle.stderr}`).toBe(0);
    expect(JSON.parse(idle.stdout)).toMatchObject({ status: 'idle' });

    const journal = path.join(
      activationRoot,
      'phase-b-handover-in-progress.v1.json',
    );
    fs.writeFileSync(journal, `${JSON.stringify({
      schema: 'nexus.release-layout-phase-b-journal.v1',
      status: 'in_progress',
      sourceSha: '1'.repeat(40),
      sourceArchiveSha256: '2'.repeat(64),
      layoutAttestationSha256: '3'.repeat(64),
      createdAt: new Date().toISOString(),
      targets: [
        { path: pm2Target, parentPresent: false, present: false },
        { path: ingressTarget, parentPresent: false, present: false },
      ],
    }, null, 2)}\n`, { mode: 0o600 });
    const recovered = nested();
    expect(
      recovered.status,
      `${recovered.stdout}\n${recovered.stderr}`,
    ).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      status: 'recovered',
    });
    expect(fs.existsSync(journal)).toBe(false);
    fs.writeFileSync(
      path.join(activationRoot, 'phase-b-receipt.v1.json'),
      '{}\n',
      { mode: 0o600 },
    );
    const reconciled = nested();
    expect(
      reconciled.status,
      `${reconciled.stdout}\n${reconciled.stderr}`,
    ).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toMatchObject({
      status: 'completed_reconciled',
    });
    expect(fs.readFileSync(retirementLog, 'utf8')).toBe('retired\n');
  });

  it('accepts only canonical v4 boot authorities and never overlaps recovery owners', () => {
    const installed = installedV4PrelayoutFixture('v4-boot-authority');
    const marker = path.join(
      installed.promotionState,
      'boot-recovery-in-progress.v1.json',
    );
    const epoch = Math.floor(Date.now() / 1000);
    const canonicalMarker = {
      schema: 'nexus.release-boot-recovery.v1',
      status: 'in_progress',
      bootId: 'v4-test-boot',
      bootDetectedAt: new Date(epoch * 1000).toISOString(),
      bootDetectedEpoch: epoch,
      outageStartedAt: new Date(epoch * 1000).toISOString(),
      outageStartedEpoch: epoch,
      outageStartedMonotonic: 10,
      outageBootId: 'v4-test-boot',
      recoveryDeadlineEpoch: epoch + 120,
      timingSource: 'boot_detection',
      activeTransactionId: null,
    };
    const env = {
      ...installed.brokerEnv,
      NEXUS_LEGACY_DRILL_TEST_BOOT_ID: 'v4-test-boot',
      NEXUS_TEST_BOOT_PROFILE_LOG: path.join(
        installed.state.root,
        'boot-profile.log',
      ),
    };
    const writeMarker = (value: Record<string, unknown>) => {
      fs.writeFileSync(marker, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.chmodSync(marker, 0o600);
    };
    const writePending = (
      value: typeof canonicalMarker,
      version: 2 | 3 = 3,
      profile: 'v4-prelayout' | 'layout' = 'v4-prelayout',
    ) => {
      const markerBody = fs.readFileSync(marker);
      const role = (name: 'production' | 'staging') => {
        const base = name === 'production'
          ? '/home/dominguez/telegram-hub-bot'
          : '/home/dominguez/telegram-hub-bot-staging';
        const basic = {
          base,
          runtime: `${base}/releases/${runtimeSha}`,
          runtimeSha,
        };
        return version === 2 ? basic : {
          schema: 'nexus.release-boot-role.v1',
          role: name,
          profile: profile === 'layout'
            ? 'layout'
            : name === 'production'
              ? 'legacy-worker'
              : 'v4-prelayout-sealed',
          ...basic,
          artifactDigest: installed.state.artifactDigest,
          installedRuntimeDigest: '4'.repeat(64),
          selector: { dev: '1', ino: '2', uid: 0, gid: 0, mode: 0o777 },
          runtimeIdentity: {
            dev: '3',
            ino: '4',
            uid: 0,
            gid: 0,
            mode: profile === 'layout' ? 0o550 : 0o555,
          },
          markerSha256: '5'.repeat(64),
          installedAttestationSha256: '6'.repeat(64),
          authoritySha256: '7'.repeat(64),
          transaction: null,
        };
      };
      fs.writeFileSync(
        path.join(installed.promotionState, 'boot-health-pending.v1.json'),
        `${JSON.stringify({
          schema: `nexus.release-boot-health-pending.v${version}`,
          status: 'pending',
          ...(version === 3 ? { profile } : {}),
          production: role('production'),
          staging: role('staging'),
          canonicalDumpSha256: '1'.repeat(64),
          pm2ClosureDigest: '2'.repeat(64),
          nodeSha256: '3'.repeat(64),
          recoveryAuthoritySha256: sha256(markerBody),
          bootId: value.bootId,
          outageBootId: value.outageBootId,
          outageStartedAt: value.outageStartedAt,
          outageStartedEpoch: value.outageStartedEpoch,
          outageStartedMonotonic: value.outageStartedMonotonic,
          recoveryDeadlineEpoch: value.recoveryDeadlineEpoch,
          temporaryPreparedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    };
    writeMarker(canonicalMarker);
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env }))).toMatchObject({
      ok: true,
      status: 'reconciled',
    });
    const ordinaryAdmission = spawnSync('bash', [
      installed.fixedBroker,
      'prepare',
      requestId,
      runtimeSha,
      installed.state.artifactDigest,
    ], { encoding: 'utf8', env });
    expect(ordinaryAdmission.status).not.toBe(0);
    for (const invalid of [
      { ...canonicalMarker, bootId: '' },
      { ...canonicalMarker, activeTransactionId: 'not-null' },
      { ...canonicalMarker, timingSource: 'promotion_cutover' },
      { ...canonicalMarker, recoveryDeadlineEpoch: epoch + 121 },
    ]) {
      writeMarker(invalid);
      const blocked = spawnSync('bash', [
        installed.fixedBroker,
        'recover-all',
      ], { encoding: 'utf8', env });
      expect(blocked.status).not.toBe(0);
    }

    fs.rmSync(marker);
    const ordinaryActive = path.join(installed.promotionState, 'active.json');
    fs.writeFileSync(ordinaryActive, `${JSON.stringify({
      schema: 'nexus.promotion-active.v1',
      transactionId: '20260726T010203Z-1-abcdef123456',
      requestSha256: '1'.repeat(64),
      envelopeSha256: '2'.repeat(64),
      activatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });
    const unfinished = path.join(
      installed.installState,
      'transactions',
      requestId,
    );
    fs.mkdirSync(unfinished, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(unfinished, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      requestId,
      phase: 'selector_switched',
    })}\n`, { mode: 0o600 });
    const ambiguous = spawnSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env });
    expect(ambiguous.status).not.toBe(0);
    fs.rmSync(unfinished, { recursive: true });
    fs.rmSync(ordinaryActive);

    const layoutMarker = {
      ...canonicalMarker,
      outageStartedAt: new Date((epoch - 5) * 1000).toISOString(),
      outageStartedEpoch: epoch - 5,
      outageBootId: 'prior-layout-boot',
      recoveryDeadlineEpoch: epoch + 115,
      timingSource: 'layout_recovery',
    };
    writeMarker(layoutMarker);
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });
    const prematurePm2 = spawnSync('bash', [
      installed.fixedBroker,
      'assert-boot-safe',
    ], { encoding: 'utf8', env });
    expect(prematurePm2.status).not.toBe(0);
    writePending(layoutMarker);
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'assert-boot-safe',
    ], { encoding: 'utf8', env }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });
    expect(fs.readFileSync(
      env.NEXUS_TEST_BOOT_PROFILE_LOG,
      'utf8',
    ).trim().split('\n').at(-1)).toBe('v4-prelayout');
    fs.writeFileSync(
      path.join(installed.promotionState, 'layout-migration.v1.json'),
      '{}\n',
      { mode: 0o600 },
    );
    writePending(layoutMarker, 3, 'layout');
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'assert-boot-safe',
    ], { encoding: 'utf8', env }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });
    expect(fs.readFileSync(
      env.NEXUS_TEST_BOOT_PROFILE_LOG,
      'utf8',
    ).trim().split('\n').at(-1)).toBe('layout');

    const terminalLayout = path.join(
      installed.promotionState,
      'layout-migration.v1.json',
    );
    const pending = path.join(
      installed.promotionState,
      'boot-health-pending.v1.json',
    );
    const oldBootMarker = {
      ...canonicalMarker,
      bootId: 'prior-boot',
      outageBootId: 'prior-boot',
      timingSource: 'promotion_cutover',
    };
    const oldBootEnv = {
      ...env,
      NEXUS_TEST_LAYOUT_ASSERT_MUST_BE_SKIPPED: '1',
    };
    fs.rmSync(pending);
    writeMarker(oldBootMarker);
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env: oldBootEnv }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });
    writePending(oldBootMarker, 2);
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env: oldBootEnv }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });
    fs.rmSync(terminalLayout);
    expect(JSON.parse(execFileSync('bash', [
      installed.fixedBroker,
      'recover-all',
    ], { encoding: 'utf8', env: oldBootEnv }))).toMatchObject({
      status: 'ordinary_promotion_recovery_owned',
    });

    fs.mkdirSync(unfinished, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(unfinished, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      requestId,
      phase: 'selector_switched',
    })}\n`, { mode: 0o600 });
    for (const withLayout of [false, true]) {
      if (withLayout) {
        fs.writeFileSync(terminalLayout, '{}\n', { mode: 0o600 });
      }
      const recoveryAttempt = spawnSync('bash', [
        installed.fixedBroker,
        'recover-all',
      ], { encoding: 'utf8', env: oldBootEnv });
      expect(recoveryAttempt.status).not.toBe(0);
      expect(recoveryAttempt.stderr).not.toContain(
        'another legacy staging drill transaction is unfinished',
      );
    }
  }, 45_000);

  it('retires v4 only after Phase B and one validated successful drill, resuming every durable boundary', () => {
    const installed = installedV4PrelayoutFixture('v4-retirement');
    installV4PhaseBGuard(installed);
    fs.mkdirSync(
      path.join(installed.installState, 'transactions'),
      { recursive: true, mode: 0o700 },
    );
    const withoutDrill = spawnSync('bash', [
      installed.fixedInstaller,
      'retire-for-layout',
    ], { encoding: 'utf8', env: installed.brokerEnv });
    expect(withoutDrill.status).not.toBe(0);
    expect(fs.existsSync(path.join(
      installed.installState,
      'retirement-receipt.v1.json',
    ))).toBe(false);

    writeValidV4DrillEvidence(installed);
    const targetSnapshot = path.join(installed.state.root, 'v4-target-snapshot');
    const stateSnapshot = path.join(installed.state.root, 'v4-state-snapshot');
    fs.cpSync(installed.targetRoot, targetSnapshot, {
      recursive: true,
      preserveTimestamps: true,
    });
    fs.cpSync(installed.installState, stateSnapshot, {
      recursive: true,
      preserveTimestamps: true,
    });
    const checkpoints = [
      'retirement_prepared',
      'retirement_recovery_disabled',
      'retirement_pm2_dominguez_removed',
      'retirement_pm2_root_removed',
      'retirement_promotion_recovery_dropin_removed',
      'retirement_sudoers_removed',
      'retirement_admission_closed',
      'retirement_receipt_archived',
      'retirement_active_receipt_removed',
      'retirement_authority_retired',
    ];
    for (const [index, checkpoint] of checkpoints.entries()) {
      fs.rmSync(installed.targetRoot, { recursive: true, force: true });
      fs.rmSync(installed.installState, { recursive: true, force: true });
      fs.cpSync(targetSnapshot, installed.targetRoot, {
        recursive: true,
        preserveTimestamps: true,
      });
      fs.cpSync(stateSnapshot, installed.installState, {
        recursive: true,
        preserveTimestamps: true,
      });
      const interrupted = spawnSync('bash', [
        installed.fixedInstaller,
        'retire-for-layout',
      ], {
        encoding: 'utf8',
        env: {
          ...installed.brokerEnv,
          NEXUS_LEGACY_DRILL_TEST_RETIRE_POWER_LOSS_AFTER: checkpoint,
        },
      });
      expect(
        interrupted.status,
        `${checkpoint}\n${interrupted.stdout}\n${interrupted.stderr}`,
      ).toBe(198);
      const retirementJournal = path.join(
        installed.installState,
        'install/retire-for-layout-in-progress.v1.json',
      );
      expect(fs.existsSync(retirementJournal)).toBe(true);
      if (index === 0) {
        const original = fs.readFileSync(retirementJournal);
        fs.appendFileSync(retirementJournal, '\nmalformed\n');
        const malformed = spawnSync('bash', [
          installed.fixedInstaller,
          'recover-journal',
        ], { encoding: 'utf8', env: installed.brokerEnv });
        expect(malformed.status).not.toBe(0);
        fs.writeFileSync(retirementJournal, original, { mode: 0o600 });
      }
      const recovered = spawnSync('bash', [
        installed.fixedInstaller,
        'recover-journal',
      ], { encoding: 'utf8', env: installed.brokerEnv });
      expect(
        recovered.status,
        `${checkpoint}\n${recovered.stdout}\n${recovered.stderr}`,
      ).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        ok: true,
        installed: false,
        promotable: false,
        status: 'retired_for_layout',
      });
      const retirementReceipt = path.join(
        installed.installState,
        'retirement-receipt.v1.json',
      );
      expect(JSON.parse(fs.readFileSync(
        retirementReceipt,
        'utf8',
      ))).toMatchObject({
        schema: 'nexus.rollback-drill-v4-prelayout-staging-retirement.v1',
        status: 'retired',
        successful: { count: 1 },
        retiredAssets: {
          promotionRecoveryDropIn: {
            sha256: sha256(fs.readFileSync(v4PromotionRecoveryDropIn)),
          },
        },
      });
      expect(fs.existsSync(path.join(
        installed.installState,
        'install-receipt.v1.json',
      ))).toBe(false);
      if (index === 0) {
        const retained = `${retirementReceipt}.retained`;
        fs.renameSync(retirementReceipt, retained);
        fs.symlinkSync(retained, retirementReceipt);
        const symlinked = spawnSync('bash', [
          installed.fixedInstaller,
          'recover-journal',
        ], { encoding: 'utf8', env: installed.brokerEnv });
        expect(symlinked.status).not.toBe(0);
      }
    }
  }, 180_000);

  it('retains the install journal when trap recovery cannot prove systemd restoration', () => {
    for (const recoveryFailure of [
      'daemon_reload',
      'unit_state_restoration',
    ]) {
      const state = fixture();
      const bootstrap = installerBootstrap(
        state,
        `recovery-failure-${recoveryFailure}`,
      );
      const targetRoot = path.join(
        state.root,
        `recovery-failure-target-${recoveryFailure}`,
      );
      const installState = path.join(
        state.root,
        `recovery-failure-state-${recoveryFailure}`,
      );
      const promotionState = path.join(
        state.root,
        `recovery-failure-promotion-${recoveryFailure}`,
      );
      fs.mkdirSync(targetRoot, { mode: 0o700 });
      fs.mkdirSync(promotionState, { mode: 0o700 });
      fs.writeFileSync(path.join(promotionState, '.control.lock'), '', {
        mode: 0o600,
      });
      const sonarLock = path.join(
        state.root,
        `recovery-failure-sonar-${recoveryFailure}.lock`,
      );
      fs.writeFileSync(sonarLock, '', { mode: 0o600 });
      const control = executable(
        state.root,
        `recovery-failure-control-${recoveryFailure}`,
        `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v2 ;;
  assert-idle) exit 0 ;;
  *) exit 64 ;;
esac
`,
      );
      fs.chmodSync(control, 0o700);
      const sqliteTarget = path.join(
        targetRoot,
        'usr/local/libexec/nexus-application-dr/application-dr-sqlite.py',
      );
      fs.mkdirSync(path.dirname(sqliteTarget), {
        recursive: true,
        mode: 0o755,
      });
      fs.copyFileSync(sqliteToolSource, sqliteTarget);
      fs.chmodSync(sqliteTarget, 0o644);
      const sourceInstaller = path.join(
        bootstrap.sourceRoot,
        'scripts',
        'remote-rollback-drill-legacy-staging-install.sh',
      );
      const env = {
        ...process.env,
        NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE: '1',
        NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: targetRoot,
        NEXUS_LEGACY_DRILL_STATE_ROOT: installState,
        NEXUS_LEGACY_DRILL_BOOTSTRAP_BASE: bootstrap.bootstrapBase,
        NEXUS_PROMOTION_STATE_ROOT: promotionState,
        NEXUS_LEGACY_DRILL_SONAR_LOCK: sonarLock,
        NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
        NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
          sha256(fs.readFileSync(control)),
        NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:
          sha256(fs.readFileSync(sqliteTarget)),
        NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
        NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN: '/usr/bin/true',
        NEXUS_LEGACY_DRILL_FLOCK_BIN: '/usr/bin/true',
        NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
        NEXUS_LEGACY_DRILL_TEST_INSTALL_FAIL_AFTER:
          'pm2_root_dropin_installed',
        NEXUS_LEGACY_DRILL_TEST_RECOVERY_FAIL_AT: recoveryFailure,
      };
      const failed = spawnSync('bash', [
        sourceInstaller,
        'install',
        bootstrap.sourceRoot,
        bootstrap.sourceSha,
        bootstrap.sourceArchive,
        bootstrap.archiveSha256,
      ], { encoding: 'utf8', env });
      expect(
        failed.status,
        `${recoveryFailure}\n${failed.stdout}\n${failed.stderr}`,
      ).toBe(91);
      expect(`${failed.stdout}${failed.stderr}`).toContain(
        `injected installer recovery failure: ${recoveryFailure}`,
      );
      expect(`${failed.stdout}${failed.stderr}`).toContain(
        'installer recovery failed; root journal retained',
      );
      const journal = path.join(
        installState,
        'install',
        'install-in-progress.v1.json',
      );
      expect(fs.existsSync(journal)).toBe(true);
      expect(fs.existsSync(path.join(
        installState,
        'install-receipt.v1.json',
      ))).toBe(false);
    }
  }, 45_000);

  it('keeps PM2 blocked when the install recovery journal is malformed', () => {
    const state = fixture();
    const targetRoot = path.join(state.root, 'malformed-install-target');
    const installState = path.join(state.root, 'malformed-install-state');
    const installDirectory = path.join(installState, 'install');
    const promotionState = path.join(state.root, 'malformed-promotion-state');
    fs.mkdirSync(targetRoot, { mode: 0o700 });
    fs.mkdirSync(installDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(promotionState, { mode: 0o700 });
    fs.writeFileSync(path.join(promotionState, '.control.lock'), '');
    const sonarLock = path.join(state.root, 'malformed-sonar.lock');
    fs.writeFileSync(sonarLock, '');
    const control = executable(
      state.root,
      'malformed-control',
      '#!/bin/sh\nprintf "%s\\n" nexus-release-promotion-control.v2\n',
    );
    const journal = path.join(installDirectory, 'install-in-progress.v1.json');
    const env = {
      ...process.env,
      NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE: '1',
      NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: targetRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: installState,
      NEXUS_LEGACY_DRILL_BOOTSTRAP_BASE: path.join(state.root, 'missing-bootstrap'),
      NEXUS_PROMOTION_STATE_ROOT: promotionState,
      NEXUS_LEGACY_DRILL_SONAR_LOCK: sonarLock,
      NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
      NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:
        sha256(fs.readFileSync(control)),
      NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
      NEXUS_LEGACY_DRILL_FLOCK_BIN: '/usr/bin/true',
      NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
    };
    const validSource = `"sourceSha":"${'1'.repeat(40)}",`
      + `"archiveSha256":"${'2'.repeat(64)}"`;
    const malformed = [
      `{"schema":"nexus.rollback-drill-legacy-staging-install-journal.v1",`
      + '"phase":"prepared","promotionAllowed":false,'
      + `"source":{${validSource}},"preparedAt":"2026-07-25T00:00:00.000Z",`
      + '"unexpected":true}\n',
      `{"schema":"nexus.rollback-drill-legacy-staging-install-journal.v1",`
      + '"phase":"prepared","phase":"prepared","promotionAllowed":false,'
      + `"source":{${validSource}},"preparedAt":"2026-07-25T00:00:00.000Z"}\n`,
    ];
    for (const body of malformed) {
      fs.writeFileSync(journal, body, { mode: 0o600 });
      const blocked = spawnSync('bash', [installer, 'recover-journal'], {
        encoding: 'utf8',
        env,
      });
      expect(blocked.status).not.toBe(0);
      expect(`${blocked.stdout}${blocked.stderr}`).toContain(
        'install recovery journal',
      );
      expect(fs.existsSync(journal)).toBe(true);
    }
    fs.rmSync(journal);
    const symlinkTarget = path.join(state.root, 'malformed-journal-target');
    fs.writeFileSync(symlinkTarget, malformed[0], { mode: 0o600 });
    fs.symlinkSync(symlinkTarget, journal);
    const symlinkBlocked = spawnSync('bash', [
      installer,
      'recover-journal',
    ], { encoding: 'utf8', env });
    expect(symlinkBlocked.status).not.toBe(0);
    expect(fs.lstatSync(journal).isSymbolicLink()).toBe(true);
  });

  it('restores the active adapter after an interrupted transactional uninstall', () => {
    const state = fixture();
    const targetRoot = path.join(state.root, 'install-target');
    const installState = path.join(state.root, 'install-state');
    const promotionState = path.join(state.root, 'install-promotion-state');
    fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(
      path.join(installState, 'install', 'predecessor'),
      { recursive: true, mode: 0o700 },
    );
    fs.mkdirSync(promotionState, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(promotionState, '.control.lock'), '');
    const sonarLock = path.join(state.root, 'install-sonar.lock');
    fs.writeFileSync(sonarLock, '');
    const control = executable(state.root, 'install-control', `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v2 ;;
  assert-idle) exit 0 ;;
  *) exit 64 ;;
esac
`);
    fs.chmodSync(control, 0o700);
    const flock = executable(
      state.root,
      'install-flock',
      '#!/bin/sh\nexit 0\n',
    );
    const activeFiles = [
      ['/usr/local/sbin/nexus-rollback-drill-legacy-staging-install', 'installer'],
      ['/etc/systemd/system/nexus-rollback-drill-legacy-staging-install-recovery.service', 'installRecoveryUnit'],
      ['/usr/local/sbin/nexus-rollback-drill-legacy-staging-broker', 'broker'],
      ['/usr/local/libexec/nexus-rollback-drill-legacy-staging-adapter.mjs', 'adapter'],
      ['/usr/local/libexec/nexus-release-runtime-dependencies.mjs', 'dependencies'],
      ['/usr/local/libexec/nexus-release-installed-tree-attestation.mjs', 'installedAttestor'],
      ['/usr/local/libexec/nexus-release-recovery-runtime-identity.mjs', 'recoveryAttestor'],
      ['/etc/nexus-release/release-evidence-public-key.pem', 'releasePublicKey'],
      ['/etc/systemd/system/nexus-rollback-drill-legacy-staging@.service', 'transactionUnit'],
      ['/etc/systemd/system/nexus-rollback-drill-legacy-staging-recovery.service', 'recoveryUnit'],
      ['/etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf', 'pm2DominguezDropIn'],
      ['/etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf', 'pm2RootDropIn'],
      ['/etc/sudoers.d/nexus-rollback-drill-legacy-staging', 'sudoers'],
      ['/usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py', 'filesystemHelper'],
    ] as const;
    const installed: Record<string, string> = {};
    const activeDigests = new Map<string, string>();
    for (const [relative, receiptName] of activeFiles) {
      const output = `${targetRoot}${relative}`;
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
      const body = receiptName === 'broker'
        ? '#!/bin/sh\n[ "$1" = assert-terminal-retirement-ready ]\n'
        : `${receiptName} active adapter\n`;
      const mode = receiptName === 'installer'
          || receiptName === 'broker'
          || receiptName === 'adapter'
          || receiptName === 'dependencies'
          || receiptName === 'installedAttestor'
          || receiptName === 'recoveryAttestor'
          || receiptName === 'filesystemHelper'
        ? 0o700
        : receiptName === 'sudoers'
          ? 0o440
          : 0o644;
      fs.writeFileSync(output, body, {
        mode,
      });
      fs.chmodSync(output, mode);
      const digest = sha256(fs.readFileSync(output));
      installed[receiptName] = digest;
      activeDigests.set(output, digest);
    }
    const sqliteTarget =
      `${targetRoot}/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py`;
    fs.mkdirSync(path.dirname(sqliteTarget), { recursive: true, mode: 0o755 });
    fs.writeFileSync(sqliteTarget, 'sqlite helper retained\n', { mode: 0o644 });
    installed.sqliteTool = sha256(fs.readFileSync(sqliteTarget));

    const predecessor = path.join(installState, 'install', 'predecessor');
    for (let index = 0; index < activeFiles.length; index += 1) {
      for (const [suffix, value] of [
        ['existed', '0\n'],
        ['mode', '600\n'],
        ['uid', `${process.getuid!()}\n`],
        ['gid', `${process.getgid!()}\n`],
      ]) {
        fs.writeFileSync(path.join(predecessor, `${index}.${suffix}`), value, {
          mode: 0o600,
        });
      }
    }
    for (let index = 0; index < 2; index += 1) {
      for (const [suffix, value] of [
        ['existed', '0\n'],
        ['mode', '755\n'],
        ['uid', `${process.getuid!()}\n`],
        ['gid', `${process.getgid!()}\n`],
      ]) {
        fs.writeFileSync(
          path.join(predecessor, `parent.${index}.${suffix}`),
          value,
          { mode: 0o600 },
        );
      }
    }
    fs.writeFileSync(
      path.join(predecessor, 'recovery.enabled'),
      'disabled\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(predecessor, 'install-recovery.enabled'),
      'disabled\n',
      { mode: 0o600 },
    );
    const releaseBase =
      `${targetRoot}/home/dominguez/telegram-hub-bot-staging`;
    fs.mkdirSync(path.join(releaseBase, 'releases'), {
      recursive: true,
      mode: 0o755,
    });
    fs.chmodSync(releaseBase, 0o755);
    const expectedControlSha = sha256(fs.readFileSync(control));
    const receipt = path.join(installState, 'install-receipt.v1.json');
    fs.writeFileSync(receipt, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-install-receipt.v1',
      status: 'active',
      promotionAllowed: false,
      source: {
        sourceSha: '1'.repeat(40),
        archiveSha256: '2'.repeat(64),
      },
      control: {
        version: 'nexus-release-promotion-control.v2',
        sha256: expectedControlSha,
      },
      installed,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    const installEnv = {
      ...process.env,
      NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE: '1',
      NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT: targetRoot,
      NEXUS_LEGACY_DRILL_STATE_ROOT: installState,
      NEXUS_PROMOTION_STATE_ROOT: promotionState,
      NEXUS_LEGACY_DRILL_SONAR_LOCK: sonarLock,
      NEXUS_LEGACY_DRILL_CONTROL_BIN: control,
      NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256: expectedControlSha,
      NEXUS_LEGACY_DRILL_NODE_BIN: process.execPath,
      NEXUS_LEGACY_DRILL_FLOCK_BIN: flock,
      NEXUS_LEGACY_DRILL_WORKER_USER: os.userInfo().username,
      NEXUS_LEGACY_DRILL_TEST_UNINSTALL_FAIL_AFTER_TARGET: '6',
    };
    const planRaw = execFileSync('bash', [
      installer,
      'phase-a-retirement-plan',
    ], {
      encoding: 'utf8',
      env: installEnv,
    });
    const plan = JSON.parse(planRaw);
    expect(planRaw).toBe(`${canonicalJson(plan)}\n`);
    expect(plan).toMatchObject({
      schema:
        'nexus.rollback-drill-legacy-staging-phase-a-retirement-plan.v1',
      status: 'ready',
      promotionAllowed: false,
      receipt: {
        path: receipt,
        sha256: sha256(fs.readFileSync(receipt)),
      },
      source: {
        sourceSha: '1'.repeat(40),
        archiveSha256: '2'.repeat(64),
      },
      control: {
        version: 'nexus-release-promotion-control.v2',
        sha256: expectedControlSha,
      },
      terminal: {
        count: 0,
        aggregateSha256: sha256(Buffer.from(canonicalJson([]))),
      },
      retainedDependencies: [{
        path: sqliteTarget,
        sha256: installed.sqliteTool,
        mode: 0o644,
        uid: fs.statSync(sqliteTarget).uid,
        gid: fs.statSync(sqliteTarget).gid,
      }],
    });
    expect(plan.targets.map((entry: any) => entry.path))
      .toEqual(activeFiles.map(([relative]) => `${targetRoot}${relative}`));
    expect(plan.targets.every((entry: any) => (
      entry.predecessor.action === 'remove'
      && entry.active.sha256 === activeDigests.get(entry.path)
    ))).toBe(true);

    const tamperedTarget = `${targetRoot}${activeFiles[3][0]}`;
    fs.appendFileSync(tamperedTarget, 'tampered\n');
    const tamperedPlan = spawnSync('bash', [
      installer,
      'phase-a-retirement-plan',
    ], {
      encoding: 'utf8',
      env: installEnv,
    });
    expect(tamperedPlan.status).not.toBe(0);
    fs.writeFileSync(tamperedTarget, 'adapter active adapter\n', {
      mode: 0o700,
    });

    const unfinishedDirectory = path.join(
      installState,
      'transactions',
      requestId,
    );
    fs.mkdirSync(unfinishedDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(unfinishedDirectory, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      requestId,
      phase: 'selector_switched',
    })}\n`, { mode: 0o600 });
    const unfinishedPlan = spawnSync('bash', [
      installer,
      'phase-a-retirement-plan',
    ], {
      encoding: 'utf8',
      env: installEnv,
    });
    expect(unfinishedPlan.status).not.toBe(0);
    fs.writeFileSync(path.join(unfinishedDirectory, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      requestId,
      phase: 'recovered',
    })}\n`, { mode: 0o600 });
    expect(JSON.parse(execFileSync('bash', [
      installer,
      'phase-a-retirement-plan',
    ], {
      encoding: 'utf8',
      env: installEnv,
    }))).toMatchObject({
      terminal: { count: 1 },
    });

    fs.writeFileSync(control, `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v4 ;;
  assert-idle|assert-layout-ready) exit 0 ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
    fs.chmodSync(control, 0o700);
    const interrupted = spawnSync('bash', [installer, 'uninstall'], {
      encoding: 'utf8',
      env: installEnv,
    });
    expect(interrupted.status, `${interrupted.stdout}\n${interrupted.stderr}`)
      .not.toBe(0);
    for (const [file, digest] of activeDigests) {
      expect(sha256(fs.readFileSync(file))).toBe(digest);
    }
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({
      status: 'active',
      installed,
    });
    expect(fs.existsSync(path.join(
      installState,
      'install',
      'uninstall-in-progress.v1.json',
    ))).toBe(false);

    const uninstallJournal = path.join(
      installState,
      'install',
      'uninstall-in-progress.v1.json',
    );
    const powerLoss = spawnSync('bash', [installer, 'uninstall'], {
      encoding: 'utf8',
      env: {
        ...installEnv,
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_FAIL_AFTER_TARGET: '',
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_POWER_LOSS_AFTER_TARGET: '13',
      },
    });
    expect(powerLoss.status, `${powerLoss.stdout}\n${powerLoss.stderr}`)
      .toBe(198);
    const activeBackups = path.join(
      installState,
      'install',
      'active-adapter',
    );
    const boundJournal = JSON.parse(fs.readFileSync(uninstallJournal, 'utf8'));
    expect(boundJournal).toMatchObject({
      schema: 'nexus.rollback-drill-legacy-staging-uninstall-journal.v1',
      phase: 'prepared',
      activeAdapterInventory: {
        schema:
          'nexus.rollback-drill-legacy-staging-uninstall-backup-inventory.v1',
      },
      installPredecessorInventory: {
        schema:
          'nexus.rollback-drill-legacy-staging-install-backup-inventory.v1',
      },
    });
    const activeMode = path.join(activeBackups, '0.mode');
    const originalActiveMode = fs.readFileSync(activeMode);
    fs.appendFileSync(activeMode, 'tampered\n');
    const tamperedRecovery = spawnSync('bash', [installer, 'uninstall'], {
      encoding: 'utf8',
      env: {
        ...installEnv,
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_FAIL_AFTER_TARGET: '',
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_POWER_LOSS_AFTER_TARGET: '',
      },
    });
    expect(tamperedRecovery.status).not.toBe(0);
    expect(`${tamperedRecovery.stdout}${tamperedRecovery.stderr}`)
      .toContain('uninstall backup inventory');
    expect(fs.existsSync(uninstallJournal)).toBe(true);
    fs.writeFileSync(activeMode, originalActiveMode, { mode: 0o600 });
    const crashRecovery = spawnSync('bash', [installer, 'uninstall'], {
      encoding: 'utf8',
      env: {
        ...installEnv,
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_FAIL_AFTER_TARGET: '',
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_POWER_LOSS_AFTER_TARGET: '',
      },
    });
    expect(crashRecovery.status, `${crashRecovery.stdout}\n${crashRecovery.stderr}`)
      .toBe(75);
    expect(JSON.parse(crashRecovery.stdout)).toMatchObject({
      ok: true,
      installed: true,
      status: 'recovered_interrupted_uninstall',
    });
    for (const [file, digest] of activeDigests) {
      expect(sha256(fs.readFileSync(file))).toBe(digest);
    }
    expect(fs.existsSync(uninstallJournal)).toBe(false);

    const completed = JSON.parse(execFileSync('bash', [
      installer,
      'uninstall',
    ], {
      encoding: 'utf8',
      env: {
        ...installEnv,
        NEXUS_LEGACY_DRILL_TEST_UNINSTALL_FAIL_AFTER_TARGET: '',
      },
    }));
    expect(completed).toMatchObject({
      ok: true,
      installed: false,
      status: 'retired_to_verified_control_v3',
    });
    for (const file of activeDigests.keys()) {
      expect(fs.existsSync(file)).toBe(false);
    }
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.existsSync(sqliteTarget)).toBe(true);
  }, 45_000);

  it('journals the predecessor before mutation and excludes privileged recovery from sudoers', () => {
    const brokerBody = fs.readFileSync(broker, 'utf8');
    const installerBody = fs.readFileSync(installer, 'utf8');
    const operatorBody = fs.readFileSync(releaseOperator, 'utf8');
    const transactionBody = brokerBody.slice(
      brokerBody.indexOf('run_transaction()'),
      brokerBody.indexOf('recover_all()'),
    );
    expect(transactionBody.indexOf('atomic_json_phase "$journal" prepared'))
      .toBeLessThan(transactionBody.indexOf('delete_staging_apps'));
    const stopIndex = transactionBody.indexOf('delete_staging_apps');
    const snapshotIndex = transactionBody.indexOf('snapshot-database');
    const snapshotJournalIndex = transactionBody.indexOf(
      'atomic_json_phase "$journal" outage_armed "$details"',
      snapshotIndex,
    );
    const switchIndex = transactionBody.indexOf('atomic_selector_switch');
    expect(stopIndex).toBeLessThan(snapshotIndex);
    expect(snapshotIndex).toBeLessThan(snapshotJournalIndex);
    expect(snapshotJournalIndex).toBeLessThan(switchIndex);
    expect(brokerBody).toContain('recoveryTargetSeconds:120');
    expect(brokerBody).toContain('NEXUS_LEGACY_DRILL_TEST_FAIL_PHASE');
    expect(installerBody).toContain('Git PAX commit does not match');
    expect(installerBody).toContain('promotionAllowed:false');
    expect(installerBody).toContain('scripts/application-dr-sqlite.py');
    expect(installerBody).toContain('sqliteTool:digest(sqliteTool)');
    expect(installerBody).toContain('fs.constants.O_NOFOLLOW');
    expect(installerBody).toContain('fs.fstatSync(descriptor)');
    const installRollbackBody = installerBody.slice(
      installerBody.indexOf('rollback_install()'),
      installerBody.indexOf('secure_release_parents()'),
    );
    const rollbackLoopIndex = installRollbackBody.indexOf(
      'for ((index=${#TARGETS[@]}-1; index>=0; index-=1)); do',
    );
    const pm2RootTargetIndex = installerBody.indexOf(
      '"$PM2_ROOT_DROP_IN_TARGET"',
      installerBody.indexOf('TARGETS=('),
    );
    const recoveryUnitTargetIndex = installerBody.indexOf(
      '"$RECOVERY_UNIT_TARGET"',
      installerBody.indexOf('TARGETS=('),
    );
    const installRecoveryUnitTargetIndex = installerBody.indexOf(
      '"$INSTALL_RECOVERY_UNIT_TARGET"',
      installerBody.indexOf('TARGETS=('),
    );
    expect(pm2RootTargetIndex).toBeGreaterThan(-1);
    expect(pm2RootTargetIndex).toBeGreaterThan(recoveryUnitTargetIndex);
    expect(recoveryUnitTargetIndex).toBeGreaterThan(
      installRecoveryUnitTargetIndex,
    );
    expect(rollbackLoopIndex).toBeGreaterThan(-1);
    expect(installRollbackBody).toContain(
      'disable_recovery_unit_if_present \\\n'
      + '            "$RECOVERY_UNIT_NAME" \\\n'
      + '            "$RECOVERY_UNIT_TARGET"',
    );
    expect(installRollbackBody).toContain(
      'disable_recovery_unit_if_present \\\n'
      + '            "$INSTALL_RECOVERY_UNIT_NAME" \\\n'
      + '            "$INSTALL_RECOVERY_UNIT_TARGET"',
    );
    expect(installRollbackBody.indexOf('disable_recovery_unit_if_present'))
      .toBeGreaterThan(rollbackLoopIndex);
    expect(installRollbackBody).toContain(
      'restore_recovery_unit_state \\\n'
      + '      "$RECOVERY_UNIT_NAME" \\\n'
      + '      "$RECOVERY_UNIT_TARGET" "$enabled_state"',
    );
    expect(installRollbackBody).not.toContain('2>&1 || true');
    expect(installerBody).toContain(
      'e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d',
    );
    const restoreBody = brokerBody.slice(
      brokerBody.indexOf('restore_transaction()'),
      brokerBody.indexOf('rollback_on_failure()'),
    );
    expect(restoreBody.indexOf('delete_staging_apps'))
      .toBeLessThan(restoreBody.indexOf('restore-database'));
    expect(restoreBody.indexOf('restore-database'))
      .toBeLessThan(restoreBody.indexOf('atomic_selector_switch'));
    expect(restoreBody.indexOf('atomic_selector_switch'))
      .toBeLessThan(restoreBody.indexOf('"$PM2_BIN" start'));
    const sudoersStart = installerBody.indexOf("cat >>\"$SUDOERS_SOURCE\"");
    const sudoersBlock = installerBody.slice(
      sudoersStart,
      installerBody.indexOf('\nEOF', sudoersStart) + 4,
    );
    expect(sudoersBlock).toContain('$BROKER_NAME prepare *');
    expect(sudoersBlock).toContain('$BROKER_NAME launch *');
    expect(sudoersBlock).toContain('NOPASSWD: NOSETENV:');
    expect(sudoersBlock).not.toContain('$BROKER_NAME run');
    expect(sudoersBlock).not.toContain('$BROKER_NAME recover-all');
    expect(operatorBody).not.toContain('exit 78');
    expect(operatorBody).toContain('execution_and_protected_drill_signature_required');
    expect(operatorBody).not.toContain(
      'MANIFEST_SIGNING_RUN_ID="$(manifest_field payload.ci.runId)"',
    );
    expect(operatorBody).toContain(
      'release-signing-provenance-receipt.mjs verify',
    );
    expect(operatorBody).toContain(
      'actions/runs/$MANIFEST_SIGNING_RUN_ID/artifacts?per_page=100',
    );
    expect(operatorBody).toContain(
      'live manifest-signing provenance differs from the SHA-scoped receipt',
    );
    const readinessIndex = transactionBody.indexOf(
      'remote-release-readiness.sh',
    );
    const readinessFailureIndex = transactionBody.indexOf(
      'test_fail_phase after_readiness',
    );
    const completedIndex = transactionBody.indexOf(
      'publish_evidence "$request_id"',
    );
    expect(readinessIndex).toBeGreaterThan(-1);
    expect(readinessIndex).toBeLessThan(readinessFailureIndex);
    expect(readinessFailureIndex).toBeLessThan(completedIndex);
    const legacyOperator = operatorBody.slice(
      operatorBody.indexOf('drill-staging)'),
      operatorBody.indexOf('\n  status)', operatorBody.indexOf('drill-staging)')),
    );
    expect(legacyOperator).not.toContain('scripts/staging-smoke.sh');
    expect(legacyOperator).not.toContain('--smoke-log');
  });

  it('queries the exact broker request before any resumable drill mutation', () => {
    const operatorBody = fs.readFileSync(releaseOperator, 'utf8');
    const legacyOperator = operatorBody.slice(
      operatorBody.indexOf('drill-staging)'),
      operatorBody.indexOf('\n  status)', operatorBody.indexOf('drill-staging)')),
    );
    const checkpointIndex = legacyOperator.indexOf(
      'ensure-operator-checkpoint',
    );
    const initialStatusIndex = legacyOperator.indexOf(
      'status "$STAGING_REQUEST_ID"',
    );
    const inspectIndex = legacyOperator.indexOf(
      'sudo -n "$BROKER" inspect',
    );
    const prepareIndex = legacyOperator.indexOf(
      'sudo -n "$BROKER" prepare',
    );
    expect(checkpointIndex).toBeGreaterThan(-1);
    expect(checkpointIndex).toBeLessThan(initialStatusIndex);
    expect(initialStatusIndex).toBeLessThan(inspectIndex);
    expect(initialStatusIndex).toBeLessThan(prepareIndex);
    expect(legacyOperator).toContain(
      '[ "$DRILL_CHECKPOINT_RESUMED" = true ]',
    );
    expect(legacyOperator).toContain('--allow-expired-resume true');
    expect(legacyOperator).toContain('cmp -s -- "$temporary" "$destination"');
    expect(legacyOperator).toContain(
      'terminal broker evidence differs from the exact request checkpoint',
    );
    expect(legacyOperator).toContain(
      'validate-staging-request',
    );
    expect(legacyOperator).toContain(
      'signed drill bundle differs from exact local request sources',
    );
    expect(legacyOperator).not.toContain(
      'drill-staging evidence output already exists',
    );
    const brokerBody = fs.readFileSync(broker, 'utf8');
    const statusBody = brokerBody.slice(
      brokerBody.indexOf('  status)'),
      brokerBody.indexOf('  fetch-evidence)'),
    );
    expect(statusBody).toContain('runtimeSha:x.runtimeSha');
    expect(statusBody).toContain('artifactDigest:x.artifactDigest');
  });

  it('fails the boot guard while recovery is unfinished and permits retirement only when terminal', () => {
    const state = fixture();
    const env = brokerEnvironment(state);
    const transactionDirectory = path.join(
      state.transactionRoot,
      requestId,
    );
    fs.mkdirSync(transactionDirectory, { mode: 0o700 });
    const journal = path.join(transactionDirectory, 'journal.json');
    fs.writeFileSync(journal, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      requestId,
      phase: 'selector_switched',
    })}\n`, { mode: 0o600 });
    const blocked = spawnSync('bash', [broker, 'assert-boot-safe'], {
      encoding: 'utf8',
      env,
    });
    expect(blocked.status).not.toBe(0);
    const retirementBlocked = spawnSync(
      'bash',
      [broker, 'assert-terminal-retirement-ready'],
      { encoding: 'utf8', env },
    );
    expect(retirementBlocked.status).not.toBe(0);
    fs.writeFileSync(journal, `${JSON.stringify({
      schema: 'nexus.rollback-drill-legacy-staging-journal.v1',
      requestId,
      phase: 'recovered',
    })}\n`, { mode: 0o600 });
    expect(JSON.parse(execFileSync('bash', [
      broker,
      'assert-boot-safe',
    ], { encoding: 'utf8', env }))).toMatchObject({
      ok: true,
      status: 'boot_safe',
    });
    const missingSuccessor = spawnSync('bash', [
      broker,
      'assert-terminal-retirement-ready',
    ], { encoding: 'utf8', env });
    expect(missingSuccessor.status).not.toBe(0);
    const control = env.NEXUS_LEGACY_DRILL_CONTROL_BIN!;
    fs.writeFileSync(control, `#!/bin/sh
case "$1" in
  version) printf '%s\\n' nexus-release-promotion-control.v4 ;;
  assert-idle|assert-layout-ready) exit 0 ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
    fs.chmodSync(control, 0o755);
    expect(JSON.parse(execFileSync('bash', [
      broker,
      'assert-terminal-retirement-ready',
    ], { encoding: 'utf8', env }))).toMatchObject({
      ok: true,
      status: 'terminal_retirement_ready',
      successor: {
        version: 'nexus-release-promotion-control.v4',
        sha256: sha256(fs.readFileSync(control)),
        layoutEvidenceVerified: true,
      },
    });
  });

  it('runs install and transaction recovery as root before either PM2 service', () => {
    const transaction = fs.readFileSync(transactionUnit, 'utf8');
    const recovery = fs.readFileSync(recoveryUnit, 'utf8');
    const installRecovery = fs.readFileSync(installRecoveryUnit, 'utf8');
    const dropIn = fs.readFileSync(pm2RecoveryDropIn, 'utf8');
    const installerBody = fs.readFileSync(installer, 'utf8');
    expect(transaction).toContain('Type=oneshot');
    expect(transaction).toContain('Restart=on-failure');
    expect(transaction).toContain('TimeoutStopSec=125s');
    expect(transaction).not.toContain('Requires=nexus-rollback-drill');
    expect(installRecovery).toContain('User=root');
    expect(installRecovery).toContain('Group=root');
    expect(installRecovery).toContain(
      'ExecStart=/usr/local/sbin/nexus-rollback-drill-legacy-staging-install '
      + 'recover-journal',
    );
    expect(installRecovery).not.toContain('ConditionPathExists=');
    expect(installRecovery).toContain(
      'Before=nexus-rollback-drill-legacy-staging-recovery.service '
      + 'nexus-release-layout-install-recovery.service '
      + 'pm2-dominguez.service pm2-root.service',
    );
    expect(installRecovery)
      .toContain('RequiredBy=pm2-dominguez.service pm2-root.service');
    expect(recovery).toContain(
      'Requires=nexus-rollback-drill-legacy-staging-install-recovery.service',
    );
    expect(recovery).toContain(
      'After=local-fs.target '
      + 'nexus-rollback-drill-legacy-staging-install-recovery.service',
    );
    expect(recovery).toContain('User=root');
    expect(recovery).toContain('Before=pm2-dominguez.service pm2-root.service');
    expect(recovery).toContain('ExecStart=/usr/local/sbin/nexus-rollback-drill-legacy-staging-broker recover-all');
    expect(recovery).toContain('WantedBy=multi-user.target');
    expect(recovery)
      .toContain('RequiredBy=pm2-dominguez.service pm2-root.service');
    expect(dropIn).toContain(
      'Requires=nexus-rollback-drill-legacy-staging-install-recovery.service '
      + 'nexus-rollback-drill-legacy-staging-recovery.service',
    );
    expect(dropIn).toContain(
      'After=nexus-rollback-drill-legacy-staging-install-recovery.service '
      + 'nexus-rollback-drill-legacy-staging-recovery.service',
    );
    expect(dropIn).toContain(
      'ExecStartPre=+/usr/local/sbin/'
      + 'nexus-rollback-drill-legacy-staging-broker assert-boot-safe',
    );
    expect(installerBody).toContain(
      'atomic_install "$PM2_DROP_IN_SOURCE" '
      + '"$PM2_DOMINGUEZ_DROP_IN_TARGET" 644',
    );
    expect(installerBody).toContain(
      'atomic_install "$PM2_DROP_IN_SOURCE" "$PM2_ROOT_DROP_IN_TARGET" 644',
    );
    const installCase = installerBody.slice(
      installerBody.lastIndexOf('  install)'),
    );
    const journalIndex = installCase.indexOf('begin_install_journal');
    const anchorIndex = installCase.indexOf(
      'atomic_install "$INSTALLER_SOURCE" "$INSTALLER_TARGET" 700',
    );
    const anchorVerifiedIndex = installCase.indexOf(
      'verify_install_recovery_anchor',
    );
    const pm2DominguezIndex = installCase.indexOf(
      '"$PM2_DOMINGUEZ_DROP_IN_TARGET" 644',
    );
    const pm2RootIndex = installCase.indexOf('"$PM2_ROOT_DROP_IN_TARGET" 644');
    const receiptIndex = installCase.indexOf('atomic_json_receipt');
    const journalRemovalIndex = installCase.indexOf('rm -f -- "$JOURNAL"');
    expect(journalIndex).toBeLessThan(anchorIndex);
    expect(anchorIndex).toBeLessThan(anchorVerifiedIndex);
    expect(anchorVerifiedIndex).toBeLessThan(pm2DominguezIndex);
    expect(pm2DominguezIndex).toBeLessThan(pm2RootIndex);
    expect(pm2RootIndex).toBeLessThan(receiptIndex);
    expect(receiptIndex).toBeLessThan(journalRemovalIndex);
    expect(installCase).toContain(
      'test_power_loss pm2_dominguez_dropin_installed',
    );
    expect(installCase).toContain(
      'test_power_loss pm2_root_dropin_installed',
    );
    expect(fs.readFileSync(broker, 'utf8')).toContain(
      'test mode may not cross a privileged uid boundary',
    );
  });
});
