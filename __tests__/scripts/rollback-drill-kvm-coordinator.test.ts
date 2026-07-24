import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindExecutionReceipt,
  buildExecutionReceipt,
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

function installFakeExecutionBinaries(root: string) {
  const bin = path.join(root, 'fake-bin');
  const state = path.join(root, 'fake-state.json');
  const remote = path.join(root, 'fake-remote');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(remote, { mode: 0o700 });
  fs.writeFileSync(state, JSON.stringify({
    guests: {
      '22221': { active: false, everStarted: false, boot: 0, status: 0 },
      '22222': { active: false, everStarted: false, boot: 0, status: 0 },
      '22223': { active: false, everStarted: false, boot: 0, status: 0 },
    },
  }), { mode: 0o600 });
  const executable = `#!/usr/bin/env node
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const statePath=process.env.FAKE_KVM_STATE;
const remoteRoot=process.env.FAKE_KVM_REMOTE;
const sourceSha=process.env.FAKE_SOURCE_SHA;
const targetSha=process.env.FAKE_TARGET_SHA;
const name=path.basename(process.argv[1]);
const argv=process.argv.slice(2);
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?\`[\${value.map(canonical).join(',')}]\`
 :\`{\${Object.keys(value).sort().map((key)=>\`\${JSON.stringify(key)}:\${canonical(value[key])}\`).join(',')}}\`;
const digest=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const readState=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));
const writeState=(value)=>fs.writeFileSync(statePath,JSON.stringify(value),{mode:0o600});
const remoteFile=(value)=>path.join(remoteRoot,digest(value));
if(name==='systemctl'){
 const [action,unit]=argv;
 const match=String(unit).match(/@guest-([123])\\.service$/u);
 if(!match)process.exit(2);
 const port=String(22220+Number(match[1]));
 const state=readState(),guest=state.guests[port];
 if(action==='start'){
  if(!guest.active){
   if(guest.everStarted)guest.boot+=1;
   guest.everStarted=true;guest.active=true;
  }
 }else if(action==='stop')guest.active=false;
 else process.exit(2);
 writeState(state);process.exit(0);
}
if(name==='scp'){
 const source=argv.at(-2),destination=argv.at(-1);
 const separator=destination.indexOf(':');
 const remotePath=destination.slice(separator+1);
 fs.copyFileSync(source,remoteFile(remotePath));
 process.exit(0);
}
if(name!=='ssh')process.exit(2);
const port=argv[argv.indexOf('-p')+1];
const targetIndex=argv.findIndex((value)=>value.startsWith('dominguez@'));
const command=argv.slice(targetIndex+1);
const state=readState(),guest=state.guests[port];
if(!guest?.active)process.exit(255);
const drill=port==='22221'?'ssh-loss':port==='22222'?'failed-health':'guest-reboot';
const transaction={
 '22221':'20260724T120001Z-1-111111111111',
 '22222':'20260724T120002Z-2-222222222222',
 '22223':'20260724T120003Z-3-333333333333',
}[port];
const emit=(value)=>process.stdout.write(typeof value==='string'?value:\`\${JSON.stringify(value)}\\n\`);
if(command[0]==='/usr/bin/true')process.exit(0);
if(command[0]==='/usr/bin/install'||command[0]==='/usr/bin/chmod')process.exit(0);
if(command[0]==='/usr/bin/rm'){
 try{fs.unlinkSync(remoteFile(command.at(-1)))}catch{}
 process.exit(0);
}
if(command[0]==='/usr/bin/sha256sum'){
 const file=remoteFile(command[1]);
 emit(\`\${digest(fs.readFileSync(file))}  \${command[1]}\\n\`);
 process.exit(0);
}
if(command[0]==='/usr/bin/cat'){
 if(command[1]==='/etc/machine-id')emit(\`guest-\${Number(port)-22220}-machine-id\\n\`);
 else if(command[1]==='/proc/sys/kernel/random/boot_id'){
  if(port!=='22223'||guest.boot===0)emit(\`guest-\${Number(port)-22220}-initial-boot-id\\n\`);
  else if(guest.boot===1)emit('guest-reboot-guest-boot-after-fault-reboot\\n');
  else emit('guest-reboot-guest-boot-after-clean-reboot\\n');
 }else process.exit(2);
 process.exit(0);
}
if(command[0]==='/usr/bin/node'&&command.includes('verify-request')){
 const input=command[command.indexOf('--input')+1];
 const envelope=JSON.parse(fs.readFileSync(remoteFile(input),'utf8'));
 emit({ok:true,kind:'request',transactionId:envelope.payload.transactionId,
  envelopeSha256:digest(canonical(envelope)),payloadSha256:digest(canonical(envelope.payload)),
  payload:envelope.payload});
 process.exit(0);
}
if(command[0]==='/usr/bin/systemctl'){
 emit('success\\n');process.exit(0);
}
if(command[0]==='/usr/bin/curl'){
 const url=command.at(-1);
 emit(url.includes(':8200')?{status:'healthy',server:{status:'online'},database:'connected'}:{status:'ok'});
 process.exit(0);
}
if(command[0]==='/usr/local/bin/pm2'&&command[1]==='jlist'){
 const runtimeSha=drill==='ssh-loss'?targetSha:sourceSha;
 emit(['nexus-hub','content-engine','nexus-hub-staging','content-engine-staging']
  .map((processName)=>({name:processName,pm2_env:{status:'online',NEXUS_RELEASE_SHA:runtimeSha}})));
 process.exit(0);
}
const sudoIndex=command[0]==='/usr/bin/sudo'?2:-1;
if(sudoIndex<0)process.exit(2);
const controlCommand=command[sudoIndex+1];
if(controlCommand==='version'){emit('nexus-release-promotion-control.v3\\n');process.exit(0);}
if(controlCommand==='assert-idle'||controlCommand==='assert-root-pm2-ready')process.exit(0);
if(controlCommand==='launch'){
 const envelope=JSON.parse(fs.readFileSync(remoteFile(command[sudoIndex+2]),'utf8'));
 const requestSha256=digest(canonical(envelope.payload));
 emit({ok:true,transactionId:envelope.payload.transactionId,state:'launched',requestSha256});
 process.exit(0);
}
if(controlCommand==='fetch'){emit('NEXUS_PROMOTION_RESULT=passed\\n');process.exit(0);}
if(controlCommand!=='status')process.exit(2);
const requestFile=fs.readdirSync(remoteRoot)
 .map((entry)=>path.join(remoteRoot,entry))
 .find((entry)=>{try{return JSON.parse(fs.readFileSync(entry,'utf8')).payload?.transactionId===transaction}catch{return false}});
const envelope=JSON.parse(fs.readFileSync(requestFile,'utf8'));
const requestSha256=digest(canonical(envelope.payload));
const recovered={
 schema:'nexus.promotion-recovery-result.v1',timingScope:'original_cutover',
 originalCutoverStartedAt:'2026-07-24T12:00:00Z',outageStartedAt:'2026-07-24T12:00:01Z',
 predecessorHealthyAt:'2026-07-24T12:00:10Z',outageToHealthySeconds:9,targetSeconds:120,
 targetMet:true,timingSource:'monotonic',
};
const sequences={
 'ssh-loss':[
  {phase:'arming_recovery',status:'running',message:'armed',recoveryArmed:true,recovery:null},
  {phase:'predecessor_stopped',status:'running',message:'stopped',recoveryArmed:true,recovery:null},
  {phase:'completed',status:'completed',message:'done',recoveryArmed:false,recovery:null},
 ],
 'failed-health':[
  {phase:'arming_recovery',status:'running',message:'armed',recoveryArmed:true,recovery:null},
  {phase:'predecessor_stopped',status:'running',message:'stopped',recoveryArmed:true,recovery:null},
  {phase:'mutating_candidate',status:'running',message:'mutating',recoveryArmed:true,recovery:null},
  {phase:'recovery_required',status:'recovery_required',message:'invalid_worker_completion',recoveryArmed:true,recovery:null},
  {phase:'recovery_complete',status:'recovered',message:'recovered',recoveryArmed:false,recovery:recovered},
 ],
 'guest-reboot':[
  {phase:'arming_recovery',status:'running',message:'armed',recoveryArmed:true,recovery:null},
  {phase:'predecessor_stopped',status:'running',message:'stopped',recoveryArmed:true,recovery:null},
  {phase:'recovery_complete',status:'recovered',message:'recovered',recoveryArmed:false,recovery:recovered},
 ],
};
const sequence=sequences[drill];
const index=Math.min(guest.status,sequence.length-1);
const current=sequence[index];
if(guest.status<sequence.length-1)guest.status+=1;
writeState(state);
emit({schema:'nexus.promotion-transaction-journal.v1',transactionId:transaction,
 requestSha256,startedAt:'2026-07-24T12:00:00Z',updatedAt:'2026-07-24T12:00:10Z',
 completedAt:['completed','recovered'].includes(current.status)?'2026-07-24T12:00:10Z':null,
 predecessor:{sha:sourceSha},target:{sha:targetSha},sentryRelease:targetSha,...current});
`;
  for (const name of ['ssh', 'scp', 'systemctl']) {
    const target = path.join(bin, name);
    fs.writeFileSync(target, executable, { mode: 0o700 });
    fs.chmodSync(target, 0o700);
  }
  return { bin, state, remote };
}

function writePromotionRequests(
  directory: string,
  fixture: ReturnType<typeof makeKvmDrillFixture>,
) {
  fs.mkdirSync(directory, { mode: 0o700 });
  fixture.plan.overlays.forEach((overlay: any, index: number) => {
    const payload = {
      schema: 'nexus.promotion-transaction-request.v1',
      transactionId: `20260724T12000${index + 1}Z-${index + 1}-${String(index + 1).repeat(12)}`,
      ownerAuthorization: 'explicit',
      predecessor: { sha: fixture.plan.release.sourceSha },
      target: {
        sha: fixture.plan.release.targetSha,
        version: fixture.plan.release.targetVersion,
        sentryRelease: fixture.plan.release.targetSha,
      },
      productionBase: fixture.plan.release.productionBase,
      backupDir: fixture.plan.release.backupDir,
      preparedRuntimeDir: fixture.plan.release.preparedRuntimeDir,
      pm2Bin: fixture.plan.release.pm2Bin,
      publicBaseUrl: fixture.plan.release.publicBaseUrl,
      stabilitySeconds: 60,
    };
    fs.writeFileSync(
      path.join(directory, `${overlay.drill}.envelope.json`),
      JSON.stringify({
        schema: 'nexus.promotion-transaction-request-envelope.v1',
        keyId: 'nexus-owner-promotion-2026',
        signatureAlgorithm: 'ed25519',
        payload,
        signature: 'fixture',
      }),
      { mode: 0o600 },
    );
  });
}

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

    expect(plan.executionSupported).toBe(true);
    expect(plan.executionMode).toBe('strictly-sequential');
    expect(plan.maximumActiveGuests).toBe(1);
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

  it('rejects self-consistent test-mode execution before creating machine evidence', () => {
    const provisionalOutcomes = Object.fromEntries(
      Object.entries(fixture.outcomes).map(([drill, outcome]) => [
        drill,
        {
          ...(structuredClone(outcome) as any),
          testMode: true,
          executionReceiptSha256: null,
        },
      ]),
    );
    const execution = buildExecutionReceipt(fixture.plan, provisionalOutcomes, {
      testMode: true,
      completedAt: fixture.execution.completedAt,
    });
    const outcomes = bindExecutionReceipt(execution, provisionalOutcomes);
    const destination = path.join(root, 'test-mode-bundle');
    expect(() => collectBundle(
      { ...fixture, execution, outcomes },
      destination,
      { nowMs: fixture.nowMs },
    )).toThrow('execution_receipt_test_mode_rejected');
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('rejects a substituted execution receipt before creating machine evidence', () => {
    const execution = structuredClone(fixture.execution);
    execution.completedAt = new Date(Date.parse(execution.completedAt) + 1_000).toISOString();
    const destination = path.join(root, 'substituted-execution-bundle');
    expect(() => collectBundle(
      { ...fixture, execution },
      destination,
      { nowMs: fixture.nowMs },
    )).toThrow('execution_receipt_binding_mismatch:ssh-loss');
    expect(fs.existsSync(destination)).toBe(false);
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
    const guestRebootIsolation = fixture.isolation.overlays.find(
      (entry: any) => entry.drill === 'guest-reboot',
    );
    for (const entry of unchangedBoot.timeline) {
      entry.guestBootIdSha256 = guestRebootIsolation.readinessBootIdSha256;
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

    const missingExecution = collectBundle(
      fixture,
      path.join(root, 'missing-execution-bundle'),
      { nowMs: fixture.nowMs },
    );
    fs.unlinkSync(path.join(missingExecution.bundlePath, 'execution.json'));
    expect(() => verifyBundle(
      missingExecution.bundlePath,
      fixture.keys,
      { nowMs: fixture.nowMs },
    )).toThrow('bundle_layout_invalid');
  });

  it('collects, verifies, and emits an unsigned existing-schema request through the CLI', () => {
    const inputs = path.join(root, 'cli-inputs');
    writeKvmDrillFixture(inputs, fixture);
    const requestedBundle = path.join(root, 'cli-bundle');
    const missingExecution = spawnSync(
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
    expect(missingExecution.status).toBe(1);
    expect(JSON.parse(missingExecution.stderr)).toEqual({
      ok: false,
      code: 'flag_required:--execution',
    });
    expect(fs.existsSync(requestedBundle)).toBe(false);
    const collectResult = spawnSync(
      process.execPath,
      [
        coordinator,
        'collect',
        '--plan', path.join(inputs, 'plan.json'),
        '--authorization', path.join(inputs, 'authorization.json'),
        '--isolation', path.join(inputs, 'isolation.json'),
        '--execution', path.join(inputs, 'execution.json'),
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

  it('keeps --plan local and executes all three fake guests strictly sequentially', () => {
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
    expect(JSON.parse(planResult.stdout).executionPlan).toEqual(
      expect.objectContaining({
        executionSupported: true,
        executionMode: 'strictly-sequential',
        maximumActiveGuests: 1,
      }),
    );

    const canonicalRoot = fs.realpathSync(root);
    const canonicalInputs = path.join(canonicalRoot, 'inputs');
    const fake = installFakeExecutionBinaries(canonicalRoot);
    const executionEnv = {
      ...process.env,
      NEXUS_ROLLBACK_DRILL_COORDINATOR_TEST_MODE: '1',
      NEXUS_ROLLBACK_DRILL_COORDINATOR_TEST_BIN_DIR: fake.bin,
      NEXUS_ROLLBACK_DRILL_CONTROLLER_MACHINE_ID:
        'serverdominguez-machine-id',
      NEXUS_ROLLBACK_DRILL_CONTROLLER_BOOT_ID:
        'serverdominguez-boot-id',
      FAKE_KVM_STATE: fake.state,
      FAKE_KVM_REMOTE: fake.remote,
      FAKE_SOURCE_SHA: fixture.plan.release.sourceSha,
      FAKE_TARGET_SHA: fixture.plan.release.targetSha,
    };
    const incomplete = spawnSync(
      process.execPath,
      [
        coordinator,
        'execute',
        '--plan', path.join(inputs, 'plan.json'),
        '--authorization', path.join(inputs, 'authorization.json'),
        '--isolation', path.join(inputs, 'isolation.json'),
        ...keyArgsFor(inputs),
      ],
      { encoding: 'utf8', env: executionEnv },
    );
    expect(incomplete.status).toBe(1);
    expect(JSON.parse(incomplete.stderr)).toEqual({
      ok: false,
      code: 'flag_required:--guest-ssh-private-key',
    });

    const requests = path.join(canonicalRoot, 'requests');
    writePromotionRequests(requests, fixture);
    const privateKey = path.join(canonicalRoot, 'guest-ssh-private-key');
    fs.writeFileSync(privateKey, 'fixture-private-key\n', { mode: 0o600 });
    const output = path.join(canonicalRoot, 'execution');
    const executeResult = spawnSync(
      process.execPath,
      [
        coordinator,
        'execute',
        '--plan', path.join(canonicalInputs, 'plan.json'),
        '--authorization', path.join(canonicalInputs, 'authorization.json'),
        '--isolation', path.join(canonicalInputs, 'isolation.json'),
        ...keyArgsFor(canonicalInputs),
        '--guest-ssh-private-key', privateKey,
        '--request-dir', requests,
        '--output-dir', output,
      ],
      {
        encoding: 'utf8',
        env: executionEnv,
        timeout: 20_000,
      },
    );
    expect(executeResult.status, executeResult.stderr).toBe(0);
    const result = JSON.parse(executeResult.stdout);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      command: 'execute',
      testMode: true,
    }));
    expect(result.outcomes.map((entry: any) => entry.drill)).toEqual([
      'ssh-loss',
      'failed-health',
      'guest-reboot',
    ]);
    const reboot = JSON.parse(
      fs.readFileSync(path.join(output, 'guest-reboot.json'), 'utf8'),
    );
    expect(reboot.terminalStatus).toBe('recovered');
    expect(reboot.postTerminalReboot).toEqual(expect.objectContaining({
      recoveryUnitResult: 'success',
      assertRootPm2Ready: true,
      assertIdle: true,
      exactRuntimeHealthy: true,
    }));
    expect(reboot).toEqual(expect.objectContaining({
      executionMode: 'strictly-sequential',
      testMode: true,
      executionReceiptSha256: result.receiptSha256,
    }));
    expect(validateDrillOutcome(
      reboot,
      fixture.plan,
      fixture.isolation,
    ).recoveryMilliseconds).toBeLessThanOrEqual(120_000);
    const rejectedBundle = path.join(canonicalRoot, 'test-mode-machine-evidence');
    const rejectedCollection = spawnSync(
      process.execPath,
      [
        coordinator,
        'collect',
        '--plan', path.join(canonicalInputs, 'plan.json'),
        '--authorization', path.join(canonicalInputs, 'authorization.json'),
        '--isolation', path.join(canonicalInputs, 'isolation.json'),
        '--execution', path.join(output, 'execution.json'),
        '--restore', path.join(canonicalInputs, 'restore.json'),
        '--ssh-loss', path.join(output, 'ssh-loss.json'),
        '--failed-health', path.join(output, 'failed-health.json'),
        '--guest-reboot', path.join(output, 'guest-reboot.json'),
        ...keyArgsFor(canonicalInputs),
        '--output-dir', rejectedBundle,
      ],
      { encoding: 'utf8' },
    );
    expect(rejectedCollection.status).toBe(1);
    expect(JSON.parse(rejectedCollection.stderr)).toEqual({
      ok: false,
      code: 'execution_receipt_test_mode_rejected',
    });
    expect(fs.existsSync(rejectedBundle)).toBe(false);

    const fakeState = JSON.parse(fs.readFileSync(fake.state, 'utf8'));
    expect(Object.values(fakeState.guests).every((guest: any) => guest.active === false))
      .toBe(true);
    expect(fakeState.guests['22223'].boot).toBe(2);
    const source = fs.readFileSync(coordinator, 'utf8');
    expect(source).toContain("from 'node:child_process'");
    expect(source).toContain('spawnSync');
    expect(source).not.toContain('Promise.all');
    expect(source).not.toContain('spawn(');
  });
});
