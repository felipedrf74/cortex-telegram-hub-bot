import {
  createHash,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  stopGuest,
  validateControllerJournal,
} from '../../scripts/release-layout-fault-drill-controller.mjs';

const guestExecutor = path.resolve(
  'scripts/release-layout-fault-drill-guest.mjs',
);
const controller = path.resolve(
  'scripts/release-layout-fault-drill-controller.mjs',
);
const verifier = path.resolve('scripts/release-layout-fault-drill.mjs');
const controllerUnit = path.resolve(
  'ops/rollback-drill-vm/systemd/'
  + 'nexus-release-layout-fault-drill@.service',
);
const controllerRecoveryUnit = path.resolve(
  'ops/rollback-drill-vm/systemd/'
  + 'nexus-release-layout-fault-drill-recovery.service',
);

const scenarios = [
  'failed_health_check',
  'host_reboot_during_migration',
  'ssh_disconnect_after_pm2_stop',
] as const;
const guestIds = {
  failed_health_check: 'guest-2',
  host_reboot_during_migration: 'guest-3',
  ssh_disconnect_after_pm2_stop: 'guest-1',
} as const;

const roots: string[] = [];
const fixtureProcessRoots = new Set<string>();
afterEach(() => {
  for (const fixtureRoot of fixtureProcessRoots) {
    for (const pid of fixtureProcessIds(fixtureRoot)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The recovery or cleanup path already reaped the process.
      }
    }
  }
  fixtureProcessRoots.clear();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

const sha256 = (input: Buffer | string) => (
  createHash('sha256').update(input).digest('hex')
);

function fixtureProcessIds(root: string): number[] {
  const marker = `nexus-release-layout-fixture-${sha256(path.resolve(root))}`;
  const processes = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  });
  if (processes.status !== 0) return [];
  return processes.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*([1-9][0-9]*)\s+(.*)$/u);
    return match?.[2].split(/\s+/u).includes(marker)
      ? [Number(match[1])]
      : [];
  });
}

function waitForFixtureProcessCount(
  root: string,
  expected: number,
): number[] {
  const deadline = Date.now() + 5_000;
  let pids = fixtureProcessIds(root);
  while (pids.length !== expected && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    pids = fixtureProcessIds(root);
  }
  return pids;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

function createFlockHelper(root: string) {
  const helper = path.join(root, 'flock.py');
  fs.writeFileSync(
    helper,
    [
      '#!/usr/bin/python3',
      'import fcntl,sys',
      'try:',
      '    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)',
      'except BlockingIOError:',
      '    raise SystemExit(1)',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return helper;
}

function createGuestHarness(
  root: string,
  {
    createdMs = Date.now(),
    expiresMs = createdMs + 60 * 60_000,
  }: { createdMs?: number; expiresMs?: number } = {},
) {
  const stateRoot = path.join(root, 'state');
  const recoveryUnit = path.join(root, 'guest-recovery.service');
  const fakeSystemctl = path.join(root, 'systemctl');
  const fakeFlock = createFlockHelper(root);
  fs.writeFileSync(
    recoveryUnit,
    '[Service]\nType=oneshot\nExecStart=/bin/true\n',
    { mode: 0o644 },
  );
  fs.writeFileSync(
    fakeSystemctl,
    '#!/usr/bin/env bash\n[ "$1" = reboot ]\n',
    { mode: 0o755 },
  );
  const keys = Object.fromEntries(scenarios.map((scenario) => {
    const key = generateKeyPairSync('ed25519');
    const privateFile = path.join(root, `${scenario}.private.pem`);
    fs.writeFileSync(
      privateFile,
      key.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600 },
    );
    return [scenario, { ...key, privateFile }];
  })) as Record<
    (typeof scenarios)[number],
    ReturnType<typeof generateKeyPairSync> & { privateFile: string }
  >;
  const hypervisor = generateKeyPairSync('ed25519');
  const publicPem = (
    key: ReturnType<typeof generateKeyPairSync>['publicKey'],
  ) => key.export({ format: 'pem', type: 'spki' }).toString();
  const guestProducer = {
    executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
    executorSha256: sha256(fs.readFileSync(guestExecutor)),
    recoveryUnitPath:
      '/etc/systemd/system/'
      + 'nexus-release-layout-fault-guest-recovery.service',
    recoveryUnitSha256: sha256(fs.readFileSync(recoveryUnit)),
  };
  const plan = {
    schema: 'nexus.release-layout-fault-drill-plan.v1',
    planId: randomUUID(),
    migrationId: randomUUID(),
    challengeNonce: '1'.repeat(64),
    source: {
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
    },
    trust: {
      trustManifestSha256: '7'.repeat(64),
      provisionSetId: '8'.repeat(64),
      provisionReceiptSha256: '9'.repeat(64),
      hypervisorEd25519PublicKey: publicPem(hypervisor.publicKey),
      guestEd25519PublicKeys: Object.fromEntries(
        scenarios.map((scenario) => [
          scenario,
          publicPem(keys[scenario].publicKey),
        ]),
      ),
      guestIds,
      producers: {
        hypervisor: {
          controllerPath:
            '/usr/local/libexec/nexus-rollback-drill-vm/'
            + 'release-layout-fault-controller',
          controllerSha256: 'a'.repeat(64),
          controllerRecoveryUnitPath:
            '/etc/systemd/system/'
            + 'nexus-release-layout-fault-drill-recovery.service',
          controllerRecoveryUnitSha256: 'd'.repeat(64),
          controllerUnitPath:
            '/etc/systemd/system/'
            + 'nexus-release-layout-fault-drill@.service',
          controllerUnitSha256: 'b'.repeat(64),
          verifierPath:
            '/usr/local/libexec/nexus-rollback-drill-vm/'
            + 'release-layout-fault-drill.mjs',
          verifierSha256: 'c'.repeat(64),
        },
        guests: Object.fromEntries(
          scenarios.map((scenario) => [scenario, guestProducer]),
        ),
      },
    },
    execution: {
      mode: 'strictly-sequential',
      maximumActiveGuests: 1,
      isolatedKvmRequired: true,
      independentOverlayRequired: true,
      productionDataForbidden: true,
      productionKeysForbidden: true,
      automaticProtectedApproval: false,
    },
    scenarios: scenarios.map((scenario, index) => ({
      id: scenario,
      order: index + 1,
      fault: scenario,
      expectedTerminalStatus: 'recovered',
      productionEvidenceAllowed: false,
    })),
    promotionAllowed: false,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
  const planFile = path.join(root, 'plan.json');
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, {
    mode: 0o600,
  });
  for (const scenario of scenarios) {
    fixtureProcessRoots.add(path.join(
      stateRoot,
      plan.planId,
      scenario,
      'fixture',
    ));
  }
  const environment = (
    scenario: (typeof scenarios)[number],
    overrides: Record<string, string | undefined> = {},
  ) => ({
    ...process.env,
    NODE_ENV: 'test',
    NEXUS_RELEASE_FAULT_GUEST_TEST_MODE: '1',
    NEXUS_RELEASE_FAULT_GUEST_TEST_DEFER: '1',
    NEXUS_RELEASE_FAULT_GUEST_STATE_ROOT: stateRoot,
    NEXUS_RELEASE_FAULT_GUEST_PRIVATE_KEY:
      keys[scenario].privateFile,
    NEXUS_RELEASE_FAULT_GUEST_RECOVERY_UNIT: recoveryUnit,
    NEXUS_RELEASE_FAULT_GUEST_SYSTEMCTL: fakeSystemctl,
    NEXUS_RELEASE_FAULT_GUEST_SYSTEMD_RUN: '/usr/bin/false',
    NEXUS_RELEASE_FAULT_GUEST_FLOCK: fakeFlock,
    NEXUS_RELEASE_FAULT_GUEST_ID: guestIds[scenario],
    NEXUS_RELEASE_FAULT_GUEST_TEST_BOOT_ID:
      '11111111-2222-3333-4444-555555555555',
    ...overrides,
  });
  const command = (
    scenario: (typeof scenarios)[number],
    args: string[],
    overrides: Record<string, string | undefined> = {},
  ) => spawnSync(
    process.execPath,
    [guestExecutor, ...args],
    {
      encoding: 'utf8',
      env: environment(scenario, overrides),
    },
  );
  return { command, environment, plan, planFile, stateRoot };
}

describe('trusted release-layout fault producers', () => {
  it('executes and recovers all three fixed guest fault transactions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fault-guest-'));
    roots.push(root);
    const stateRoot = path.join(root, 'state');
    const recoveryUnit = path.join(root, 'guest-recovery.service');
    const fakeSystemctl = path.join(root, 'systemctl');
    const fakeFlock = createFlockHelper(root);
    fs.writeFileSync(
      recoveryUnit,
      '[Service]\nType=oneshot\nExecStart=/bin/true\n',
      { mode: 0o644 },
    );
    fs.writeFileSync(
      fakeSystemctl,
      '#!/usr/bin/env bash\n[ "$1" = reboot ]\n',
      { mode: 0o755 },
    );
    const keys = Object.fromEntries(scenarios.map((scenario) => {
      const key = generateKeyPairSync('ed25519');
      const privateFile = path.join(root, `${scenario}.private.pem`);
      fs.writeFileSync(
        privateFile,
        key.privateKey.export({ format: 'pem', type: 'pkcs8' }),
        { mode: 0o600 },
      );
      return [scenario, { ...key, privateFile }];
    })) as Record<
      (typeof scenarios)[number],
      ReturnType<typeof generateKeyPairSync> & { privateFile: string }
    >;
    const hypervisor = generateKeyPairSync('ed25519');
    const publicPem = (
      key: ReturnType<typeof generateKeyPairSync>['publicKey'],
    ) => key.export({ format: 'pem', type: 'spki' }).toString();
    const guestProducer = {
      executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
      executorSha256: sha256(fs.readFileSync(guestExecutor)),
      recoveryUnitPath:
        '/etc/systemd/system/'
        + 'nexus-release-layout-fault-guest-recovery.service',
      recoveryUnitSha256: sha256(fs.readFileSync(recoveryUnit)),
    };
    const createdAt = new Date().toISOString();
    const plan = {
      schema: 'nexus.release-layout-fault-drill-plan.v1',
      planId: randomUUID(),
      migrationId: randomUUID(),
      challengeNonce: '1'.repeat(64),
      source: {
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
      },
      trust: {
        trustManifestSha256: '7'.repeat(64),
        provisionSetId: '8'.repeat(64),
        provisionReceiptSha256: '9'.repeat(64),
        hypervisorEd25519PublicKey: publicPem(hypervisor.publicKey),
        guestEd25519PublicKeys: Object.fromEntries(
          scenarios.map((scenario) => [
            scenario,
            publicPem(keys[scenario].publicKey),
          ]),
        ),
        guestIds,
        producers: {
          hypervisor: {
            controllerPath:
              '/usr/local/libexec/nexus-rollback-drill-vm/'
              + 'release-layout-fault-controller',
            controllerSha256: 'a'.repeat(64),
            controllerRecoveryUnitPath:
              '/etc/systemd/system/'
              + 'nexus-release-layout-fault-drill-recovery.service',
            controllerRecoveryUnitSha256: 'd'.repeat(64),
            controllerUnitPath:
              '/etc/systemd/system/'
              + 'nexus-release-layout-fault-drill@.service',
            controllerUnitSha256: 'b'.repeat(64),
            verifierPath:
              '/usr/local/libexec/nexus-rollback-drill-vm/'
              + 'release-layout-fault-drill.mjs',
            verifierSha256: 'c'.repeat(64),
          },
          guests: Object.fromEntries(
            scenarios.map((scenario) => [scenario, guestProducer]),
          ),
        },
      },
      execution: {
        mode: 'strictly-sequential',
        maximumActiveGuests: 1,
        isolatedKvmRequired: true,
        independentOverlayRequired: true,
        productionDataForbidden: true,
        productionKeysForbidden: true,
        automaticProtectedApproval: false,
      },
      scenarios: scenarios.map((scenario, index) => ({
        id: scenario,
        order: index + 1,
        fault: scenario,
        expectedTerminalStatus: 'recovered',
        productionEvidenceAllowed: false,
      })),
      promotionAllowed: false,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 60 * 60_000).toISOString(),
    };
    const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, {
      mode: 0o600,
    });

    for (const scenario of scenarios) {
      fixtureProcessRoots.add(path.join(
        stateRoot,
        plan.planId,
        scenario,
        'fixture',
      ));
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        NEXUS_RELEASE_FAULT_GUEST_TEST_MODE: '1',
        NEXUS_RELEASE_FAULT_GUEST_TEST_DEFER: '1',
        NEXUS_RELEASE_FAULT_GUEST_STATE_ROOT: stateRoot,
        NEXUS_RELEASE_FAULT_GUEST_PRIVATE_KEY:
          keys[scenario].privateFile,
        NEXUS_RELEASE_FAULT_GUEST_RECOVERY_UNIT: recoveryUnit,
        NEXUS_RELEASE_FAULT_GUEST_SYSTEMCTL: fakeSystemctl,
        NEXUS_RELEASE_FAULT_GUEST_SYSTEMD_RUN: '/usr/bin/false',
        NEXUS_RELEASE_FAULT_GUEST_FLOCK: fakeFlock,
        NEXUS_RELEASE_FAULT_GUEST_ID: guestIds[scenario],
        NEXUS_RELEASE_FAULT_GUEST_TEST_BOOT_ID:
          '11111111-2222-3333-4444-555555555555',
      };
      const run = (...args: string[]) => spawnSync(
        process.execPath,
        [guestExecutor, ...args],
        { encoding: 'utf8', env },
      );
      const staged = run('stage', planFile, scenario);
      expect(staged.status, staged.stderr).toBe(0);
      const faulted = run('run', plan.planId, scenario);
      expect(faulted.status, faulted.stderr).toBe(0);
      if (scenario !== 'failed_health_check') {
        expect(faulted.stdout).toContain(
          `NEXUS_RELEASE_LAYOUT_FAULT_ARMED ${plan.planId} ${scenario}`,
        );
        const resumed = run('resume', plan.planId, scenario);
        expect(resumed.status, resumed.stderr).toBe(0);
      }
      const fetched = run('fetch', plan.planId, scenario);
      expect(fetched.status, fetched.stderr).toBe(0);
      expect(JSON.parse(fetched.stdout)).toMatchObject({
        ok: true,
        status: 'recovered',
        planId: plan.planId,
        scenarioId: scenario,
      });
      const journal = JSON.parse(fs.readFileSync(path.join(
        stateRoot,
        plan.planId,
        scenario,
        'journal.v1.json',
      ), 'utf8'));
      expect(journal).toMatchObject({
        status: 'recovered',
        testMode: true,
        observations: {
          processStoppedObserved: true,
          durableRecoveryArmed: true,
          healthRestored: true,
          candidateHealthFailureObserved:
            scenario === 'failed_health_check',
        },
      });
      expect(journal.observations.restoredSha256).toBe(
        journal.observations.predecessorSha256,
      );
      expect(journal.observations.databaseAfterSha256).toBe(
        journal.observations.databaseBeforeSha256,
      );
      expect(fs.realpathSync(journal.fixture.current)).toBe(
        fs.realpathSync(journal.fixture.predecessor),
      );

      const observer = path.join(root, `${scenario}.observer.json`);
      fs.writeFileSync(observer, `${JSON.stringify({
        bootId: '11111111-2222-3333-4444-555555555555',
        startMonotonicMilliseconds: 100,
        endMonotonicMilliseconds: 200,
        durationMilliseconds: 100,
        targetMilliseconds: 120000,
      })}\n`, { mode: 0o600 });
      const sealed = run('seal', plan.planId, scenario, observer);
      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain(
        'only a real recovered production-mode guest transaction can be sealed',
      );
      const cleaned = run('cleanup', plan.planId, scenario);
      expect(cleaned.status, cleaned.stderr).toBe(0);
    }
  }, 30_000);

  it('has no manual result-recording surface and binds the root controller unit', () => {
    const manualRecord = spawnSync(
      process.execPath,
      [verifier, 'record', '--output', '/tmp/never-created'],
      { encoding: 'utf8' },
    );
    expect(manualRecord.status).not.toBe(0);
    expect(manualRecord.stderr).toContain(
      'expected prepare, collect, verify-result, verify-drill, verify-plan, '
      + 'verify-envelope, or version',
    );
    const controllerSource = fs.readFileSync(controller, 'utf8');
    expect(controllerSource).toContain("'verify-plan'");
    expect(controllerSource).toContain("'verify-result'");
    expect(controllerSource).toContain("'verify-drill'");
    expect(controllerSource).toContain(
      "'nexus.release-layout-fault-controller-journal.v2'",
    );
    expect(controllerSource).toContain("'--allow-expired-recovery'");
    expect(controllerSource).toContain("'recover-if-present'");
    expect(controllerSource).toContain('acquireControllerLock()');
    expect(controllerSource).toContain('releaseControllerLock(lock)');
    expect(controllerSource).toContain('function recoverAll()');
    const unit = fs.readFileSync(controllerUnit, 'utf8');
    expect(unit).toContain(
      'ExecStart=/usr/local/libexec/nexus-rollback-drill-vm/'
      + 'release-layout-fault-controller run %i',
    );
    expect(unit).not.toContain('[Install]');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('Wants=dev-kvm.device');
    expect(unit).toContain('After=systemd-tmpfiles-setup.service dev-kvm.device');
    expect(unit).toContain(
      'ReadOnlyPaths=/etc/nexus-release '
      + '/var/lib/nexus-rollback-drill-vm/active.json '
      + '/var/lib/nexus-rollback-drill-vm/'
      + 'release-layout-evidence-trust.v1.json '
      + '/var/lib/nexus-rollback-drill-vm/sets',
    );
    expect(unit).not.toMatch(
      /^ReadWritePaths=.*\/var\/lib\/nexus-rollback-drill-vm\/sets/mu,
    );
    const recoveryUnit = fs.readFileSync(controllerRecoveryUnit, 'utf8');
    expect(recoveryUnit).toContain(
      'release-layout-fault-controller recover-all',
    );
    expect(recoveryUnit).toContain('WantedBy=multi-user.target');
    expect(recoveryUnit).toContain('Wants=dev-kvm.device');
    expect(recoveryUnit).toContain('Restart=on-failure');
    expect(recoveryUnit).toContain('StartLimitBurst=4');
    const guestRecoveryUnit = fs.readFileSync(
      path.resolve(
        'ops/rollback-drill-vm/systemd/'
        + 'nexus-release-layout-fault-drill-guest-recovery.service',
      ),
      'utf8',
    );
    expect(guestRecoveryUnit).toContain('Restart=on-failure');
    expect(guestRecoveryUnit).toContain('StartLimitBurst=4');
  });

  it('keeps an unverified guest stop nonterminal and proves PID absence', () => {
    const guest = { unit: 'nexus-rollback-drill-vm@guest-1.service' };
    const activeState = [
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'MainPID=4242',
      '',
    ].join('\n');
    const calls: string[][] = [];
    const invoke = (
      _executable: string,
      args: string[],
    ) => {
      calls.push(args);
      if (args[0] === 'stop') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: activeState, stderr: '' };
    };
    expect(stopGuest(guest, {
      invoke,
      pidExists: (pid: number) => pid === 4242,
    })).toBe(false);
    expect(calls.map((args) => args[0])).toEqual(['show', 'stop', 'show']);

    const inactiveState = [
      'LoadState=loaded',
      'ActiveState=inactive',
      'SubState=dead',
      'MainPID=0',
      '',
    ].join('\n');
    let showCount = 0;
    const stateVerifiedDespiteStopExit = (
      _executable: string,
      args: string[],
    ) => {
      if (args[0] === 'stop') return { status: 1, stdout: '', stderr: '' };
      showCount += 1;
      return {
        status: 0,
        stdout: showCount === 1 ? activeState : inactiveState,
        stderr: '',
      };
    };
    expect(stopGuest(guest, {
      invoke: stateVerifiedDespiteStopExit,
      pidExists: () => false,
    })).toBe(true);

    const source = fs.readFileSync(controller, 'utf8');
    expect(source).toContain('return recovered && stopped');
    expect(source).toContain(
      "status: recovered ? terminalStatus : 'recovery_required'",
    );
    expect(source).toContain(
      'activeGuest: recovered ? null : journal.activeGuest',
    );
  });

  it('rejects terminal or recovery journals that lose required evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fault-journal-'));
    roots.push(root);
    const { plan } = createGuestHarness(root);
    const timestamp = plan.createdAt;
    const journal = {
      schema: 'nexus.release-layout-fault-controller-journal.v2',
      status: 'submitted',
      phase: 'idle',
      planId: plan.planId,
      planSha256: sha256(Buffer.from(canonicalJson(plan), 'utf8')),
      authenticatedAt: timestamp,
      expiresAt: plan.expiresAt,
      trustManifestSha256: plan.trust.trustManifestSha256,
      provisionReceiptSha256: plan.trust.provisionReceiptSha256,
      executionMode: 'strictly-sequential',
      maximumActiveGuests: 1,
      controllerBootId: '11111111-2222-3333-4444-555555555555',
      completedScenarios: [],
      activeGuest: null,
      scenarioState: null,
      failure: null,
      drillSha256: null,
      submittedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    expect(validateControllerJournal(journal, plan)).toEqual(journal);

    expect(() => validateControllerJournal({
      ...journal,
      status: 'completed',
      phase: 'completed',
      drillSha256: 'e'.repeat(64),
      completedAt: timestamp,
    }, plan)).toThrow('controller journal state is invalid');

    const recoveryRequired = {
      ...journal,
      status: 'recovery_required',
      phase: 'recovery_required',
      failure: {
        at: timestamp,
        messageSha256: 'f'.repeat(64),
      },
    };
    expect(() => validateControllerJournal(
      recoveryRequired,
      plan,
    )).toThrow('controller journal state is invalid');

    expect(validateControllerJournal({
      ...recoveryRequired,
      activeGuest: {
        name: 'guest-1',
        port: 2201,
        unit: 'nexus-rollback-drill-vm@guest-1.service',
      },
    }, plan)).toMatchObject({
      status: 'recovery_required',
      activeGuest: { name: 'guest-1' },
    });

    expect(() => validateControllerJournal({
      ...journal,
      status: 'running',
      phase: 'guest_started',
      activeGuest: null,
      scenarioState: {
        scenarioId: 'ssh_disconnect_after_pm2_stop',
        beforeGuestBootId: '11111111-2222-3333-4444-555555555555',
        observerBootId: '11111111-2222-3333-4444-555555555555',
        observerStartMonotonicMilliseconds: 1,
        connectionDropped: false,
      },
    }, plan)).toThrow('controller journal state is invalid');
  });

  it('discovers and terminates a live pre-journal fixture orphan', () => {
    const root = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'nexus-fault-spawn-orphan-',
    ));
    roots.push(root);
    const harness = createGuestHarness(root);
    const scenario = 'ssh_disconnect_after_pm2_stop';
    const staged = harness.command(
      scenario,
      ['stage', harness.planFile, scenario],
    );
    expect(staged.status, staged.stderr).toBe(0);

    const fixtureRoot = path.join(
      harness.stateRoot,
      harness.plan.planId,
      scenario,
      'fixture',
    );
    fixtureProcessRoots.add(fixtureRoot);
    const crashed = harness.command(
      scenario,
      ['run', harness.plan.planId, scenario],
      {
        NEXUS_RELEASE_FAULT_GUEST_TEST_CRASH_POINT:
          'after_predecessor_spawn_before_journal',
      },
    );
    expect(crashed.status, crashed.stderr).toBe(96);
    expect(fs.existsSync(path.join(fixtureRoot, 'fixture.pid'))).toBe(false);
    const orphanPids = waitForFixtureProcessCount(fixtureRoot, 1);
    expect(orphanPids).toHaveLength(1);

    const resumed = harness.command(
      scenario,
      ['resume', harness.plan.planId, scenario],
    );
    expect(resumed.status, resumed.stderr).toBe(0);
    const recoveredPids = waitForFixtureProcessCount(fixtureRoot, 1);
    expect(recoveredPids).toHaveLength(1);
    expect(recoveredPids).not.toContain(orphanPids[0]);
    expect(Number(fs.readFileSync(
      path.join(fixtureRoot, 'fixture.pid'),
      'utf8',
    ).trim())).toBe(recoveredPids[0]);
    const fetched = harness.command(
      scenario,
      ['fetch', harness.plan.planId, scenario],
    );
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toMatchObject({
      ok: true,
      status: 'recovered',
    });

    const cleaned = harness.command(
      scenario,
      ['cleanup', harness.plan.planId, scenario],
    );
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(waitForFixtureProcessCount(fixtureRoot, 0)).toEqual([]);
    fixtureProcessRoots.delete(fixtureRoot);
  }, 30_000);

  it.each([
    ['after_prepared_journal', 'ssh_disconnect_after_pm2_stop'],
    ['after_wal_before_fixture', 'ssh_disconnect_after_pm2_stop'],
    ['after_fixture_directory_create', 'ssh_disconnect_after_pm2_stop'],
    ['after_fixture_release_write', 'ssh_disconnect_after_pm2_stop'],
    ['after_fixture_database_create', 'ssh_disconnect_after_pm2_stop'],
    ['after_fixture_backup_write', 'ssh_disconnect_after_pm2_stop'],
    ['after_fixture_initialized', 'ssh_disconnect_after_pm2_stop'],
    ['after_predecessor_spawn_journal_before_pid', 'ssh_disconnect_after_pm2_stop'],
    ['after_predecessor_pid_write', 'ssh_disconnect_after_pm2_stop'],
    ['after_predecessor_start', 'ssh_disconnect_after_pm2_stop'],
    ['after_process_stop', 'ssh_disconnect_after_pm2_stop'],
    ['after_selector_switch', 'ssh_disconnect_after_pm2_stop'],
    ['after_database_mutation', 'ssh_disconnect_after_pm2_stop'],
    ['after_recovery_selector_restore', 'failed_health_check'],
    ['after_recovery_database_restore', 'failed_health_check'],
    ['after_recovery_process_start', 'failed_health_check'],
    ['before_recovered_journal', 'failed_health_check'],
  ] as const)(
    'recovers idempotently from the %s crash window',
    (crashPoint, scenario) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fault-crash-'));
      roots.push(root);
      const harness = createGuestHarness(root);
      const staged = harness.command(
        scenario,
        ['stage', harness.planFile, scenario],
      );
      expect(staged.status, staged.stderr).toBe(0);
      const crashed = harness.command(
        scenario,
        ['run', harness.plan.planId, scenario],
        { NEXUS_RELEASE_FAULT_GUEST_TEST_CRASH_POINT: crashPoint },
      );
      expect(crashed.status, crashed.stderr).toBe(96);

      const resumed = harness.command(
        scenario,
        ['resume', harness.plan.planId, scenario],
      );
      expect(resumed.status, resumed.stderr).toBe(0);
      const fetched = harness.command(
        scenario,
        ['fetch', harness.plan.planId, scenario],
      );
      expect(fetched.status, fetched.stderr).toBe(0);
      expect(JSON.parse(fetched.stdout)).toMatchObject({
        ok: true,
        status: 'recovered',
      });
      const journal = JSON.parse(fs.readFileSync(path.join(
        harness.stateRoot,
        harness.plan.planId,
        scenario,
        'journal.v1.json',
      ), 'utf8'));
      expect(journal).toMatchObject({
        schema: 'nexus.release-layout-fault-guest-journal.v2',
        status: 'recovered',
        phase: 'recovered',
        observations: {
          healthRestored: true,
        },
      });
      expect(journal.observations.restoredSha256).toBe(
        journal.observations.predecessorSha256,
      );
      expect(journal.observations.databaseAfterSha256).toBe(
        journal.observations.databaseBeforeSha256,
      );
      const cleaned = harness.command(
        scenario,
        ['cleanup', harness.plan.planId, scenario],
      );
      expect(cleaned.status, cleaned.stderr).toBe(0);
    },
    30_000,
  );

  it('serializes guest mutation and recovery with a no-follow kernel lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fault-lock-'));
    roots.push(root);
    const harness = createGuestHarness(root);
    const scenario = 'ssh_disconnect_after_pm2_stop';
    const signal = path.join(root, 'lock-acquired');
    const first = spawn(
      process.execPath,
      [guestExecutor, 'stage', harness.planFile, scenario],
      {
        encoding: 'utf8',
        env: harness.environment(scenario, {
          NEXUS_RELEASE_FAULT_GUEST_TEST_HOLD_LOCK_MS: '1500',
          NEXUS_RELEASE_FAULT_GUEST_TEST_LOCK_SIGNAL: signal,
        }),
      },
    );
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(signal) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(signal)).toBe(true);
    const contended = harness.command(
      scenario,
      ['stage', harness.planFile, scenario],
    );
    expect(contended.status).not.toBe(0);
    expect(contended.stderr).toContain(
      'another guest mutation or recovery transaction holds the lock',
    );
    const [status] = await once(first, 'close');
    expect(status).toBe(0);
    const lock = path.join(harness.stateRoot, 'mutation.lock');
    const identity = fs.lstatSync(lock);
    expect(identity.isSymbolicLink()).toBe(false);
    expect(identity.mode & 0o7777).toBe(0o600);
    expect(identity.nlink).toBe(1);
  }, 15_000);

  it('recovers an authenticated armed journal after expiry but forbids new work', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fault-expiry-'));
    roots.push(root);
    const createdMs = Date.parse('2026-07-25T12:00:00.000Z');
    const expiresMs = createdMs + 60_000;
    const activeNow = String(createdMs + 1_000);
    const expiredNow = String(expiresMs + 1);
    const harness = createGuestHarness(root, { createdMs, expiresMs });
    const recoveryScenario = 'ssh_disconnect_after_pm2_stop';
    const unstartedScenario = 'host_reboot_during_migration';
    for (const scenario of [recoveryScenario, unstartedScenario] as const) {
      const staged = harness.command(
        scenario,
        ['stage', harness.planFile, scenario],
        { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: activeNow },
      );
      expect(staged.status, staged.stderr).toBe(0);
    }
    const armed = harness.command(
      recoveryScenario,
      ['run', harness.plan.planId, recoveryScenario],
      { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: activeNow },
    );
    expect(armed.status, armed.stderr).toBe(0);
    const recovered = harness.command(
      recoveryScenario,
      ['resume', harness.plan.planId, recoveryScenario],
      { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: expiredNow },
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    const fetched = harness.command(
      recoveryScenario,
      ['fetch', harness.plan.planId, recoveryScenario],
      { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: expiredNow },
    );
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout).status).toBe('recovered');

    const newFault = harness.command(
      unstartedScenario,
      ['run', harness.plan.planId, unstartedScenario],
      { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: expiredNow },
    );
    expect(newFault.status).not.toBe(0);
    expect(newFault.stderr).toContain('drill plan lifetime is invalid');
    const observer = path.join(root, 'observer.json');
    fs.writeFileSync(observer, '{}\n', { mode: 0o600 });
    const sealed = harness.command(
      recoveryScenario,
      ['seal', harness.plan.planId, recoveryScenario, observer],
      { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: expiredNow },
    );
    expect(sealed.status).not.toBe(0);
    expect(sealed.stderr).toContain('drill plan lifetime is invalid');
    const cleaned = harness.command(
      recoveryScenario,
      ['cleanup', harness.plan.planId, recoveryScenario],
      { NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS: expiredNow },
    );
    expect(cleaned.status, cleaned.stderr).toBe(0);
    const fixtureRoot = path.join(
      harness.stateRoot,
      harness.plan.planId,
      recoveryScenario,
      'fixture',
    );
    expect(waitForFixtureProcessCount(fixtureRoot, 0)).toEqual([]);
  });
});
