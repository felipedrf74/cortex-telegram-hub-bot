#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  EvidenceError,
  buildLocalExecutionPlan,
  buildRollbackRequest,
  canonicalJsonBuffer,
  collectBundle,
  publicKeyIdentity,
  readBoundedJson,
  readBoundedText,
  sha256Json,
  textKeyIdentity,
  validateIsolationEvidence,
  validateKeySet,
  validateOwnerAuthorization,
  validatePlan,
  verifyBundle,
} from './lib/rollback-drill-kvm-evidence.mjs';

const rawArgs = process.argv.slice(2);
const knownCommands = new Set([
  'plan',
  'validate-isolation',
  'collect',
  'verify',
  'request',
  'execute',
]);
let command = rawArgs[0] && !rawArgs[0].startsWith('--') ? rawArgs.shift() : '';
if (!command && rawArgs.includes('--plan')) command = 'plan';

const FLAGS = Object.freeze({
  plan: new Set(['--input', '--plan']),
  'validate-isolation': new Set(['--plan', '--isolation']),
  collect: new Set([
    '--plan',
    '--authorization',
    '--isolation',
    '--restore',
    '--ssh-loss',
    '--failed-health',
    '--guest-reboot',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
    '--output-dir',
  ]),
  verify: new Set([
    '--bundle',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
  ]),
  request: new Set([
    '--bundle',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
    '--operator',
    '--output',
  ]),
  execute: new Set([
    '--plan',
    '--authorization',
    '--isolation',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
  ]),
});

function fail(code) {
  throw new EvidenceError(code);
}

function usage() {
  process.stderr.write(
    'Usage: rollback-drill-kvm-coordinator.mjs '
      + '<plan|validate-isolation|collect|verify|request|execute> [exact options]\n',
  );
}

function parseFlags() {
  if (!knownCommands.has(command)) fail('command_unsupported');
  const allowed = FLAGS[command];
  const values = new Map();
  for (let index = 0; index < rawArgs.length; index += 2) {
    const flag = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!allowed.has(flag)) fail(`flag_unsupported:${flag || 'missing'}`);
    if (!value || value.startsWith('--')) fail(`flag_value_missing:${flag}`);
    if (values.has(flag)) fail(`flag_duplicate:${flag}`);
    values.set(flag, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`flag_required:${name}`);
  return value;
}

function planPath(values) {
  const input = values.get('--input');
  const plan = values.get('--plan');
  if (input && plan) fail('plan_input_ambiguous');
  return required(values, input ? '--input' : '--plan');
}

function readPlan(values) {
  return readBoundedJson(planPath(values), 'plan');
}

function readKeys(values) {
  return {
    guestOwnerPublicKeyPem: readBoundedText(
      required(values, '--guest-owner-public-key'),
      'guest_owner_public_key',
      16 * 1024,
    ),
    productionOwnerPublicKeyPem: readBoundedText(
      required(values, '--production-owner-public-key'),
      'production_owner_public_key',
      16 * 1024,
    ),
    guestSshClientPublicKey: readBoundedText(
      required(values, '--guest-ssh-client-public-key'),
      'guest_ssh_client_public_key',
      16 * 1024,
    ),
    productionSshClientPublicKey: readBoundedText(
      required(values, '--production-ssh-client-public-key'),
      'production_ssh_client_public_key',
      16 * 1024,
    ),
    guestSshHostPublicKey: readBoundedText(
      required(values, '--guest-ssh-host-public-key'),
      'guest_ssh_host_public_key',
      16 * 1024,
    ),
    productionSshHostPublicKey: readBoundedText(
      required(values, '--production-ssh-host-public-key'),
      'production_ssh_host_public_key',
      16 * 1024,
    ),
    releaseEvidencePublicKeyPem: readBoundedText(
      required(values, '--release-evidence-public-key'),
      'release_evidence_public_key',
      16 * 1024,
    ),
  };
}

function publishRequest(output, payload) {
  const requested = path.resolve(output);
  const requestedParent = path.dirname(requested);
  const stat = fs.lstatSync(requestedParent, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('request_output_parent_unsafe');
  }
  const parent = fs.realpathSync(requestedParent);
  const resolved = path.join(parent, path.basename(requested));
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJsonBuffer(payload));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(resolved, 0o600);
  const parentDescriptor = fs.openSync(parent, 'r');
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
  return resolved;
}

function keySummary(plan) {
  return {
    guestOwnerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    guestSshClientPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
    guestSshHostPublicKeySha256: plan.trust.guestSshHostPublicKeySha256,
    releaseEvidencePublicKeySha256: plan.trust.releaseEvidencePublicKeySha256,
  };
}

function main() {
  const values = parseFlags();
  if (command === 'plan') {
    const plan = readPlan(values);
    validatePlan(plan);
    return {
      ok: true,
      command,
      planSha256: sha256Json(plan),
      keyIdentities: keySummary(plan),
      executionPlan: buildLocalExecutionPlan(plan),
    };
  }
  if (command === 'validate-isolation') {
    const plan = readPlan(values);
    const isolation = readBoundedJson(required(values, '--isolation'), 'isolation');
    validateIsolationEvidence(isolation, plan);
    return {
      ok: true,
      command,
      planId: plan.planId,
      planSha256: sha256Json(plan),
      isolationSha256: sha256Json(isolation),
    };
  }
  if (command === 'collect') {
    const plan = readPlan(values);
    const authorization = readBoundedJson(
      required(values, '--authorization'),
      'authorization',
    );
    const isolation = readBoundedJson(required(values, '--isolation'), 'isolation');
    const restore = readBoundedJson(required(values, '--restore'), 'restore');
    const outcomes = {
      'ssh-loss': readBoundedJson(required(values, '--ssh-loss'), 'ssh_loss'),
      'failed-health': readBoundedJson(
        required(values, '--failed-health'),
        'failed_health',
      ),
      'guest-reboot': readBoundedJson(
        required(values, '--guest-reboot'),
        'guest_reboot',
      ),
    };
    return {
      ok: true,
      command,
      ...collectBundle(
        {
          plan,
          authorization,
          isolation,
          restore,
          outcomes,
          keys: readKeys(values),
        },
        required(values, '--output-dir'),
      ),
    };
  }
  if (command === 'verify') {
    return {
      ok: true,
      command,
      ...verifyBundle(required(values, '--bundle'), readKeys(values)),
    };
  }
  if (command === 'request') {
    const verified = verifyBundle(required(values, '--bundle'), readKeys(values));
    const payload = buildRollbackRequest(verified, required(values, '--operator'));
    const output = publishRequest(required(values, '--output'), payload);
    return {
      ok: true,
      command,
      output,
      payloadSha256: sha256Json(payload),
      machineEvidenceSha256: payload.machineEvidenceSha256,
      targetBackupSha256: payload.targetBackupSha256,
    };
  }
  if (command === 'execute') {
    const plan = readPlan(values);
    const keys = readKeys(values);
    validateKeySet(plan, keys);
    validateOwnerAuthorization(
      readBoundedJson(required(values, '--authorization'), 'authorization'),
      plan,
      keys.guestOwnerPublicKeyPem,
    );
    validateIsolationEvidence(
      readBoundedJson(required(values, '--isolation'), 'isolation'),
      plan,
    );
    // Deliberately no child_process import or remote mutation path exists.
    // Fault injection needs reviewed libvirt and guest-side contracts first.
    fail('execution_not_implemented');
  }
  fail('command_unsupported');
}

try {
  const result = main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const code = error instanceof EvidenceError ? error.code : 'unexpected_error';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  if (code === 'command_unsupported') usage();
  process.exitCode = 1;
}

// Keep public-key identity helpers reachable for deterministic fixture tools
// without adding a second CLI or a signing surface.
export { publicKeyIdentity, textKeyIdentity };
