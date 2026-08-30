import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../scripts/lib/release-canonical.mjs';
import {
  DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  PM2_FALLBACK_PRESERVED_PATHS,
  PM2_FALLBACK_STABLE_SECONDS,
  Pm2FallbackRetirementRefusal,
  acquirePm2FallbackRetirementLocks,
  assertRemainingPlannedSystemdArtifacts,
  createLinuxPm2FallbackRetirementMutator,
  detachPm2ClosureAtomically,
  evaluatePm2FallbackRetirementAdmission,
  inspectLegacyDatabaseQuiescence,
  inspectPm2ClosureForRetirement,
  inspectTerminalRebaselineEvidenceForRetirement,
  purgeDetachedPm2Closure,
  readPm2FallbackRetirementStatus,
  runPm2FallbackRetirementTransaction,
} from '../../scripts/lib/pm2-fallback-retirement.mjs';

const ANCHOR_ID = '1'.repeat(32);
const ACTIVE_ID = '2'.repeat(32);
const ANCHOR_SHA = 'a'.repeat(40);
const ACTIVE_SHA = 'b'.repeat(40);
const LEGACY_PRODUCTION_SHA = 'c'.repeat(40);
const LEGACY_STAGING_SHA = 'd'.repeat(40);
const BASELINE_SHA = '3'.repeat(64);
const ANCHOR_RECEIPT_SHA = '4'.repeat(64);
const ACTIVE_RECEIPT_SHA = '5'.repeat(64);
const ANCHOR_COMPLETED_AT = '2026-08-01T00:00:00.000Z';
const ELIGIBLE_AT = Date.parse(ANCHOR_COMPLETED_AT)
  + PM2_FALLBACK_STABLE_SECONDS * 1000;
const PAYLOAD_DIGEST = `sha256:${'6'.repeat(64)}`;
const MANIFEST_DIGEST = '7'.repeat(64);
const LAUNCHER_SHA = '8'.repeat(64);
const PACKAGE_LOCK_SHA = '9'.repeat(64);
const FAKE_CLOSURE_BYTES = Buffer.from('pm2\n');
const FAKE_CLOSURE_FILE = {
  path: 'pm2.js',
  size: FAKE_CLOSURE_BYTES.length,
  mode: 0o644,
  sha256: sha256(FAKE_CLOSURE_BYTES),
};
const FAKE_CLOSURE_ENTRIES = [{ ...FAKE_CLOSURE_FILE, kind: 'file' }];
const CLOSURE_SHA = sha256(canonicalJson({
  schema: 'nexus.pm2-root-closure.v1',
  files: [FAKE_CLOSURE_FILE],
}));
const ATTESTATION_SHA = 'b'.repeat(64);
const CONTROL_PLANE_DIGEST = 'c'.repeat(64);
const BASELINE = {
  target: {
    releaseId: ANCHOR_ID,
    sourceSha: ANCHOR_SHA,
    releasePayloadDigest: PAYLOAD_DIGEST,
    manifestDigest: MANIFEST_DIGEST,
  },
  legacyRuntime: {
    productionSourceSha: LEGACY_PRODUCTION_SHA,
    stagingSourceSha: LEGACY_STAGING_SHA,
  },
};
const BASELINE_AUTHORIZATION_DIGEST = sha256(canonicalJson(BASELINE));
const TERMINAL_REBASELINE = {
  path: `/var/lib/nexus-release/state/bootstrap-rebaseline-${ANCHOR_ID}.json`,
  sha256: 'a'.repeat(64),
  releaseId: ANCHOR_ID,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:05:00.000Z',
};

const temporaryRoots: string[] = [];
const ORIGINAL_BACKUP_LOCK_FD = process.env.NEXUS_RELEASE_BACKUP_LOCK_FD;

function check(name: string, detail: string) {
  return { name, result: 'passed', durationMs: 0, detail };
}

function receipt({
  releaseId,
  sourceSha,
  completedAt = ANCHOR_COMPLETED_AT,
  anchor = false,
}: {
  releaseId: string;
  sourceSha: string;
  completedAt?: string;
  anchor?: boolean;
}) {
  return {
    releaseId,
    sourceSha,
    completedAt,
    outcome: 'completed',
    identity: {
      releasePayloadDigest: PAYLOAD_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
    },
    controlPlane: {
      schema: 'nexus.release-control-plane.v1',
      digest: CONTROL_PLANE_DIGEST,
    },
    staging: {
      checks: anchor
        ? [check('owner_bootstrap_baseline', `sha256:${BASELINE_AUTHORIZATION_DIGEST}`)]
        : [],
    },
    production: {
      checks: anchor
        ? [check(
          'bootstrap_production_revalidation',
          `sha256:${BASELINE_AUTHORIZATION_DIGEST}`,
        )]
        : [],
    },
  };
}

function exactGuard(unit: string) {
  const guardPath = `/etc/systemd/system.control/${unit}`;
  return {
    unit,
    path: guardPath,
    owner: 'root:root',
    linkTarget: '/dev/null',
    loadState: 'masked',
    fragmentPath: guardPath,
    canStart: 'no',
    activeState: 'inactive',
    dropInPaths: '',
  };
}

function validInput() {
  const anchorReceipt = receipt({
    releaseId: ANCHOR_ID,
    sourceSha: ANCHOR_SHA,
    anchor: true,
  });
  const activeReceipt = receipt({
    releaseId: ACTIVE_ID,
    sourceSha: ACTIVE_SHA,
    completedAt: '2026-08-10T00:00:00.000Z',
  });
  return {
    policy: {},
    state: { blocked: null, active: { releaseId: ACTIVE_ID } },
    effective: { provable: true, status: 'completed', releaseId: ACTIVE_ID },
    baseline: {
      target: { ...BASELINE.target },
      legacyRuntime: { ...BASELINE.legacyRuntime },
    },
    baselineSha256: BASELINE_SHA,
    baselineAuthorizationDigest: BASELINE_AUTHORIZATION_DIGEST,
    anchorReceipt,
    anchorReceiptSha256: ANCHOR_RECEIPT_SHA,
    activeReceipt,
    activeReceiptSha256: ACTIVE_RECEIPT_SHA,
    now: ELIGIBLE_AT,
    host: {
      clockSynchronized: true,
      conflictingState: [],
      terminalRebaseline: null,
      controlPlane: {
        schema: 'nexus.release-control-plane.v1',
        digest: CONTROL_PLANE_DIGEST,
        sourceSha: ACTIVE_SHA,
        treeSha256: 'c'.repeat(64),
        transactionGatePresent: false,
      },
      guards: [
        exactGuard('pm2-dominguez.service'),
        exactGuard('nexus-release-pm2-recovery-daemon.service'),
      ],
      timers: [
        'nexus-release-poller.timer',
        'nexus-release-heartbeat.timer',
        'nexus-release-backup-liveness.timer',
        'nexus-local-backup.timer',
        'nexus-local-backup-restore-verify.timer',
      ].map((unit) => ({
        unit,
        loadState: 'loaded',
        activeState: 'active',
        unitFileState: 'enabled',
      })),
      services: [
        'nexus-release-poller.service',
        'nexus-local-backup.service',
        'nexus-local-backup-restore-verify.service',
      ].map((unit) => ({
        unit,
        activeState: 'inactive',
        result: 'success',
        execMainStatus: '0',
      })),
      backupLiveness: {
        schema: 'nexus.release-backup-liveness.v1',
        backup: {
          ageSeconds: 60,
          completedAt: '2026-08-14T23:59:00.000Z',
          encryptedSha256: 'd'.repeat(64),
        },
        restoreVerification: {
          ageSeconds: 3600,
          verifiedAt: '2026-08-14T23:00:00.000Z',
          encryptedSha256: 'e'.repeat(64),
        },
      },
      health: { production: true, staging: true, exactImages: true },
      pm2Quiescent: true,
      legacyDatabaseQuiescent: true,
      pm2Attestation: {
        schema: 'nexus.pm2-root-install.v1',
        version: '6.0.8',
        sourceArchiveSha256: 'd'.repeat(64),
        closureDigest: CLOSURE_SHA,
        payloadDigest: 'e'.repeat(64),
        packageLockSha256: PACKAGE_LOCK_SHA,
        fileCount: 10,
        closureRoot: '/opt/nexus-release/pm2/6.0.8',
        launcher: '/usr/local/bin/pm2',
        launcherSha256: LAUNCHER_SHA,
        entrypoint: '/opt/nexus-release/pm2/6.0.8/node_modules/pm2/bin/pm2',
        node: {
          path: '/usr/bin/node',
          version: 'v22.23.1',
          sha256: 'f'.repeat(64),
        },
        installedAt: '2026-07-31T00:00:00.000Z',
      },
      pm2AttestationSha256: ATTESTATION_SHA,
      pm2LauncherSha256: LAUNCHER_SHA,
      pm2LockSha256: PACKAGE_LOCK_SHA,
      pm2ClosureSha256: CLOSURE_SHA,
      pm2ClosureDevice: 42,
      systemdArtifacts: [],
      preservedPaths: [...PM2_FALLBACK_PRESERVED_PATHS],
    },
    validateBaseline: (value: unknown) => value,
    validateReceipt: (value: unknown) => value,
  };
}

function plan() {
  return evaluatePm2FallbackRetirementAdmission(validInput() as never);
}

function transactionPaths(root: string) {
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  return {
    ...DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
    journal: path.join(stateRoot, 'pm2-fallback-retirement.json'),
    tombstone: path.join(stateRoot, 'pm2-fallback-retired.json'),
    retirementRoot: path.join(root, 'retirements'),
    guardRoot: path.join(root, 'guards'),
  };
}

function terminalRebaselineFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-terminal-rebaseline-'));
  temporaryRoots.push(root);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const runtimeEvidence = path.join(stateDir, 'bootstrap-legacy-runtime.json');
  const transitionEvidence = path.join(stateDir, 'bootstrap-database-transition.json');
  const runtimeBytes = Buffer.from('{"schema":"runtime"}\n');
  const transitionBytes = Buffer.from('{"schema":"transition"}\n');
  fs.writeFileSync(runtimeEvidence, runtimeBytes, { mode: 0o600 });
  fs.writeFileSync(transitionEvidence, transitionBytes, { mode: 0o600 });
  const incidentDir = `/var/lib/nexus-release/incidents/bootstrap-rebaseline/${ANCHOR_ID}`;
  const logicalDigest = 'd'.repeat(64);
  const oldReleaseId = '0'.repeat(32);
  const record = {
    schema: 'nexus.bootstrap-rebaseline.v1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:05:00.000Z',
    phase: 'complete',
    incidentDir,
    expectedTarget: { releaseId: ANCHOR_ID, payloadDigest: PAYLOAD_DIGEST },
    oldBaseline: {
      sha256: '1'.repeat(64),
      releaseId: oldReleaseId,
      payloadDigest: `sha256:${'2'.repeat(64)}`,
      archivePath: `/var/lib/nexus-release/incidents/bootstrap-baselines/${ANCHOR_ID}-${oldReleaseId}.json`,
    },
    oldEvidence: {
      runtimeSha256: '3'.repeat(64),
      transitionSha256: '4'.repeat(64),
      recoveryStateSha256: '5'.repeat(64),
      runtimeArchivePath: path.join(incidentDir, 'bootstrap-legacy-runtime.before.json'),
      transitionArchivePath: path.join(
        incidentDir,
        'bootstrap-database-transition.before.json',
      ),
    },
    legacy: {
      production: {
        path: '/home/dominguez/telegram-hub-bot/data/bot.db',
        identity: '1:2',
        logicalDigest,
      },
      staging: {
        path: '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
        identity: '1:3',
        logicalDigest,
      },
    },
    runtime: {
      production: {
        path: `/home/dominguez/telegram-hub-bot/releases/${LEGACY_PRODUCTION_SHA}`,
        sourceSha: LEGACY_PRODUCTION_SHA,
        artifactDigest: '6'.repeat(64),
        markerSha256: '7'.repeat(64),
      },
      staging: {
        path: `/home/dominguez/telegram-hub-bot-staging/releases/${LEGACY_STAGING_SHA}`,
        sourceSha: LEGACY_STAGING_SHA,
        artifactDigest: '8'.repeat(64),
        markerSha256: '9'.repeat(64),
      },
    },
    targetArchives: {
      production: {
        path: path.join(incidentDir, 'production-data.before'),
        treeSha256: 'a'.repeat(64),
      },
      staging: {
        path: path.join(incidentDir, 'staging-data.before'),
        treeSha256: 'b'.repeat(64),
      },
    },
    target: {
      production: {
        path: '/var/lib/nexus-hub/production/data/bot.db',
        identity: '2:3',
        logicalDigest,
      },
      staging: {
        path: '/var/lib/nexus-hub/staging/data/bot.db',
        identity: '2:4',
        logicalDigest,
      },
    },
    newEvidence: {
      runtimeSha256: sha256(runtimeBytes),
      transitionSha256: sha256(transitionBytes),
    },
    candidateBaselineSha256: BASELINE_SHA,
  };
  const file = path.join(stateDir, `bootstrap-rebaseline-${ANCHOR_ID}.json`);
  const writeRecord = () => fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  writeRecord();
  return {
    file,
    record,
    runtimeEvidence,
    transitionEvidence,
    writeRecord,
    options: {
      baseline: BASELINE,
      baselineSha256: BASELINE_SHA,
      paths: {
        ...DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
        journal: path.join(stateDir, 'pm2-fallback-retirement.json'),
        bootstrapRuntimeEvidence: runtimeEvidence,
        bootstrapTransitionEvidence: transitionEvidence,
      },
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
    },
  };
}

function fakeHost(calls: string[], paths: ReturnType<typeof transactionPaths>) {
  return {
    async verifyResume() { calls.push('verifyResume'); },
    async retireSystemd() { calls.push('retireSystemd'); },
    async detachPackageClosure(admittedPlan: ReturnType<typeof plan>) {
      calls.push('detachPackageClosure');
      const manifest = {
        schema: 'nexus.pm2-fallback-closure-manifest.v1',
        transactionId: admittedPlan.transactionId,
        closureRoot: admittedPlan.pm2.closureRoot,
        closureSha256: admittedPlan.pm2.closureSha256,
        device: admittedPlan.pm2.closureDevice,
        entries: FAKE_CLOSURE_ENTRIES,
      };
      const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const manifestPath = path.join(
        paths.retirementRoot,
        `${admittedPlan.transactionId}.closure-manifest.json`,
      );
      fs.mkdirSync(paths.retirementRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(manifestPath, body, { mode: 0o600 });
      return {
        quarantinePath:
          `/opt/nexus-release/.pm2-fallback-retirement-${admittedPlan.transactionId}`,
        manifestPath,
        manifestSha256: sha256(body),
        device: admittedPlan.pm2.closureDevice,
        entryCount: FAKE_CLOSURE_ENTRIES.length,
      };
    },
    async retirePackage() { calls.push('retirePackage'); },
    async verifyPost() { calls.push('verifyPost'); },
  };
}

afterEach(() => {
  if (ORIGINAL_BACKUP_LOCK_FD === undefined) {
    delete process.env.NEXUS_RELEASE_BACKUP_LOCK_FD;
  } else {
    process.env.NEXUS_RELEASE_BACKUP_LOCK_FD = ORIGINAL_BACKUP_LOCK_FD;
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('container-era PM2 fallback retirement', () => {
  it('binds restore-verification receipts to canonical millisecond UTC', () => {
    const source = fs.readFileSync('scripts/local-backup.py', 'utf8');
    const restoreStart = source.indexOf('def decrypt_and_verify(');
    const restoreEnd = source.indexOf('\ndef verify_freshness_locked(', restoreStart);
    const restoreProducer = source.slice(restoreStart, restoreEnd);

    expect(restoreStart).toBeGreaterThanOrEqual(0);
    expect(restoreEnd).toBeGreaterThan(restoreStart);
    expect(restoreProducer).toContain([
      '"verifiedAt": datetime.now(timezone.utc).isoformat(',
      '                timespec="milliseconds"',
      '            ).replace("+00:00", "Z"),',
    ].join('\n'));
  });

  it('holds and exports the governed backup lock for the full retirement observation', () => {
    const paths = {
      ...DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
      controlPlaneLock: '/locks/control-plane',
      userReleaseLock: '/locks/user-release',
      maintenanceLock: '/locks/maintenance',
      backupLock: '/locks/backup',
    };
    const metadata = new Map([
      [paths.controlPlaneLock, { uid: 0, gid: 0, mode: 0o100600, ino: 1 }],
      [paths.userReleaseLock, { uid: 501, gid: 20, mode: 0o100600, ino: 2 }],
      [paths.maintenanceLock, { uid: 0, gid: 20, mode: 0o100660, ino: 3 }],
      [paths.backupLock, { uid: 0, gid: 0, mode: 0o100600, ino: 4 }],
    ]);
    const descriptorPaths = new Map<number, string>();
    const closed: number[] = [];
    const flockCalls: string[][] = [];
    let nextDescriptor = 10;
    const statFor = (file: string) => {
      const entry = metadata.get(file)!;
      return {
        ...entry,
        dev: 7,
        nlink: 1,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    };
    const fsApi = {
      lstatSync: (file: string) => statFor(file),
      openSync: (file: string) => {
        const descriptor = nextDescriptor;
        nextDescriptor += 1;
        descriptorPaths.set(descriptor, file);
        return descriptor;
      },
      fstatSync: (descriptor: number) => statFor(descriptorPaths.get(descriptor)!),
      closeSync: (descriptor: number) => { closed.push(descriptor); },
    };
    const spawn = (_binary: string, args: string[]) => {
      flockCalls.push(args);
      return { status: 0 };
    };
    process.env.NEXUS_RELEASE_BACKUP_LOCK_FD = '91';

    const release = acquirePm2FallbackRetirementLocks({
      paths,
      includeBackup: true,
      dominguezUid: 501,
      dominguezGid: 20,
      fsApi,
      spawn,
    });

    expect(flockCalls).toEqual([
      ['--nonblock', '3'],
      ['--nonblock', '3'],
      ['--nonblock', '3'],
      ['--shared', '--nonblock', '3'],
    ]);
    expect(process.env.NEXUS_RELEASE_BACKUP_LOCK_FD).toBe('13');
    expect(closed).toEqual([]);
    release();
    expect(closed).toEqual([13, 12, 11, 10]);
    expect(process.env.NEXUS_RELEASE_BACKUP_LOCK_FD).toBe('91');
  });

  it('re-proves the full installed controller and poller before admission', () => {
    const source = fs.readFileSync('scripts/lib/pm2-fallback-retirement.mjs', 'utf8');
    const collectorStart = source.indexOf('function collectInstalledControlPlaneEvidence(paths)');
    const collector = source.slice(
      collectorStart,
      source.indexOf('\nexport function inspectLegacyDatabaseQuiescence', collectorStart),
    );
    expect(collector).toContain('computeImmutableControlPlaneTreeDigest(resolved)');
    expect(collector).toContain('recomputedTreeSha256 !== treeSha256');
    expect(collector).toContain('assertReleaseControlPlaneNativeRuntime(resolved)');
    expect(source).toContain("'nexus-release-poller.service',\n  ...RESUMABLE_SUCCESSFUL_SERVICES");
    expect(source).toContain('assertServices(host.services);');
    expect(source).toContain('assertServices(collectServices(), { requirePoller: false });');
  });

  it('treats the control-plane post-gate journal as conflicting authority', () => {
    expect(DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS.controlPlanePostGate)
      .toBe('/var/lib/nexus-release/state/control-plane-post-gate.json');
    expect(DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS.controlPlaneFinalization)
      .toBe('/var/lib/nexus-release/state/control-plane-finalization.json');
    const source = fs.readFileSync('scripts/lib/pm2-fallback-retirement.mjs', 'utf8');
    const collectorStart = source.indexOf('function collectRetirementStateEvidence(paths');
    const collector = source.slice(
      collectorStart,
      source.indexOf('\nfunction collectSystemdArtifacts', collectorStart),
    );
    expect(collector).toContain('paths.controlPlanePostGate');
    expect(collector).toContain('paths.controlPlaneFinalization');
    expect(collector).toContain('inspectTerminalRebaselineEvidenceForRetirement');
    expect(collector).toContain('terminalRebaseline');
  });

  it('validates terminal rebaseline bytes and canonical evidence digests', () => {
    const fixture = terminalRebaselineFixture();
    const evidence = inspectTerminalRebaselineEvidenceForRetirement(
      fixture.file,
      ANCHOR_ID,
      fixture.options,
    );
    expect(evidence).toEqual({
      path: fixture.file,
      sha256: sha256(fs.readFileSync(fixture.file)),
      releaseId: ANCHOR_ID,
      createdAt: fixture.record.createdAt,
      updatedAt: fixture.record.updatedAt,
    });
  });

  it.each([
    ['incomplete phase', (fixture: ReturnType<typeof terminalRebaselineFixture>) => {
      fixture.record.phase = 'baseline_published';
      fixture.writeRecord();
    }, 'conflicting_state'],
    ['unknown field', (fixture: ReturnType<typeof terminalRebaselineFixture>) => {
      Object.assign(fixture.record, { unexpected: true });
      fixture.writeRecord();
    }, 'malformed_evidence'],
    ['changed canonical runtime evidence', (
      fixture: ReturnType<typeof terminalRebaselineFixture>,
    ) => {
      fs.writeFileSync(fixture.runtimeEvidence, '{"changed":true}\n', { mode: 0o600 });
    }, 'conflicting_state'],
    ['changed canonical transition evidence', (
      fixture: ReturnType<typeof terminalRebaselineFixture>,
    ) => {
      fs.writeFileSync(fixture.transitionEvidence, '{"changed":true}\n', { mode: 0o600 });
    }, 'conflicting_state'],
    ['different candidate baseline', (
      fixture: ReturnType<typeof terminalRebaselineFixture>,
    ) => {
      fixture.record.candidateBaselineSha256 = 'f'.repeat(64);
      fixture.writeRecord();
    }, 'conflicting_state'],
    ['different target payload', (
      fixture: ReturnType<typeof terminalRebaselineFixture>,
    ) => {
      fixture.record.expectedTarget.payloadDigest = `sha256:${'f'.repeat(64)}`;
      fixture.writeRecord();
    }, 'conflicting_state'],
    ['different production runtime source', (
      fixture: ReturnType<typeof terminalRebaselineFixture>,
    ) => {
      fixture.record.runtime.production.sourceSha = ACTIVE_SHA;
      fixture.writeRecord();
    }, 'malformed_evidence'],
    ['swapped staging runtime source', (
      fixture: ReturnType<typeof terminalRebaselineFixture>,
    ) => {
      fixture.record.runtime.staging.sourceSha = LEGACY_PRODUCTION_SHA;
      fixture.writeRecord();
    }, 'malformed_evidence'],
    ['unsafe record mode', (fixture: ReturnType<typeof terminalRebaselineFixture>) => {
      fs.chmodSync(fixture.file, 0o644);
    }, 'unsafe_evidence'],
  ] as const)('refuses terminal rebaseline %s', (_label, mutate, code) => {
    const fixture = terminalRebaselineFixture();
    mutate(fixture);
    expect(() => inspectTerminalRebaselineEvidenceForRetirement(
      fixture.file,
      ANCHOR_ID,
      fixture.options,
    )).toThrowError(expect.objectContaining({ code }));
  });

  it('admits only at the exact 14-day baseline/receipt boundary', () => {
    const before = validInput();
    before.now = ELIGIBLE_AT - 1;
    expect(() => evaluatePm2FallbackRetirementAdmission(before as never))
      .toThrowError(expect.objectContaining({ code: 'stable_window_open' }));

    const admitted = plan();
    expect(admitted.notBefore).toBe(new Date(ELIGIBLE_AT).toISOString());
    expect(admitted.anchor).toMatchObject({
      releaseId: ANCHOR_ID,
      receiptSha256: ANCHOR_RECEIPT_SHA,
      baselineSha256: BASELINE_SHA,
      baselineAuthorizationDigest: BASELINE_AUTHORIZATION_DIGEST,
    });
    expect(admitted.active).toMatchObject({
      releaseId: ACTIVE_ID,
      receiptSha256: ACTIVE_RECEIPT_SHA,
    });
  });

  it('binds a completed current-baseline rebaseline checkpoint into the plan', () => {
    const input = validInput();
    input.host.terminalRebaseline = { ...TERMINAL_REBASELINE };
    const admitted = evaluatePm2FallbackRetirementAdmission(input as never);
    expect(admitted.terminalRebaseline).toEqual(TERMINAL_REBASELINE);
  });

  it.each([
    ['baseline receipt detail', (input: ReturnType<typeof validInput>) => {
      input.anchorReceipt.staging.checks[0].detail = `sha256:${'0'.repeat(64)}`;
    }, 'bootstrap_receipt_mismatch'],
    ['baseline authorization digest', (input: ReturnType<typeof validInput>) => {
      input.baselineAuthorizationDigest = '0'.repeat(64);
    }, 'bootstrap_receipt_mismatch'],
    ['unprovable active release', (input: ReturnType<typeof validInput>) => {
      input.effective.provable = false;
    }, 'active_release_unprovable'],
    ['missing permanent guard', (input: ReturnType<typeof validInput>) => {
      input.host.guards[0].linkTarget = '/tmp/not-null';
    }, 'pm2_guard_missing'],
    ['unknown PM2 authority', (input: ReturnType<typeof validInput>) => {
      input.host.systemdArtifacts.push({
        path: '/etc/systemd/system/pm2-unknown.service',
        allowed: false,
        kind: 'unit',
        sha256: 'f'.repeat(64),
      });
    }, 'unknown_pm2_authority'],
    ['changed PM2 closure', (input: ReturnType<typeof validInput>) => {
      input.host.pm2ClosureSha256 = '0'.repeat(64);
    }, 'pm2_attestation_mismatch'],
    ['missing active receipt control plane', (input: ReturnType<typeof validInput>) => {
      delete (input.activeReceipt as { controlPlane?: unknown }).controlPlane;
    }, 'control_plane_receipt_mismatch'],
    ['mismatched installed control plane', (input: ReturnType<typeof validInput>) => {
      input.host.controlPlane.digest = '0'.repeat(64);
    }, 'control_plane_receipt_mismatch'],
    ['stale backup liveness', (input: ReturnType<typeof validInput>) => {
      input.host.backupLiveness.backup.ageSeconds = 7201;
    }, 'backup_liveness_stale'],
    ['inactive backup-liveness timer', (input: ReturnType<typeof validInput>) => {
      const timer = input.host.timers.find(
        (entry) => entry.unit === 'nexus-release-backup-liveness.timer',
      )!;
      (timer as { activeState: string }).activeState = 'inactive';
    }, 'timer_unhealthy'],
    ['missing settled poller result', (input: ReturnType<typeof validInput>) => {
      input.host.services = input.host.services.filter(
        (entry) => entry.unit !== 'nexus-release-poller.service',
      );
    }, 'service_unhealthy'],
    ['active poller service', (input: ReturnType<typeof validInput>) => {
      input.host.services[0].activeState = 'active';
    }, 'service_unhealthy'],
    ['failed poller service', (input: ReturnType<typeof validInput>) => {
      input.host.services[0].result = 'failed';
    }, 'service_unhealthy'],
    ['nonzero poller service', (input: ReturnType<typeof validInput>) => {
      input.host.services[0].execMainStatus = '1';
    }, 'service_unhealthy'],
    ['open legacy database handle', (input: ReturnType<typeof validInput>) => {
      input.host.legacyDatabaseQuiescent = false;
    }, 'legacy_database_not_quiescent'],
    ['malformed terminal rebaseline evidence', (input: ReturnType<typeof validInput>) => {
      input.host.terminalRebaseline = {
        ...TERMINAL_REBASELINE,
        path: '/var/lib/nexus-release/state/bootstrap-rebaseline-wrong.json',
      };
    }, 'malformed_evidence'],
    ['terminal rebaseline for another anchor', (input: ReturnType<typeof validInput>) => {
      input.host.terminalRebaseline = {
        ...TERMINAL_REBASELINE,
        path: `/var/lib/nexus-release/state/bootstrap-rebaseline-${ACTIVE_ID}.json`,
        releaseId: ACTIVE_ID,
      };
    }, 'bootstrap_receipt_mismatch'],
  ] as const)('fails closed for %s', (_label, mutate, code) => {
    const input = validInput();
    mutate(input);
    expect(() => evaluatePm2FallbackRetirementAdmission(input as never))
      .toThrowError(expect.objectContaining({ code }));
  });

  it('admits pretty JSON with distinct immutable and authorization digests', () => {
    const input = validInput();
    const baselineBytes = Buffer.from(`${JSON.stringify(input.baseline, null, 2)}\n`);
    input.baselineSha256 = sha256(baselineBytes);
    input.baselineAuthorizationDigest = sha256(canonicalJson(input.baseline));
    input.anchorReceipt.staging.checks[0].detail
      = `sha256:${input.baselineAuthorizationDigest}`;
    input.anchorReceipt.production.checks[0].detail
      = `sha256:${input.baselineAuthorizationDigest}`;
    const anchorBytes = Buffer.from(`${JSON.stringify(input.anchorReceipt, null, 2)}\n`);
    const activeBytes = Buffer.from(`${JSON.stringify(input.activeReceipt, null, 2)}\n`);
    input.anchorReceiptSha256 = sha256(anchorBytes);
    input.activeReceiptSha256 = sha256(activeBytes);

    const admitted = evaluatePm2FallbackRetirementAdmission(input as never);
    expect(input.baselineSha256).not.toBe(input.baselineAuthorizationDigest);
    expect(admitted.active.receiptSha256).toBe(sha256(activeBytes));
    expect(admitted.active.receiptSha256)
      .not.toBe(sha256(canonicalJson(input.activeReceipt)));
    expect(admitted.anchor.receiptSha256).toBe(sha256(anchorBytes));
    expect(admitted.anchor.baselineSha256).toBe(sha256(baselineBytes));
    expect(admitted.anchor.baselineAuthorizationDigest)
      .toBe(sha256(canonicalJson(input.baseline)));
  });

  it('does not create durable evidence for a wrong confirmation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-confirm-'));
    temporaryRoots.push(root);
    const paths = transactionPaths(root);
    const calls: string[] = [];
    await expect(runPm2FallbackRetirementTransaction({
      plan: plan(),
      confirmation: `${'0'.repeat(32)}:${'0'.repeat(64)}:${'0'.repeat(32)}:${'0'.repeat(64)}`,
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
      now: () => ELIGIBLE_AT,
      host: fakeHost(calls, paths),
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    expect(fs.existsSync(paths.journal)).toBe(false);
    expect(fs.existsSync(paths.tombstone)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('round-trips non-null terminal rebaseline evidence through terminal status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-rebaseline-'));
    temporaryRoots.push(root);
    const paths = transactionPaths(root);
    const input = validInput();
    input.host.terminalRebaseline = { ...TERMINAL_REBASELINE };
    const admittedPlan = evaluatePm2FallbackRetirementAdmission(input as never);
    await runPm2FallbackRetirementTransaction({
      plan: admittedPlan,
      confirmation: admittedPlan.confirmation,
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
      now: () => ELIGIBLE_AT,
      host: fakeHost([], paths),
    });
    expect(readPm2FallbackRetirementStatus({
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
    })).toMatchObject({
      status: 'completed',
      receipt: {
        plan: { terminalRebaseline: TERMINAL_REBASELINE },
      },
    });
  });

  it.each([
    'admitted',
    'fallback_barred',
    'systemd_retired',
    'closure_detached',
    'package_retired',
    'verified',
    'receipt_written',
  ])('resumes idempotently after a crash at %s', async (crashAfterPhase) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-resume-'));
    temporaryRoots.push(root);
    const paths = transactionPaths(root);
    const admittedPlan = plan();
    const calls: string[] = [];
    const options = {
      plan: admittedPlan,
      confirmation: admittedPlan.confirmation,
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
      now: () => ELIGIBLE_AT,
      host: fakeHost(calls, paths),
    };
    await expect(runPm2FallbackRetirementTransaction({
      ...options,
      crashAfterPhase,
    })).rejects.toThrow(`simulated crash after ${crashAfterPhase}`);

    const result = await runPm2FallbackRetirementTransaction(options);
    expect(result.outcome).toBe('completed');
    expect(fs.existsSync(paths.journal)).toBe(false);
    expect(readPm2FallbackRetirementStatus({
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
    })).toMatchObject({
      status: 'completed',
      receipt: {
        transactionId: admittedPlan.transactionId,
        result: 'completed',
        preservedPaths: PM2_FALLBACK_PRESERVED_PATHS,
      },
    });
  });

  it('blocks a malformed durable journal without calling the host mutator', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-corrupt-'));
    temporaryRoots.push(root);
    const paths = transactionPaths(root);
    fs.writeFileSync(paths.journal, '{bad json\n', { mode: 0o600 });
    const admittedPlan = plan();
    const calls: string[] = [];
    await expect(runPm2FallbackRetirementTransaction({
      plan: admittedPlan,
      confirmation: admittedPlan.confirmation,
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
      now: () => ELIGIBLE_AT,
      host: fakeHost(calls, paths),
    })).rejects.toBeInstanceOf(Pm2FallbackRetirementRefusal);
    expect(calls).toEqual([]);
    expect(fs.readFileSync(paths.journal, 'utf8')).toBe('{bad json\n');
  });

  it('refuses a malformed nested terminal receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-receipt-'));
    temporaryRoots.push(root);
    const paths = transactionPaths(root);
    const admittedPlan = plan();
    const result = await runPm2FallbackRetirementTransaction({
      plan: admittedPlan,
      confirmation: admittedPlan.confirmation,
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
      now: () => ELIGIBLE_AT,
      host: fakeHost([], paths),
    });
    const malformed = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    malformed.active.receiptSha256 = '0'.repeat(64);
    fs.writeFileSync(result.receiptPath, `${JSON.stringify(malformed, null, 2)}\n`);

    expect(() => readPm2FallbackRetirementStatus({
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
    })).toThrowError(expect.objectContaining({ code: 'malformed_terminal_receipt' }));
  });

  it('refuses terminal status when retained closure-manifest bytes change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-manifest-'));
    temporaryRoots.push(root);
    const paths = transactionPaths(root);
    const admittedPlan = plan();
    const result = await runPm2FallbackRetirementTransaction({
      plan: admittedPlan,
      confirmation: admittedPlan.confirmation,
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
      now: () => ELIGIBLE_AT,
      host: fakeHost([], paths),
    });
    fs.appendFileSync(result.receipt.retired.closure.manifestPath, ' \n');

    expect(() => readPm2FallbackRetirementStatus({
      paths,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
    })).toThrowError(expect.objectContaining({ code: 'artifact_changed' }));
  });

  it('refuses a PM2 closure that crosses a filesystem boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-closure-'));
    temporaryRoots.push(root);
    const nested = path.join(root, 'node_modules');
    const file = path.join(nested, 'pm2.js');
    fs.chmodSync(root, 0o755);
    fs.mkdirSync(nested, { mode: 0o755 });
    fs.writeFileSync(file, 'pm2\n', { mode: 0o644 });
    const ownerUid = process.getuid!();
    const ownerGid = process.getgid!();
    const identity = inspectPm2ClosureForRetirement(root, { ownerUid, ownerGid });
    expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/u);

    const fsApi = {
      lstatSync(candidate: fs.PathLike) {
        const stat = fs.lstatSync(candidate);
        return new Proxy(stat, {
          get(target, property) {
            if (property === 'dev' && String(candidate) === file) return identity.device + 1;
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
    };
    expect(() => inspectPm2ClosureForRetirement(root, {
      fsApi: fsApi as never,
      ownerUid,
      ownerGid,
      expectedDevice: identity.device,
    })).toThrowError(expect.objectContaining({ code: 'unsafe_pm2_closure' }));
  });

  it('accepts only an exact remaining systemd subset after a destructive-step crash', () => {
    const planned = [{
      path: '/etc/systemd/system/pm2-dominguez.service',
      allowed: true,
      kind: 'unit',
      sha256: '1'.repeat(64),
    }, {
      path: '/etc/systemd/system/multi-user.target.wants/pm2-dominguez.service',
      allowed: true,
      kind: 'enable-link',
      linkTarget: '/etc/systemd/system/pm2-dominguez.service',
    }];
    expect(assertRemainingPlannedSystemdArtifacts({
      planned,
      observed: [planned[1]],
      allowSubset: true,
    })).toBe(true);
    expect(() => assertRemainingPlannedSystemdArtifacts({
      planned,
      observed: [{ ...planned[1], linkTarget: '/tmp/changed' }],
      allowSubset: true,
    })).toThrowError(expect.objectContaining({ code: 'artifact_changed' }));
    expect(() => assertRemainingPlannedSystemdArtifacts({
      planned,
      observed: [{ ...planned[0], path: '/etc/systemd/system/unknown.service' }],
      allowSubset: true,
    })).toThrowError(expect.objectContaining({ code: 'artifact_changed' }));
  });

  it('leaves an exact resumable subset when systemd unlink crashes internally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-systemd-'));
    temporaryRoots.push(root);
    const wants = path.join(root, 'multi-user.target.wants');
    fs.mkdirSync(wants, { mode: 0o755 });
    const unit = path.join(root, 'pm2-dominguez.service');
    const enableLink = path.join(wants, 'pm2-dominguez.service');
    fs.symlinkSync(unit, enableLink);
    const artifact = {
      path: enableLink,
      allowed: true,
      kind: 'enable-link',
      linkTarget: unit,
    };
    const mutator = createLinuxPm2FallbackRetirementMutator({
      paths: { ...DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS, unitRoot: root },
      policy: {},
      onDestructiveStep(step) {
        if (step === `systemd_retired:${enableLink}`) {
          throw new Error('crash inside systemd unlink');
        }
      },
    });

    await expect(mutator.retireSystemd({
      pm2: { systemdArtifacts: [artifact] },
    } as never)).rejects.toThrow('crash inside systemd unlink');
    expect(fs.existsSync(enableLink)).toBe(false);
    expect(assertRemainingPlannedSystemdArtifacts({
      planned: [artifact],
      observed: [],
      allowSubset: true,
    })).toBe(true);
  });

  it('resumes atomic closure detachment and a crash inside non-following purge', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-detach-'));
    temporaryRoots.push(root);
    fs.chmodSync(root, 0o755);
    const prefix = path.join(root, 'pm2');
    const source = path.join(prefix, '6.0.8');
    const nested = path.join(source, 'bin');
    const executable = path.join(nested, 'pm2');
    fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
    fs.chmodSync(prefix, 0o755);
    fs.chmodSync(source, 0o755);
    fs.chmodSync(nested, 0o755);
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
    const ownerUid = process.getuid!();
    const ownerGid = process.getgid!();
    const inspection = inspectPm2ClosureForRetirement(source, { ownerUid, ownerGid });
    const quarantine = path.join(root, '.pm2-retirement-fixture');

    expect(() => detachPm2ClosureAtomically({
      source,
      quarantine,
      expectedSha256: inspection.sha256,
      expectedDevice: inspection.device,
      expectedEntries: inspection.entries,
      ownerUid,
      ownerGid,
      onDestructiveStep(step) {
        if (step === 'closure_detached') throw new Error('crash inside detach');
      },
    })).toThrow('crash inside detach');
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(quarantine)).toBe(true);
    expect(detachPm2ClosureAtomically({
      source,
      quarantine,
      expectedSha256: inspection.sha256,
      expectedDevice: inspection.device,
      expectedEntries: inspection.entries,
      ownerUid,
      ownerGid,
    }).sha256).toBe(inspection.sha256);

    let crashed = false;
    expect(() => purgeDetachedPm2Closure({
      quarantine,
      manifest: { device: inspection.device, entries: inspection.entries },
      ownerUid,
      ownerGid,
      onDestructiveStep(step) {
        if (!crashed && step.startsWith('closure_purged:')) {
          crashed = true;
          throw new Error('crash inside purge');
        }
      },
    })).toThrow('crash inside purge');
    expect(fs.existsSync(quarantine)).toBe(true);
    purgeDetachedPm2Closure({
      quarantine,
      manifest: { device: inspection.device, entries: inspection.entries },
      ownerUid,
      ownerGid,
    });
    expect(fs.existsSync(quarantine)).toBe(false);
  });

  it('refuses an unallowlisted path inserted into detached quarantine', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-purge-'));
    temporaryRoots.push(root);
    fs.chmodSync(root, 0o755);
    const quarantine = path.join(root, 'quarantine');
    fs.mkdirSync(quarantine, { mode: 0o755 });
    fs.writeFileSync(path.join(quarantine, 'known'), 'known\n', { mode: 0o644 });
    const ownerUid = process.getuid!();
    const ownerGid = process.getgid!();
    const inspection = inspectPm2ClosureForRetirement(quarantine, { ownerUid, ownerGid });
    fs.writeFileSync(path.join(quarantine, 'unknown'), 'unknown\n', { mode: 0o644 });

    expect(() => purgeDetachedPm2Closure({
      quarantine,
      manifest: { device: inspection.device, entries: inspection.entries },
      ownerUid,
      ownerGid,
    })).toThrowError(expect.objectContaining({ code: 'unsafe_removal' }));
  });

  it('binds closure reads to the checked inode and refuses a path swap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-read-race-'));
    temporaryRoots.push(root);
    fs.chmodSync(root, 0o755);
    const target = path.join(root, 'pm2.js');
    fs.writeFileSync(target, 'known\n', { mode: 0o644 });
    let swapped = false;
    const fsApi = new Proxy(fs, {
      get(source, key) {
        if (key === 'lstatSync') {
          return (file: fs.PathLike) => {
            const stat = fs.lstatSync(file);
            if (!swapped && file === target) {
              swapped = true;
              const original = `${target}.original`;
              fs.renameSync(target, original);
              fs.symlinkSync(original, target);
            }
            return stat;
          };
        }
        const value = Reflect.get(source, key);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });

    expect(() => inspectPm2ClosureForRetirement(root, {
      fsApi,
      ownerUid: process.getuid!(),
      ownerGid: process.getgid!(),
    })).toThrowError(expect.objectContaining({ code: 'artifact_changed' }));
  });

  it('filters absent legacy DB sidecars before lsof and refuses an open base', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-retirement-db-'));
    temporaryRoots.push(root);
    const database = path.join(root, 'bot.db');
    const journal = `${database}-journal`;
    fs.writeFileSync(database, 'sqlite\n', { mode: 0o600 });
    fs.writeFileSync(journal, 'rollback\n', { mode: 0o600 });
    const expectedUid = process.getuid!();
    const expectedGid = process.getgid!();
    let observedArgs: string[] = [];
    const idle = inspectLegacyDatabaseQuiescence({
      databasePaths: [database, path.join(root, 'absent.db')],
      expectedUid,
      expectedGid,
      spawn: ((_binary: string, args: string[]) => {
        observedArgs = args;
        return { status: 1, stdout: '', stderr: '' };
      }) as never,
    });
    expect(idle).toBe(true);
    expect(observedArgs).toEqual(['-t', '--', database, journal]);

    expect(inspectLegacyDatabaseQuiescence({
      databasePaths: [database],
      expectedUid,
      expectedGid,
      spawn: (() => ({ status: 0, stdout: '123\n', stderr: '' })) as never,
    })).toBe(false);
  });

  it('binds the correct root PM2 attestation path and preservation boundary', () => {
    expect(DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS.pm2Attestation)
      .toBe('/var/lib/nexus-release-promotion/pm2-root-install.v1.json');
    expect(PM2_FALLBACK_PRESERVED_PATHS).toContain('/home/dominguez/.pm2');
    expect(PM2_FALLBACK_PRESERVED_PATHS).toContain('/etc/nexus-release');
  });

  it('admits a recovered exact-closure attestation without fabricating archive provenance', () => {
    const input = validInput();
    const original = input.host.pm2Attestation;
    input.host.pm2Attestation = {
      schema: 'nexus.pm2-root-install-recovered.v1',
      version: original.version,
      recoveryMethod: 'exact-installed-closure',
      closureDigest: original.closureDigest,
      payloadDigest: original.payloadDigest,
      packageLockSha256: original.packageLockSha256,
      fileCount: original.fileCount,
      closureRoot: original.closureRoot,
      launcher: original.launcher,
      launcherSha256: original.launcherSha256,
      entrypoint: original.entrypoint,
      node: original.node,
      attestedAt: '2026-08-30T00:00:00.000Z',
    };

    expect(evaluatePm2FallbackRetirementAdmission(input as never).pm2.version)
      .toBe(original.version);
    expect(input.host.pm2Attestation).not.toHaveProperty('sourceArchiveSha256');
  });

  it('refuses an unknown recovered-attestation method', () => {
    const input = validInput();
    input.host.pm2Attestation = {
      ...input.host.pm2Attestation,
      schema: 'nexus.pm2-root-install-recovered.v1',
      recoveryMethod: 'unverified-copy',
      attestedAt: '2026-08-30T00:00:00.000Z',
    } as never;
    delete (input.host.pm2Attestation as Record<string, unknown>).sourceArchiveSha256;
    delete (input.host.pm2Attestation as Record<string, unknown>).installedAt;

    expect(() => evaluatePm2FallbackRetirementAdmission(input as never))
      .toThrowError(expect.objectContaining({ code: 'pm2_attestation_mismatch' }));
  });

  it('blocks in-progress retirement without blocking ordinary releases after completion', () => {
    const pollerUnit = fs.readFileSync(
      'ops/nexus-release/nexus-release-poller.service',
      'utf8',
    );
    const bootstrapUnit = fs.readFileSync(
      'ops/nexus-release/nexus-release-bootstrap.service',
      'utf8',
    );
    const heartbeatUnit = fs.readFileSync(
      'ops/nexus-release/nexus-release-heartbeat.service',
      'utf8',
    );
    const wrapper = fs.readFileSync('scripts/release-poll.sh', 'utf8');
    const deploy = fs.readFileSync('scripts/release-deploy.mjs', 'utf8');
    const legacyFallback = fs.readFileSync(
      'scripts/remote-user-release-transaction.sh',
      'utf8',
    );

    expect(pollerUnit).toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/pm2-fallback-retirement.json',
    );
    expect(pollerUnit).not.toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/pm2-fallback-retired.json',
    );
    expect(bootstrapUnit).toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/pm2-fallback-retirement.json',
    );
    expect(bootstrapUnit).toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/pm2-fallback-retired.json',
    );
    expect(heartbeatUnit).not.toContain('pm2-fallback-retir');
    expect(wrapper).toContain('PM2_RETIREMENT_JOURNAL=');
    expect(wrapper).toContain('PM2_RETIRED_TOMBSTONE=');
    expect(wrapper).toContain('"${1:-}" = --allow-first-container-bootstrap');
    expect(deploy).toContain('if (retirementGatePresent(retirementJournal))');
    expect(deploy).toContain(
      'if (allowFirstContainerBootstrap && retirementGatePresent(retiredTombstone))',
    );
    expect(legacyFallback).toContain('assert_pm2_fallback_not_retired');
    expect(legacyFallback).toContain(
      'PM2 fallback is barred by its persistent retirement guard',
    );
  });

  it('bars every copied legacy revival path and validates one privileged view', () => {
    const runbook = fs.readFileSync('ops/nexus-release/README.md', 'utf8');
    const remote = fs.readFileSync(
      'scripts/remote-user-release-transaction.sh',
      'utf8',
    );
    const stateView = fs.readFileSync('scripts/release-state-view.mjs', 'utf8');
    const refusalLabels = [
      'PRE-BASELINE RECOVERY REFUSED',
      'BOOTSTRAP RECOVERY REFUSED',
      'BOOTSTRAP REBASELINE REFUSED',
    ];
    for (const label of refusalLabels) {
      const labelAt = runbook.indexOf(label);
      const endAt = runbook.indexOf('\n```', labelAt);
      expect(labelAt).toBeGreaterThan(-1);
      expect(endAt).toBeGreaterThan(labelAt);
      const block = runbook.slice(labelAt, endAt);
      expect(block).toContain(
        'PM2_RETIREMENT_JOURNAL=/var/lib/nexus-release/state/pm2-fallback-retirement.json',
      );
      expect(block).toContain(
        'PM2_RETIRED_TOMBSTONE=/var/lib/nexus-release/state/pm2-fallback-retired.json',
      );
      expect(block).toContain('sudo test ! -e "$PM2_RETIREMENT_GATE"');
      expect(block).toContain('sudo test ! -L "$PM2_RETIREMENT_GATE"');
      expect(block.indexOf('PM2_RETIREMENT_JOURNAL=')).toBeLessThan(
        block.indexOf('run_pm2_as_dominguez()'),
      );
      const guardRetirement = block.indexOf('retire_canonical_pm2_guard');
      if (guardRetirement !== -1) {
        expect(block.indexOf('PM2_RETIREMENT_JOURNAL='))
          .toBeLessThan(guardRetirement);
      }
    }
    expect(runbook.match(/^PM2_RETIREMENT_JOURNAL=/gmu)).toHaveLength(3);
    expect(runbook.match(/^PM2_RETIRED_TOMBSTONE=/gmu)).toHaveLength(3);

    expect(stateView).toContain('fs.lstatSync(file)');
    expect(stateView).toContain("if (error?.code === 'ENOENT') return false");
    expect(stateView).toContain(
      'pm2FallbackRetirementInProgress: pathPresentByLstat(pm2RetirementJournal)',
    );
    expect(stateView).toContain(
      'pm2FallbackRetired: pathPresentByLstat(pm2RetiredTombstone)',
    );
    expect(remote.match(/"\$SUDO_BIN" -n "\$STATE_VIEW_BIN"/gu)).toHaveLength(1);
    const gateCall = remote.indexOf('\nassert_pm2_fallback_not_retired\n');
    expect(gateCall).toBeGreaterThan(remote.indexOf('flock -n 8'));
    expect(gateCall).toBeLessThan(remote.indexOf('\nverify_pristine_bundle\n'));
    expect(remote).toContain('PM2 fallback retirement journal or tombstone exists');

    const parser = remote.match(
      /\| "\$NODE_BIN" -e '\n([\s\S]*?)\n'\n/u,
    )?.[1];
    expect(parser).toBeTruthy();
    const view = {
      schema: 'nexus.release-state-view.v2',
      generated: true,
      authoritative: false,
      note: 'bounded root view',
      generatedAt: ANCHOR_COMPLETED_AT,
      active: null,
      predecessor: null,
      blocked: null,
      lastRecovery: null,
      recent: [],
      capturedAt: ANCHOR_COMPLETED_AT,
      sourceSchemas: {
        state: 'nexus.release-host-state.v1',
        receipt: 'nexus.release-receipt.v3',
      },
      effective: { provable: false },
      activeReceipt: null,
      pm2FallbackRetirementInProgress: false,
      pm2FallbackRetired: false,
    };
    const parse = (value: unknown) => spawnSync(process.execPath, ['-e', parser!], {
      input: JSON.stringify(value),
      encoding: 'utf8',
    });
    expect(parse(view)).toMatchObject({ status: 0, stdout: 'clear' });
    expect(parse({ ...view, pm2FallbackRetired: true }))
      .toMatchObject({ status: 0, stdout: 'blocked' });
    expect(parse({ ...view, unexpected: true }).status).toBe(1);
    expect(spawnSync('bash', ['-n', 'scripts/remote-user-release-transaction.sh']).status)
      .toBe(0);
  });

  it('keeps backup installation durable and permits an exact old rollback target', () => {
    const runbook = fs.readFileSync('ops/nexus-release/README.md', 'utf8');
    const sectionStart = runbook.indexOf('## 1a. Immutable control-plane install or upgrade');
    const blockStart = runbook.indexOf('```bash\n', sectionStart) + '```bash\n'.length;
    const blockEnd = runbook.indexOf('\n```', blockStart);
    const upgradeBlock = runbook.slice(blockStart, blockEnd);
    expect(spawnSync('bash', ['-n'], { input: upgradeBlock }).status).toBe(0);
    for (const field of [
      'backupTimerWasActive',
      'backupTimerWasEnabled',
      'controlPlaneSchema',
      'controlPlaneDigest',
      'pollerTimerDesiredActive',
      'pollerTimerDesiredEnabled',
      'livenessTimerWasActive',
      'livenessTimerWasEnabled',
      'livenessTimerDesiredActive',
      'livenessTimerDesiredEnabled',
      'restoreVerifyTimerWasActive',
      'restoreVerifyTimerWasEnabled',
    ]) expect(upgradeBlock).toContain(field);
    expect(upgradeBlock).toContain('publish_transaction_phase backup_interface_installed');
    expect(upgradeBlock).toContain(
      '"$TARGET/scripts/local-backup-systemd-install.sh" "$TARGET"',
    );
    expect(upgradeBlock).toContain('verify_installed_backup_interface');
    expect(upgradeBlock).toContain('NeedDaemonReload --value');
    expect(upgradeBlock).toContain('TIMER_FAILSAFE_ARMED=1');
    expect(upgradeBlock).toContain('disable_timer_if_present "$TIMER_UNIT"');
    expect(upgradeBlock).toContain('require_local_backup_services_settled');
    expect(upgradeBlock).toContain('control-plane-post-gate.json');
    expect(upgradeBlock).toContain('mv -T -- "$TRANSACTION_STATE" "$POST_GATE_STATE"');
    expect(upgradeBlock).toContain('read_timer_bits_or_absent nexus-release-backup-liveness.timer');

    const finalizationDigestProgram = upgradeBlock.match(
      /FINAL_CALCULATED_DIGEST="\$\(\/usr\/bin\/node --input-type=module - \\\n+    "\$FINAL_TARGET" <<'NODE'\n([\s\S]*?)\nNODE\n  \)" \|\| die 'finalization candidate digest recomputation failed'/u,
    )?.[1];
    expect(finalizationDigestProgram).toBeTruthy();
    const finalizationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-finalization-'));
    temporaryRoots.push(finalizationRoot);
    fs.writeFileSync(path.join(finalizationRoot, 'unrelated-runtime.mjs'), 'export const v = 1;\n');
    const calculateFinalizationDigest = () => spawnSync(
      process.execPath,
      ['--input-type=module', '-', finalizationRoot],
      { input: finalizationDigestProgram, encoding: 'utf8' },
    );
    const beforeFinalizationDrift = calculateFinalizationDigest();
    expect(beforeFinalizationDrift.status, beforeFinalizationDrift.stderr).toBe(0);
    fs.writeFileSync(path.join(finalizationRoot, 'unrelated-runtime.mjs'), 'export const v = 2;\n');
    const afterFinalizationDrift = calculateFinalizationDigest();
    expect(afterFinalizationDrift.status, afterFinalizationDrift.stderr).toBe(0);
    expect(afterFinalizationDrift.stdout).not.toBe(beforeFinalizationDrift.stdout);
    const finalizationStart = upgradeBlock.indexOf(
      'if test -e "$FINALIZATION_STATE" || test -L "$FINALIZATION_STATE"; then',
    );
    const finalizationTimerResume = upgradeBlock.indexOf(
      'resume_final_timer()',
      finalizationStart,
    );
    const finalizationProof = upgradeBlock.slice(finalizationStart, finalizationTimerResume);
    expect(finalizationStart).toBeGreaterThan(-1);
    expect(finalizationTimerResume).toBeGreaterThan(finalizationStart);
    expect(finalizationProof).toContain(
      'finalization immutable candidate differs from its durable digest',
    );
    expect(finalizationProof).toContain('computeReleaseControlPlaneIdentity(root');
    expect(finalizationProof).toContain("const Database = require('better-sqlite3')");
    expect(finalizationProof).toContain('finalization control-plane identity changed');
    expect(finalizationProof).toContain(
      'cmp -s -- "$FINAL_TARGET/ops/nexus-release/$unit"',
    );
    for (const property of [
      'LoadState',
      'FragmentPath',
      'DropInPaths',
      'NeedDaemonReload',
    ]) {
      expect(finalizationProof).toContain(`--property=${property} --value`);
    }
    expect(finalizationProof).toContain('finalization liveness unit proof failed');
    expect(finalizationProof).toContain('nexus-release-backup-liveness-force.service');
    expect(finalizationProof).toContain(
      'finalization lacks the durable forced backup-liveness proof',
    );
    expect(finalizationProof).toContain('FINAL_CAPABILITY_ANCESTORS=');
    expect(finalizationProof).toContain('/usr/bin/sudo -u dominguez /usr/bin/sudo -n');
    expect(finalizationProof).toContain('finalization delegated state-view proof failed');
    expect(finalizationProof).not.toContain('systemctl start "$unit"');

    const guardHelpers = upgradeBlock.match(
      /(candidate_post_gate_guards_state\(\) \{[\s\S]*?\n\})\n\n(candidate_transaction_guards_state\(\) \{[\s\S]*?\n\})\n\nrequire_immutable_candidate/u,
    );
    expect(guardHelpers).toBeTruthy();
    const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-guards-'));
    temporaryRoots.push(guardRoot);
    const guardUnitRoot = path.join(guardRoot, 'ops', 'nexus-release');
    fs.mkdirSync(guardUnitRoot, { recursive: true });
    for (const unit of [
      'nexus-release-bootstrap.service',
      'nexus-release-poller.service',
      'nexus-release-heartbeat.service',
    ]) {
      fs.copyFileSync(path.join('ops', 'nexus-release', unit), path.join(guardUnitRoot, unit));
    }
    const runGuardHelper = (name: string) => spawnSync('bash', ['-c', `
set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
candidate_liveness_pair_state() { printf 'absent\\n'; }
${guardHelpers![1]}
${guardHelpers![2]}
"$1" "$2"
`, 'fixture', name, guardRoot], { encoding: 'utf8' });
    expect(runGuardHelper('candidate_post_gate_guards_state'))
      .toMatchObject({ status: 0, stdout: 'present\n' });
    expect(runGuardHelper('candidate_transaction_guards_state'))
      .toMatchObject({ status: 0, stdout: 'present\n' });

    const transactionSymlink =
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json';
    const postGateSymlink =
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json';
    const stripLine = (unit: string, line: string) => {
      const target = path.join(guardUnitRoot, unit);
      fs.writeFileSync(target, fs.readFileSync(target, 'utf8')
        .split('\n').filter((entry) => entry !== line).join('\n'));
    };
    for (const unit of [
      'nexus-release-bootstrap.service',
      'nexus-release-poller.service',
      'nexus-release-heartbeat.service',
    ]) stripLine(unit, transactionSymlink);
    for (const unit of [
      'nexus-release-bootstrap.service',
      'nexus-release-poller.service',
    ]) stripLine(unit, postGateSymlink);
    expect(runGuardHelper('candidate_post_gate_guards_state'))
      .toMatchObject({ status: 0, stdout: 'legacy\n' });
    expect(runGuardHelper('candidate_transaction_guards_state'))
      .toMatchObject({ status: 0, stdout: 'legacy\n' });
    fs.appendFileSync(
      path.join(guardUnitRoot, 'nexus-release-bootstrap.service'),
      `${postGateSymlink}\n`,
    );
    expect(runGuardHelper('candidate_post_gate_guards_state')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('partial post-gate workload guard'),
    });

    const ancestorProgram = upgradeBlock.match(
      /trusted_destination_ancestor_identity\(\) \{\n  \/usr\/bin\/node --input-type=module - 0 0 \/ "\$@" <<'NODE'\n([\s\S]*?)\nNODE\n\}/u,
    )?.[1];
    expect(ancestorProgram).toBeTruthy();
    const ancestorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-ancestors-'));
    temporaryRoots.push(ancestorRoot);
    const safeParent = path.join(ancestorRoot, 'usr', 'local', 'sbin');
    fs.mkdirSync(safeParent, { recursive: true, mode: 0o755 });
    const checkAncestors = (destination: string) => spawnSync(process.execPath, [
      '--input-type=module',
      '-',
      String(process.getuid?.() ?? 0),
      String(process.getgid?.() ?? 0),
      ancestorRoot,
      destination,
    ], { input: ancestorProgram, encoding: 'utf8' });
    const safeDestination = path.join(safeParent, 'nexus-release-state-view');
    expect(checkAncestors(safeDestination).status).toBe(0);
    fs.chmodSync(path.join(ancestorRoot, 'usr', 'local'), 0o777);
    expect(checkAncestors(safeDestination)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('destination ancestor is unsafe'),
    });
    fs.chmodSync(path.join(ancestorRoot, 'usr', 'local'), 0o755);
    const realParent = path.join(ancestorRoot, 'real-parent');
    fs.mkdirSync(realParent, { mode: 0o755 });
    fs.symlinkSync(realParent, path.join(ancestorRoot, 'symbolic-parent'));
    expect(checkAncestors(path.join(ancestorRoot, 'symbolic-parent', 'state-view')))
      .toMatchObject({
        status: 1,
        stderr: expect.stringContaining('destination ancestor is unsafe'),
      });

    const helper = upgradeBlock.match(
      /(require_installed_backup_verifier_pair\(\) \{[\s\S]*?\n\})\n\nrequire_immutable_candidate/u,
    )?.[1];
    expect(helper).toBeTruthy();
    const oldTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'old-controller-'));
    temporaryRoots.push(oldTarget);
    const execute = (mode: 'initial' | 'upgrade' | 'rollback') => spawnSync(
      'bash',
      ['-c', `
set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
${helper}
CONTROL_PLANE_MODE="$1"
require_installed_backup_verifier_pair "$2"
`, 'fixture', mode, oldTarget],
      { encoding: 'utf8' },
    );
    expect(execute('rollback').status).toBe(0);
    expect(execute('upgrade')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('lacks its installed-backup verifier'),
    });

    fs.mkdirSync(path.join(oldTarget, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(oldTarget, 'scripts', 'release-installed-backup-interface-check.mjs'),
      'checker\n',
    );
    fs.writeFileSync(
      path.join(oldTarget, 'scripts', 'lib', 'release-installed-backup-interface.mjs'),
      'module\n',
    );
    expect(execute('upgrade').status).toBe(0);
    fs.rmSync(
      path.join(oldTarget, 'scripts', 'lib', 'release-installed-backup-interface.mjs'),
    );
    expect(execute('rollback')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('partial installed-backup verifier'),
    });

    const activationMarker = runbook.indexOf('BACKUP-LIVENESS ACTIVATION REFUSED');
    const activationStart = runbook.lastIndexOf('```bash\n', activationMarker)
      + '```bash\n'.length;
    const activationEnd = runbook.indexOf('\n```', activationMarker);
    const livenessActivation = runbook.slice(activationStart, activationEnd);
    expect(activationMarker).toBeGreaterThan(blockEnd);
    expect(spawnSync('bash', ['-n'], { input: livenessActivation }).status).toBe(0);
    expect(livenessActivation).toContain('control-plane-finalization.json');
    expect(livenessActivation).toContain(
      'SERVICE=nexus-release-backup-liveness-force.service',
    );
    expect(livenessActivation).toContain('nexus-release-backup-liveness.service');
    expect(livenessActivation).not.toContain('eval ');

    const deferredHeader = runbook.indexOf('### Retained-old rollback poller restart');
    const deferredStart = runbook.indexOf('```bash\n', deferredHeader) + '```bash\n'.length;
    const deferredEnd = runbook.indexOf('\n```', deferredStart);
    const deferredRestart = runbook.slice(deferredStart, deferredEnd);
    expect(deferredHeader).toBeGreaterThan(blockEnd);
    expect(spawnSync('bash', ['-n'], { input: deferredRestart }).status).toBe(0);
    expect(deferredRestart).toContain('control-plane-finalization.json');
    expect(deferredRestart).toContain('pm2-fallback-retired.json');
    expect(deferredRestart).toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-post-gate.json',
    );
    expect(deferredRestart).toContain('exec 8>&-; exec 9>&-');
    expect(deferredRestart.indexOf('exec 8>&-; exec 9>&-'))
      .toBeLessThan(deferredRestart.indexOf('systemctl start "$POLLER_TIMER"'));
    expect(upgradeBlock).toContain('pollerRestartDeferred=%s');
    expect(upgradeBlock).toContain(
      'start_and_prove_post_gate_service nexus-release-backup-liveness-force.service',
    );
    expect(upgradeBlock).not.toContain(
      'start_and_prove_post_gate_service nexus-release-backup-liveness.service',
    );
  });

  it('admits only the exact legacy predecessor guard pair during upgrade', () => {
    const runbook = fs.readFileSync('ops/nexus-release/README.md', 'utf8');
    const sectionStart = runbook.indexOf('## 1a. Immutable control-plane install or upgrade');
    const blockStart = runbook.indexOf('```bash\n', sectionStart) + '```bash\n'.length;
    const blockEnd = runbook.indexOf('\n```', blockStart);
    const upgradeBlock = runbook.slice(blockStart, blockEnd);
    const guardHelpers = upgradeBlock.match(
      /(candidate_post_gate_guards_state\(\) \{[\s\S]*?\n\})\n\n(candidate_transaction_guards_state\(\) \{[\s\S]*?\n\})\n\nrequire_immutable_candidate/u,
    );
    const compatibilityHelper = upgradeBlock.match(
      /(selected_guard_pair_is_compatible\(\) \{[\s\S]*?\n\})\n\nrequire_installed_transaction_gate/u,
    )?.[1];
    const installedGate = upgradeBlock.match(
      /(require_installed_transaction_gate\(\) \{[\s\S]*?\n\})\n\nselector_or_absent/u,
    )?.[1];
    expect(guardHelpers).toBeTruthy();
    expect(compatibilityHelper).toBeTruthy();
    expect(installedGate).toBeTruthy();
    const compatibilityCall = installedGate!.indexOf('selected_guard_pair_is_compatible');
    const installedGuardReads = installedGate!.indexOf(
      'for unit in nexus-release-bootstrap.service',
    );
    expect(compatibilityCall).toBeGreaterThan(-1);
    expect(installedGuardReads).toBeGreaterThan(-1);
    expect(compatibilityCall).toBeLessThan(installedGuardReads);
    expect(upgradeBlock).toContain('require_installed_transaction_gate 1');

    const predecessorSha = '852116a7ee17562418779ee396095de2cd05e699';
    const repository = 'https://github.com/felipedrf74/cortex-telegram-hub-bot.git';
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-controller-guard-'));
    temporaryRoots.push(fixtureRoot);
    const versionRoot = path.join(fixtureRoot, 'control-plane');
    const predecessorRoot = path.join(versionRoot, predecessorSha);
    const predecessorUnitRoot = path.join(predecessorRoot, 'ops', 'nexus-release');
    fs.mkdirSync(predecessorUnitRoot, { recursive: true });
    const predecessorUnitHashes: Record<string, string> = {
      'nexus-release-bootstrap.service':
        '8dcfbb1bb2e3f67ba4aa6b2591a85c1a2012cf84765021b5fcecfb1e7c6ae4a1',
      'nexus-release-poller.service':
        '81a527e9b9a66b12e5eb6ac8bd58a49b81e85ec91ed4705dd0f3680f3c9c5097',
      'nexus-release-heartbeat.service':
        '07a73b5aee2c5b9fe0782c76060aa533518a6f4346af2a428705f5e87982ba01',
    };
    for (const [unit, expectedHash] of Object.entries(predecessorUnitHashes)) {
      const historical = spawnSync(
        'git',
        ['show', `${predecessorSha}:ops/nexus-release/${unit}`],
        { encoding: 'utf8' },
      );
      expect(historical.status, historical.stderr).toBe(0);
      expect(sha256(Buffer.from(historical.stdout))).toBe(expectedHash);
      fs.writeFileSync(path.join(predecessorUnitRoot, unit), historical.stdout);
    }
    fs.writeFileSync(
      path.join(predecessorRoot, '.nexus-control-plane-ready'),
      `${predecessorSha} ${repository} /usr/bin/node:v22.23.1\n`,
    );

    const classify = (name: string, root: string) => spawnSync(
      'bash',
      ['-c', `
set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
candidate_liveness_pair_state() { printf 'absent\\n'; }
${guardHelpers![1]}
${guardHelpers![2]}
"$1" "$2"
`, 'fixture', name, root],
      { encoding: 'utf8' },
    );
    const postGateState = classify(
      'candidate_post_gate_guards_state',
      predecessorRoot,
    );
    const transactionState = classify(
      'candidate_transaction_guards_state',
      predecessorRoot,
    );
    expect(postGateState).toMatchObject({ status: 0, stdout: 'absent\n' });
    expect(transactionState).toMatchObject({ status: 0, stdout: 'legacy\n' });

    const compatible = (
      mode: 'initial' | 'upgrade' | 'rollback',
      active: string,
      postGate: string,
      transaction: string,
      markerMetadata = 'root:root:444:1',
    ) => spawnSync('bash', ['-c', `
set -euo pipefail
CONTROL_PLANE_MODE="$1"
VERSION_ROOT="$2"
LEGACY_UPGRADE_PREDECESSOR_SHA="$3"
SOURCE_REPOSITORY="$4"
LEGACY_UPGRADE_PREDECESSOR_MARKER="$LEGACY_UPGRADE_PREDECESSOR_SHA $SOURCE_REPOSITORY /usr/bin/node:v22.23.1"
MARKER_METADATA="$8"
stat() { printf '%s\\n' "$MARKER_METADATA"; }
${compatibilityHelper!}
selected_guard_pair_is_compatible "$5" "$6" "$7"
`, 'fixture', mode, versionRoot, predecessorSha, repository,
    active, postGate, transaction, markerMetadata], { encoding: 'utf8' });

    expect(compatible(
      'upgrade',
      predecessorRoot,
      postGateState.stdout.trim(),
      transactionState.stdout.trim(),
    ).status).toBe(0);
    expect(compatible('upgrade', fixtureRoot, 'present', 'present').status).toBe(0);
    for (const [postGate, transaction] of [
      ['present', 'legacy'],
      ['absent', 'present'],
      ['legacy', 'legacy'],
    ]) {
      expect(compatible('upgrade', predecessorRoot, postGate, transaction).status)
        .not.toBe(0);
    }

    const otherRoot = path.join(versionRoot, '8'.repeat(40));
    fs.mkdirSync(otherRoot, { recursive: true });
    fs.copyFileSync(
      path.join(predecessorRoot, '.nexus-control-plane-ready'),
      path.join(otherRoot, '.nexus-control-plane-ready'),
    );
    expect(compatible('upgrade', otherRoot, 'absent', 'legacy').status).not.toBe(0);
    fs.writeFileSync(
      path.join(predecessorRoot, '.nexus-control-plane-ready'),
      'marker drift\n',
    );
    expect(compatible('upgrade', predecessorRoot, 'absent', 'legacy').status)
      .not.toBe(0);
    fs.writeFileSync(
      path.join(predecessorRoot, '.nexus-control-plane-ready'),
      `${predecessorSha} ${repository} /usr/bin/node:v22.23.1\n`,
    );
    expect(compatible(
      'upgrade',
      predecessorRoot,
      'absent',
      'legacy',
      'root:root:640:1',
    ).status).not.toBe(0);
    const markerTarget = path.join(predecessorRoot, '.marker-target');
    fs.renameSync(path.join(predecessorRoot, '.nexus-control-plane-ready'), markerTarget);
    fs.symlinkSync(markerTarget, path.join(predecessorRoot, '.nexus-control-plane-ready'));
    expect(compatible('upgrade', predecessorRoot, 'absent', 'legacy').status)
      .not.toBe(0);
    expect(compatible('rollback', predecessorRoot, 'absent', 'legacy').status).toBe(0);
    expect(compatible('rollback', otherRoot, 'legacy', 'present').status).toBe(0);

    const partialTransactionRoot = path.join(fixtureRoot, 'partial-transaction');
    fs.cpSync(predecessorRoot, partialTransactionRoot, { recursive: true });
    fs.appendFileSync(
      path.join(
        partialTransactionRoot,
        'ops/nexus-release/nexus-release-heartbeat.service',
      ),
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json\n',
    );
    expect(classify('candidate_transaction_guards_state', partialTransactionRoot))
      .toMatchObject({
        status: 1,
        stderr: expect.stringContaining('partial transaction symlink guards'),
      });

    const partialPostGateRoot = path.join(fixtureRoot, 'partial-post-gate');
    fs.cpSync(predecessorRoot, partialPostGateRoot, { recursive: true });
    fs.appendFileSync(
      path.join(
        partialPostGateRoot,
        'ops/nexus-release/nexus-release-bootstrap.service',
      ),
      [
        'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-post-gate.json',
        'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json',
        '',
      ].join('\n'),
    );
    expect(classify('candidate_post_gate_guards_state', partialPostGateRoot))
      .toMatchObject({
        status: 1,
        stderr: expect.stringContaining('partial post-gate workload guard'),
      });
  });
});
