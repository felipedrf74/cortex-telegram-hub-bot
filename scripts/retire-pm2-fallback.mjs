#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  Pm2FallbackRetirementRefusal,
  acquirePm2FallbackRetirementLocks,
  assertDetachedRetirementService,
  createLinuxPm2FallbackRetirementMutator,
  inspectLinuxPm2FallbackRetirement,
  readPm2FallbackRetirementStatus,
  runPm2FallbackRetirementTransaction,
} from './lib/pm2-fallback-retirement.mjs';

const args = process.argv.slice(2);
let apply = false;
let confirmation = '';
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--apply' && !apply) {
    apply = true;
  } else if (value === '--confirm' && !confirmation) {
    confirmation = args[index + 1] ?? '';
    index += 1;
  } else {
    process.stderr.write('usage: retire-pm2-fallback.mjs [--apply --confirm <identity>]\n');
    process.exit(64);
  }
}
if ((apply && !confirmation) || (!apply && confirmation)) {
  process.stderr.write('usage: retire-pm2-fallback.mjs [--apply --confirm <identity>]\n');
  process.exit(64);
}
if (process.getuid?.() !== 0) {
  process.stderr.write('PM2 fallback retirement requires root\n');
  process.exit(77);
}
if (apply && process.env.NEXUS_RELEASE_OWNER_AUTHORIZED !== '1') {
  process.stderr.write('apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1\n');
  process.exit(77);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let releaseLocks;
try {
  const policy = loadContinuousDeploymentPolicy(root);
  releaseLocks = acquirePm2FallbackRetirementLocks();
  const status = readPm2FallbackRetirementStatus();

  if (!apply) {
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
