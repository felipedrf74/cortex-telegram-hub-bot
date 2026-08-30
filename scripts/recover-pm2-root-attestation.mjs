#!/usr/bin/env node
import process from 'node:process';

import {
  Pm2RootAttestationRecoveryRefusal,
  inspectPm2RootAttestationRecovery,
  recoverPm2RootAttestation,
} from './lib/pm2-root-attestation-recovery.mjs';
import { acquirePm2FallbackRetirementLocks }
  from './lib/pm2-fallback-retirement.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmAt = args.indexOf('--confirm');
const confirm = confirmAt === -1 ? '' : args[confirmAt + 1] ?? '';

if (process.geteuid?.() !== 0) {
  process.stderr.write(`${JSON.stringify({
    schema: 'nexus.pm2-root-attestation-recovery-error.v1',
    code: 'root_required',
  })}\n`);
  process.exit(77);
}

try {
  let result;
  if (apply) {
    result = recoverPm2RootAttestation({
      confirm,
      ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
    });
  } else {
    const releaseLocks = acquirePm2FallbackRetirementLocks();
    try {
      result = inspectPm2RootAttestationRecovery();
    } finally {
      releaseLocks();
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  if (error instanceof Pm2RootAttestationRecoveryRefusal) {
    process.stderr.write(`${JSON.stringify({
      schema: 'nexus.pm2-root-attestation-recovery-error.v1',
      code: error.code,
    })}\n`);
    process.exitCode = 75;
  } else {
    process.stderr.write(`${JSON.stringify({
      schema: 'nexus.pm2-root-attestation-recovery-error.v1',
      code: 'unexpected_failure',
    })}\n`);
    process.exitCode = 1;
  }
}
