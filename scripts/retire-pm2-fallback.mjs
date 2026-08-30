#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  Pm2FallbackRetirementRefusal,
  acquirePm2FallbackRetirementLocks,
  authorizePm2FallbackControlPlaneSuccessor,
  assertDetachedRetirementService,
  createLinuxPm2FallbackRetirementMutator,
  inspectLinuxPm2FallbackRetirement,
  inspectPm2FallbackControlPlaneSuccessor,
  readPm2FallbackRetirementStatus,
  runPm2FallbackRetirementTransaction,
} from './lib/pm2-fallback-retirement.mjs';

const args = process.argv.slice(2);
let mode = 'inspect';
let confirmation = '';
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--apply' && mode === 'inspect') {
    mode = 'apply';
  } else if (value === '--inspect-control-plane-successor' && mode === 'inspect') {
    mode = 'inspect-successor';
  } else if (value === '--authorize-control-plane-successor' && mode === 'inspect') {
    mode = 'authorize-successor';
  } else if (value === '--confirm' && !confirmation) {
    confirmation = args[index + 1] ?? '';
    index += 1;
  } else {
    process.stderr.write('usage: retire-pm2-fallback.mjs [--apply --confirm <identity> | --inspect-control-plane-successor | --authorize-control-plane-successor --confirm <digest>]\n');
    process.exit(64);
  }
}
if ((['apply', 'authorize-successor'].includes(mode) && !confirmation)
    || (!['apply', 'authorize-successor'].includes(mode) && confirmation)) {
  process.stderr.write('usage: retire-pm2-fallback.mjs [--apply --confirm <identity> | --inspect-control-plane-successor | --authorize-control-plane-successor --confirm <digest>]\n');
  process.exit(64);
}
if (process.getuid?.() !== 0) {
  process.stderr.write('PM2 fallback retirement requires root\n');
  process.exit(77);
}
if (['apply', 'authorize-successor'].includes(mode)
    && process.env.NEXUS_RELEASE_OWNER_AUTHORIZED !== '1') {
  process.stderr.write('mutation requires NEXUS_RELEASE_OWNER_AUTHORIZED=1\n');
  process.exit(77);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let releaseLocks;
try {
  const policy = loadContinuousDeploymentPolicy(root);
  releaseLocks = acquirePm2FallbackRetirementLocks({ includeBackup: true });
  const status = readPm2FallbackRetirementStatus();

  if (mode === 'inspect') {
    if (status.status !== 'not_started') {
      process.stdout.write(`${JSON.stringify({
        schema: 'nexus.pm2-fallback-retirement-inspection.v1',
        mode: 'dry-run',
        ...status,
      })}\n`);
    } else {
      const plan = inspectLinuxPm2FallbackRetirement({ policy });
      process.stdout.write(`${JSON.stringify({
        schema: 'nexus.pm2-fallback-retirement-inspection.v1',
        mode: 'dry-run',
        status: 'eligible',
        plan,
      })}\n`);
    }
  } else if (mode === 'inspect-successor') {
    if (status.status !== 'in_progress') {
      throw new Pm2FallbackRetirementRefusal(
        'control-plane successor inspection requires an interrupted transaction',
        'control_plane_successor_phase',
      );
    }
    const candidate = inspectPm2FallbackControlPlaneSuccessor({
      plan: status.journal.plan,
      phase: status.journal.phase,
    });
    process.stdout.write(`${JSON.stringify({
      schema: 'nexus.pm2-fallback-control-plane-successor-inspection.v1',
      mode,
      status: 'eligible',
      candidate,
    })}\n`);
  } else if (mode === 'authorize-successor') {
    if (status.status !== 'in_progress') {
      throw new Pm2FallbackRetirementRefusal(
        'control-plane successor authorization requires an interrupted transaction',
        'control_plane_successor_phase',
      );
    }
    const evidence = authorizePm2FallbackControlPlaneSuccessor({
      plan: status.journal.plan,
      phase: status.journal.phase,
      confirmation,
    });
    process.stdout.write(`${JSON.stringify({
      schema: 'nexus.pm2-fallback-control-plane-successor-result.v1',
      mode,
      outcome: 'authorized',
      evidence,
    })}\n`);
  } else if (status.status === 'completed') {
    process.stdout.write(`${JSON.stringify({
      schema: 'nexus.pm2-fallback-retirement-result.v1',
      mode: 'apply',
      outcome: 'already_completed',
      receiptPath: status.receiptPath,
      receipt: status.receipt,
    })}\n`);
  } else {
    assertDetachedRetirementService();
    const plan = status.status === 'in_progress'
      ? status.journal.plan
      : inspectLinuxPm2FallbackRetirement({ policy });
    const result = await runPm2FallbackRetirementTransaction({
      plan,
      confirmation,
      host: createLinuxPm2FallbackRetirementMutator({ policy }),
    });
    process.stdout.write(`${JSON.stringify({
      schema: 'nexus.pm2-fallback-retirement-result.v1',
      mode: 'apply',
      ...result,
    })}\n`);
  }
} catch (error) {
  const refusal = error instanceof Pm2FallbackRetirementRefusal;
  process.stderr.write(`${JSON.stringify({
    schema: 'nexus.pm2-fallback-retirement-error.v1',
    code: refusal ? error.code : 'unexpected_failure',
    message: refusal ? error.message : 'PM2 fallback retirement failed closed',
  })}\n`);
  process.exitCode = refusal ? 75 : 70;
} finally {
  releaseLocks?.();
}
