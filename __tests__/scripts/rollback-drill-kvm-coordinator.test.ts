import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildLocalExecutionPlan,
  buildRollbackRequest,
  collectBundle,
  verifyBundle,
  validateDrillOutcome,
  validateIsolationEvidence,
  validateOwnerAuthorization,
  validatePlan,
} from '../../scripts/lib/rollback-drill-kvm-evidence.mjs';
import {
  makeKvmDrillFixture,
  writeKvmDrillFixture,
} from './helpers/rollback-drill-kvm-fixture';

const coordinator = path.resolve('scripts/rollback-drill-kvm-coordinator.mjs');
const keyArgsFor = (inputs: string) => [
  '--guest-owner-public-key', path.join(inputs, 'guest-owner.pem'),
  '--production-owner-public-key', path.join(inputs, 'production-owner.pem'),
  '--guest-ssh-client-public-key', path.join(inputs, 'guest-ssh-client.pub'),
  '--production-ssh-client-public-key', path.join(inputs, 'production-ssh-client.pub'),
  '--guest-ssh-host-public-key', path.join(inputs, 'guest-ssh-host.pub'),
  '--production-ssh-host-public-key', path.join(inputs, 'production-ssh-host.pub'),
  '--release-evidence-public-key', path.join(inputs, 'release-evidence.pem'),
];

describe('rollback-drill KVM coordinator and evidence bundle', () => {
  let root: string;
  let fixture: ReturnType<typeof makeKvmDrillFixture>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kvm-drill-'));
    fixture = makeKvmDrillFixture();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds a local-only plan over the three loopback-forwarded independent overlays', () => {
    expect(validatePlan(fixture.plan, { nowMs: fixture.nowMs })).toBe(fixture.plan);
    const plan = buildLocalExecutionPlan(fixture.plan, { nowMs: fixture.nowMs });

    expect(plan.executionSupported).toBe(false);
    expect(plan.refusalCode).toBe('execution_not_implemented');
    expect(plan.guarantees).toEqual(expect.objectContaining({
      loopbackSshOnly: true,
      independentOverlayRequired: true,
      productionKeysForbidden: true,
      productionDataForbidden: true,
      automaticProtectedApproval: false,
      productionGateMutation: false,
    }));
    expect(plan.drills.map((drill: any) => drill.drill)).toEqual([
      'ssh-loss',
      'failed-health',
      'guest-reboot',
    ]);
    expect(new Set(plan.drills.map((drill: any) => drill.overlayId)).size).toBe(3);
    expect(plan.drills.every((drill: any) => drill.endpoint.startsWith('127.0.0.1:')))
      .toBe(true);
    expect(JSON.stringify(plan)).toContain('/usr/local/sbin/nexus-release-promotion-control');
    expect(JSON.stringify(plan)).not.toContain('ServerDominguez');
  });

  it('rejects non-loopback and host-like SSH targets', () => {
    fixture.plan.overlays[0].ssh.host = 'ServerDominguez';
    expect(() => validatePlan(fixture.plan, { nowMs: fixture.nowMs }))
      .toThrow('ssh_target_not_loopback');
  });

  it('requires the production release floor of at least 12 GiB inside the drill guest', () => {
    const undersized = structuredClone(fixture.plan);
    undersized.guest.minimumMemoryAvailableBytes = 12 * 1024 ** 3 - 1;
    expect(() => validatePlan(undersized, { nowMs: fixture.nowMs }))
      .toThrow('guest_memory_threshold_invalid');
  });

  it('rejects production owner, SSH client, and SSH host key reuse', () => {
    for (const [guestField, productionField, expected] of [
      ['guestOwnerPublicKeySha256', 'productionOwnerPublicKeySha256', 'production_owner_key_reuse'],
      ['guestSshClientPublicKeySha256', 'productionSshClientPublicKeySha256', 'production_ssh_client_key_reuse'],
      ['guestSshHostPublicKeySha256', 'productionSshHostPublicKeySha256', 'production_ssh_host_key_reuse'],
    ] as const) {
      const changed = structuredClone(fixture.plan);
      changed.trust[productionField] = changed.trust[guestField];
      expect(() => validatePlan(changed, { nowMs: fixture.nowMs })).toThrow(expected);
    }
  });

  it('rejects unknown plan fields before any execution can be considered', () => {
    const changed = structuredClone(fixture.plan) as any;
    changed.allowProduction = true;
    expect(() => validatePlan(changed, { nowMs: fixture.nowMs }))
      .toThrow('plan_fields_invalid');
  });

  it('proves a distinct raw QEMU/KVM guest and rejects same-host identity', () => {
    expect(validateIsolationEvidence(
      fixture.isolation,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toBe(fixture.isolation);

    const sameHost = structuredClone(fixture.isolation);
    sameHost.guest.machineIdSha256 = fixture.plan.controller.machineIdSha256;
    expect(() => validateIsolationEvidence(
      sameHost,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toThrow('host_machine_id_target_rejected');
  });

  it('rejects missing KVM evidence, bridge networking, and shared guest mounts', () => {
    const noKvm = structuredClone(fixture.isolation);
    noKvm.guest.virtualization = 'none';
    expect(() => validateIsolationEvidence(
      noKvm,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toThrow('guest_kvm_platform_evidence_missing');

    const bridged = structuredClone(fixture.isolation);
    bridged.hypervisor.devices[1].mode = 'bridge';
    expect(() => validateIsolationEvidence(
      bridged,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toThrow('hypervisor_network_not_isolated');

    const shared = structuredClone(fixture.isolation);
    shared.guest.mounts.push({
      target: fixture.plan.release.productionBase,
      source: 'host:/home/dominguez/telegram-hub-bot',
      fileSystemType: 'virtiofs',
      options: ['rw'],
    });
    expect(() => validateIsolationEvidence(
      shared,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toThrow('shared_or_production_mount_detected');
  });

  it('rejects production-data matches and unknown isolation fields', () => {
    const productionData = structuredClone(fixture.isolation);
    productionData.guest.productionDataMatches = ['users:1'];
    expect(() => validateIsolationEvidence(
      productionData,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toThrow('production_data_detected');

    const unknown = structuredClone(fixture.isolation) as any;
    unknown.guest.hostRootMounted = false;
    expect(() => validateIsolationEvidence(
      unknown,
      fixture.plan,
      { nowMs: fixture.nowMs },
    )).toThrow('isolation_guest_fields_invalid');
  });

  it('binds explicit owner authorization to the exact plan, key, endpoints, and target', () => {
    expect(validateOwnerAuthorization(
      fixture.authorization,
      fixture.plan,
      fixture.keys.guestOwnerPublicKeyPem,
      { nowMs: fixture.nowMs },
    )).toBe(fixture.authorization);

    const tampered = structuredClone(fixture.authorization);
    tampered.payload.targetSha = 'a'.repeat(40);
    expect(() => validateOwnerAuthorization(
      tampered,
      fixture.plan,
      fixture.keys.guestOwnerPublicKeyPem,
      { nowMs: fixture.nowMs },
    )).toThrow('owner_authorization_target_mismatch');
  });

  it('rejects incomplete outcomes and outcome fields not in the versioned contract', () => {
    const incomplete = structuredClone(fixture.outcomes) as any;
    delete incomplete['failed-health'];
    expect(() => collectBundle(
      { ...fixture, outcomes: incomplete },
      path.join(root, 'incomplete-bundle'),
      { nowMs: fixture.nowMs },
    )).toThrow('drill_outcomes_fields_invalid');

    const unknown = structuredClone(fixture.outcomes['ssh-loss']) as any;
    unknown.notes = 'looked healthy';
    expect(() => validateDrillOutcome(
      unknown,
      fixture.plan,
      fixture.isolation,
      { nowMs: fixture.nowMs },
    )).toThrow('drill_outcome_fields_invalid');
  });

  it('rejects recovery beyond 120 seconds and a reboot without a changed guest boot id', () => {
    const slow = structuredClone(fixture.outcomes['failed-health']);
    const stopped = slow.timeline.find((entry: any) => entry.event === 'predecessor_stopped');
    const healthy = slow.timeline.find((entry: any) => entry.event === 'service_healthy');
    const terminal = slow.timeline.find((entry: any) => entry.event === 'terminal_observed');
    healthy.observerMonotonicMs = stopped.observerMonotonicMs + 120_001;
    terminal.observerMonotonicMs = healthy.observerMonotonicMs + 1;
    expect(() => validateDrillOutcome(
      slow,
      fixture.plan,
      fixture.isolation,
      { nowMs: fixture.nowMs },
    )).toThrow('drill_recovery_time_target_missed');

    const unchangedBoot = structuredClone(fixture.outcomes['guest-reboot']);
    for (const entry of unchangedBoot.timeline) {
      entry.guestBootIdSha256 = fixture.isolation.guest.bootIdSha256;
    }
    expect(() => validateDrillOutcome(
      unchangedBoot,
      fixture.plan,
      fixture.isolation,
      { nowMs: fixture.nowMs },
    )).toThrow('guest_reboot_boot_id_unchanged');
  });

  it('builds byte-deterministic bundles and maps both required digests into the existing request', () => {
    const first = collectBundle(
      fixture,
      path.join(root, 'bundle-one'),
      { nowMs: fixture.nowMs },
    );
    const second = collectBundle(
      fixture,
      path.join(root, 'bundle-two'),
      { nowMs: fixture.nowMs },
    );
    expect(first.manifest).toEqual(second.manifest);
    expect(first.machineEvidenceSha256).toBe(second.machineEvidenceSha256);

    const verified = verifyBundle(first.bundlePath, fixture.keys, { nowMs: fixture.nowMs });
    const request = buildRollbackRequest(verified, 'felipe');
    expect(Object.keys(request).sort()).toEqual([
      'backupContainsDatabase',
      'databaseIntegrity',
      'drilledAt',
      'dryRun',
      'healthCheck',
      'machineEvidenceSha256',
      'operator',
      'restoreMode',
      'result',
      'schema',
      'sourceSha',
      'sourceVersion',
      'targetBackup',
      'targetBackupSha256',
      'targetSha',
      'targetVersion',
    ].sort());
    expect(request.machineEvidenceSha256).toBe(first.machineEvidenceSha256);
    expect(request.targetBackupSha256).toBe(fixture.restore.releaseSha256);
    expect(request.targetBackup).toBe(fixture.plan.release.targetBackup);
  });

  it('detects bundle tampering, symlinks, and unexpected files', () => {
    const tampered = collectBundle(
      fixture,
      path.join(root, 'tampered-bundle'),
      { nowMs: fixture.nowMs },
    );
    const planPath = path.join(tampered.bundlePath, 'plan.json');
    const rawPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    rawPlan.release.targetVersion = '4.14.999';
    fs.writeFileSync(planPath, `${JSON.stringify(rawPlan)}\n`);
    expect(() => verifyBundle(tampered.bundlePath, fixture.keys, { nowMs: fixture.nowMs }))
      .toThrow();

    const linked = collectBundle(
      fixture,
      path.join(root, 'linked-bundle'),
      { nowMs: fixture.nowMs },
    );
    const restorePath = path.join(linked.bundlePath, 'restore.json');
    fs.unlinkSync(restorePath);
    fs.symlinkSync('plan.json', restorePath);
    expect(() => verifyBundle(linked.bundlePath, fixture.keys, { nowMs: fixture.nowMs }))
      .toThrow('bundle_restore_unsafe');

    const extra = collectBundle(
      fixture,
      path.join(root, 'extra-bundle'),
      { nowMs: fixture.nowMs },
    );
    fs.writeFileSync(path.join(extra.bundlePath, 'operator-notes.txt'), 'manual claim\n');
    expect(() => verifyBundle(extra.bundlePath, fixture.keys, { nowMs: fixture.nowMs }))
      .toThrow('bundle_layout_invalid');
  });

  it('collects, verifies, and emits an unsigned existing-schema request through the CLI', () => {
    const inputs = path.join(root, 'cli-inputs');
    writeKvmDrillFixture(inputs, fixture);
    const requestedBundle = path.join(root, 'cli-bundle');
    const collectResult = spawnSync(
      process.execPath,
      [
        coordinator,
        'collect',
        '--plan', path.join(inputs, 'plan.json'),
        '--authorization', path.join(inputs, 'authorization.json'),
        '--isolation', path.join(inputs, 'isolation.json'),
        '--restore', path.join(inputs, 'restore.json'),
        '--ssh-loss', path.join(inputs, 'ssh-loss.json'),
        '--failed-health', path.join(inputs, 'failed-health.json'),
        '--guest-reboot', path.join(inputs, 'guest-reboot.json'),
        ...keyArgsFor(inputs),
        '--output-dir', requestedBundle,
      ],
      { encoding: 'utf8' },
    );
    expect(collectResult.status, collectResult.stderr).toBe(0);
    const collected = JSON.parse(collectResult.stdout);
    expect(collected.machineEvidenceSha256).toMatch(/^[0-9a-f]{64}$/);

    const verifyResult = spawnSync(
      process.execPath,
      [
        coordinator,
        'verify',
        '--bundle', requestedBundle,
        ...keyArgsFor(inputs),
      ],
      { encoding: 'utf8' },
    );
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
    expect(JSON.parse(verifyResult.stdout).machineEvidenceSha256)
      .toBe(collected.machineEvidenceSha256);

    const requestPath = path.join(root, 'rollback-request.json');
    const requestResult = spawnSync(
      process.execPath,
      [
        coordinator,
        'request',
        '--bundle', requestedBundle,
        ...keyArgsFor(inputs),
        '--operator', 'felipe',
        '--output', requestPath,
      ],
      { encoding: 'utf8' },
    );
    expect(requestResult.status, requestResult.stderr).toBe(0);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    expect(request.schema).toBe('nexus.rollback-drill-payload.v1');
    expect(request.machineEvidenceSha256).toBe(collected.machineEvidenceSha256);
    expect(request.targetBackupSha256).toBe(fixture.restore.releaseSha256);
    expect(request).not.toHaveProperty('signature');
  });

  it('keeps --plan local and makes execute fail closed with no subprocess implementation', () => {
    const inputs = path.join(root, 'inputs');
    writeKvmDrillFixture(inputs, fixture);
    const planResult = spawnSync(
      process.execPath,
      [coordinator, '--plan', path.join(inputs, 'plan.json')],
      { encoding: 'utf8' },
    );
    expect(planResult.status).toBe(0);
    expect(JSON.parse(planResult.stdout)).toEqual(expect.objectContaining({
      ok: true,
      command: 'plan',
    }));
    expect(JSON.parse(planResult.stdout).executionPlan.executionSupported).toBe(false);

    const executeResult = spawnSync(
      process.execPath,
      [
        coordinator,
        'execute',
        '--plan', path.join(inputs, 'plan.json'),
        '--authorization', path.join(inputs, 'authorization.json'),
        '--isolation', path.join(inputs, 'isolation.json'),
        ...keyArgsFor(inputs),
      ],
      { encoding: 'utf8' },
    );
    expect(executeResult.status).toBe(1);
    expect(JSON.parse(executeResult.stderr)).toEqual({
      ok: false,
      code: 'execution_not_implemented',
    });

    const source = fs.readFileSync(coordinator, 'utf8');
    expect(source).not.toContain("from 'node:child_process'");
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('spawn(');
  });
});
