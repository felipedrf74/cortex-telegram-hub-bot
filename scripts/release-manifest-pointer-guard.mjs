#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CONTINUOUS_DEPLOYMENT_POLICY_PATH,
  loadContinuousDeploymentPolicy,
  parseReleaseManifestBytes,
  verifyReleaseManifest,
} from './lib/release-manifest.mjs';
import {
  RELEASE_MANIFEST_VERIFICATION_MODES,
  loadReleaseManifestSchemaPolicy,
} from './lib/release-manifest-schema-policy.mjs';
import {
  assertFullSha,
  assertHexSha256,
} from './lib/release-canonical.mjs';

export const RELEASE_MANIFEST_POINTER_GUARD_RESULT_SCHEMA =
  'nexus.release-manifest-pointer-guard-result.v1';
export const RELEASE_MANIFEST_POINTER_GUARD_MODES = Object.freeze({
  AUTOMATIC: 'automatic',
  ACTIVATION: 'activation',
});
export const RELEASE_MANIFEST_POINTER_DECISIONS = Object.freeze({
  MOVE_MAIN: 'move_main',
  HOLD_GENERATION_MISMATCH: 'hold_generation_mismatch',
  ACTIVATE_MAIN: 'activate_main',
});
export const RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH =
  'docs/release/evidence/release-manifest-public-key.pem';

const MAX_CONTINUOUS_DEPLOYMENT_POLICY_BYTES = 128 * 1024;
const MAX_PUBLIC_KEY_BYTES = 4 * 1024;
const MAX_PATH_BYTES = 4 * 1024;

function fail(message) {
  throw new Error(`release manifest pointer guard ${message}`);
}

function assertSafePathArgument(value, label) {
  if (typeof value !== 'string'
      || value.length === 0
      || Buffer.byteLength(value) > MAX_PATH_BYTES
      || value.includes('\0')) {
    fail(`${label} must be a bounded non-empty path`);
  }
  return value;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readBoundedRegularFile(file, { label, maxBytes }) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    fail(`${label} cannot be opened without symbolic-link following`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK
        | (fs.constants.O_CLOEXEC ?? 0),
    );
  } catch {
    fail(`${label} must be a bounded regular file, not a symbolic link`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()
        || before.nlink !== 1n
        || before.size < 1n
        || before.size > BigInt(maxBytes)) {
      fail(`${label} must be a bounded regular file, not a symbolic link`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    let pathIdentity;
    try {
      pathIdentity = fs.lstatSync(file, { bigint: true });
    } catch {
      fail(`${label} changed while it was being read`);
    }
    if (!pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !sameFileIdentity(before, after)
        || before.dev !== pathIdentity.dev
        || before.ino !== pathIdentity.ino
        || bytes.length !== Number(before.size)) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error
        && error.message.startsWith('release manifest pointer guard ')) {
      throw error;
    }
    return fail(`${label} is unreadable`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveContainedInputPath(root, input, label) {
  const safeInput = assertSafePathArgument(input, label);
  if (path.isAbsolute(safeInput)) {
    fail(`${label} must be repository-relative`);
  }
  const resolved = path.resolve(root, safeInput);
  const relative = path.relative(root, resolved);
  if (relative === ''
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    fail(`${label} must remain within the repository root`);
  }
  let canonicalRoot;
  let canonicalParent;
  try {
    canonicalRoot = fs.realpathSync(root);
    canonicalParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    fail(`${label} parent directory is missing or unreadable`);
  }
  const canonicalRelative = path.relative(canonicalRoot, canonicalParent);
  if (canonicalRelative === '..'
      || canonicalRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(canonicalRelative)) {
    fail(`${label} parent directory escapes the repository root`);
  }
  return resolved;
}

function assertRootDirectory(root) {
  const resolved = path.resolve(assertSafePathArgument(root, 'root'));
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail('root is missing');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('root must be a regular directory, not a symbolic link');
  }
  return resolved;
}

function assertSafeGeneration(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Decide whether a verified immutable candidate may replace the moving
 * pointer. This function is deliberately pure: verification and file I/O stay
 * outside it, while hostile transition inputs can be tested directly.
 */
export function decideReleaseManifestPointer({
  mode,
  expectedCandidateSha,
  candidateSourceSha,
  currentGeneration,
  candidateGeneration,
  candidateControlPlaneDigest,
  expectedInstalledControlPlaneDigest,
}) {
  if (!Object.values(RELEASE_MANIFEST_POINTER_GUARD_MODES).includes(mode)) {
    fail(`mode is unsupported: ${String(mode)}`);
  }
  try {
    assertFullSha(expectedCandidateSha, 'expected candidate source sha');
    assertFullSha(candidateSourceSha, 'signed candidate source sha');
  } catch (error) {
    fail(error instanceof Error ? error.message : 'candidate source sha is invalid');
  }
  if (candidateSourceSha !== expectedCandidateSha) {
    fail('signed candidate source sha does not match the exact expected candidate sha');
  }

  const current = assertSafeGeneration(currentGeneration, 'current generation');
  const candidate = assertSafeGeneration(candidateGeneration, 'candidate generation');
  if (candidate < current) {
    fail(`candidate generation ${candidate} would downgrade current generation ${current}`);
  }

  if (mode === RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC) {
    if (expectedInstalledControlPlaneDigest !== undefined) {
      fail('automatic mode must not receive an installed control-plane observation');
    }
    return Object.freeze({
      schema: RELEASE_MANIFEST_POINTER_GUARD_RESULT_SCHEMA,
      mode,
      decision: candidate === current
        ? RELEASE_MANIFEST_POINTER_DECISIONS.MOVE_MAIN
        : RELEASE_MANIFEST_POINTER_DECISIONS.HOLD_GENERATION_MISMATCH,
      currentGeneration: current,
      candidateGeneration: candidate,
      ownerObservation: null,
    });
  }

  if (candidate === current) {
    fail('activation requires the candidate generation to be newer than the current generation');
  }
  try {
    assertHexSha256(
      expectedInstalledControlPlaneDigest,
      'owner-observed installed control-plane digest',
    );
    assertHexSha256(
      candidateControlPlaneDigest,
      'signed candidate control-plane digest',
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : 'control-plane digest is invalid');
  }
  if (candidateControlPlaneDigest !== expectedInstalledControlPlaneDigest) {
    fail('owner-observed installed control-plane digest does not match the signed candidate');
  }

  return Object.freeze({
    schema: RELEASE_MANIFEST_POINTER_GUARD_RESULT_SCHEMA,
    mode,
    decision: RELEASE_MANIFEST_POINTER_DECISIONS.ACTIVATE_MAIN,
    currentGeneration: current,
    candidateGeneration: candidate,
    ownerObservation: Object.freeze({
      evidence: 'owner observation, not machine attestation',
      installedControlPlaneDigest: expectedInstalledControlPlaneDigest,
    }),
  });
}

/**
 * Signature-verify both manifests before reading either identity as evidence.
 * The historical moving pointer is checked in retained mode with its signed
 * createdAt as `now`, intentionally disabling wall-clock freshness while
 * preserving every schema, identity, key, and signature check.
 */
export function verifyReleaseManifestPointer({
  candidateEnvelope,
  currentEnvelope,
  expectedCandidateSha,
  policy,
  schemaPolicy,
  publicKeyPath,
  mode = RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
  expectedInstalledControlPlaneDigest,
  nowMs = Date.now(),
}) {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    fail('candidate verification time is invalid');
  }

  const candidate = verifyReleaseManifest({
    envelope: candidateEnvelope,
    policy,
    schemaPolicy,
    publicKeyPath,
    nowMs,
    verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
  });

  const retainedCreatedAtMs = Date.parse(currentEnvelope?.payload?.createdAt);
  if (!Number.isFinite(retainedCreatedAtMs)) {
    fail('signed current manifest createdAt is invalid');
  }
  const current = verifyReleaseManifest({
    envelope: currentEnvelope,
    policy,
    schemaPolicy,
    publicKeyPath,
    nowMs: retainedCreatedAtMs,
    verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED,
  });

  return decideReleaseManifestPointer({
    mode,
    expectedCandidateSha,
    candidateSourceSha: candidate.payload.source.sha,
    currentGeneration: current.payload.schemaVersion,
    candidateGeneration: candidate.payload.schemaVersion,
    candidateControlPlaneDigest: candidate.payload.controlPlane?.digest,
    expectedInstalledControlPlaneDigest,
  });
}

function nextOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
    fail(`${option} requires a value`);
  }
  return value;
}

export function parseReleaseManifestPointerGuardArgs(
  argv,
  { defaultRoot = process.cwd() } = {},
) {
  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) {
    fail('arguments must be a string array');
  }
  if (argv.length > 16) fail('too many arguments');
  const values = new Map();
  let activation = false;
  let help = false;
  const valueOptions = new Map([
    ['--root', 'root'],
    ['--candidate-manifest', 'candidateManifest'],
    ['--current-manifest', 'currentManifest'],
    ['--expected-candidate-sha', 'expectedCandidateSha'],
    ['--expected-installed-control-plane-digest', 'expectedInstalledControlPlaneDigest'],
    ['--public-key', 'publicKey'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--activation') {
      if (activation) fail('--activation must not be repeated');
      activation = true;
    } else if (argument === '-h' || argument === '--help') {
      if (help) fail('--help must not be repeated');
      help = true;
    } else if (valueOptions.has(argument)) {
      const field = valueOptions.get(argument);
      if (values.has(field)) fail(`${argument} must not be repeated`);
      values.set(field, nextOptionValue(argv, index, argument));
      index += 1;
    } else {
      fail('unknown argument');
    }
  }

  if (help) {
    if (activation || values.size > 0) fail('--help must be used alone');
    return Object.freeze({ help: true });
  }

  const root = values.get('root') ?? defaultRoot;
  const candidateManifest = values.get('candidateManifest');
  const currentManifest = values.get('currentManifest');
  const expectedCandidateSha = values.get('expectedCandidateSha');
  const publicKey = values.get('publicKey') ?? RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH;
  const expectedInstalledControlPlaneDigest =
    values.get('expectedInstalledControlPlaneDigest');
  for (const [value, label] of [
    [root, 'root'],
    [candidateManifest, '--candidate-manifest'],
    [currentManifest, '--current-manifest'],
    [publicKey, '--public-key'],
  ]) {
    assertSafePathArgument(value, label);
  }
  try {
    assertFullSha(expectedCandidateSha, 'expected candidate source sha');
  } catch (error) {
    fail(error instanceof Error ? error.message : 'expected candidate source sha is invalid');
  }
  if (activation) {
    try {
      assertHexSha256(
        expectedInstalledControlPlaneDigest,
        'owner-observed installed control-plane digest',
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : 'control-plane digest is invalid');
    }
  } else if (expectedInstalledControlPlaneDigest !== undefined) {
    fail('--expected-installed-control-plane-digest requires --activation');
  }

  return Object.freeze({
    help: false,
    root,
    candidateManifest,
    currentManifest,
    expectedCandidateSha,
    publicKey,
    mode: activation
      ? RELEASE_MANIFEST_POINTER_GUARD_MODES.ACTIVATION
      : RELEASE_MANIFEST_POINTER_GUARD_MODES.AUTOMATIC,
    expectedInstalledControlPlaneDigest,
  });
}

function loadReleaseManifestPointerGuardInputs(options) {
  const root = assertRootDirectory(options.root);
  readBoundedRegularFile(path.join(root, CONTINUOUS_DEPLOYMENT_POLICY_PATH), {
    label: 'continuous deployment policy',
    maxBytes: MAX_CONTINUOUS_DEPLOYMENT_POLICY_BYTES,
  });
  const policy = loadContinuousDeploymentPolicy(root);
  const schemaPolicy = loadReleaseManifestSchemaPolicy(root);

  const publicKeyPath = resolveContainedInputPath(
    root,
    options.publicKey,
    'committed public key path',
  );
  const committedPublicKeyPath = path.join(root, RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH);
  if (publicKeyPath !== committedPublicKeyPath) {
    fail(`public key must be the committed ${RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH}`);
  }
  readBoundedRegularFile(publicKeyPath, {
    label: 'committed release manifest public key',
    maxBytes: MAX_PUBLIC_KEY_BYTES,
  });

  const maxManifestBytes = policy.trust.maxManifestBytes;
  const candidateBytes = readBoundedRegularFile(
    resolveContainedInputPath(root, options.candidateManifest, 'candidate manifest path'),
    { label: 'candidate manifest', maxBytes: maxManifestBytes },
  );
  const currentBytes = readBoundedRegularFile(
    resolveContainedInputPath(root, options.currentManifest, 'current manifest path'),
    { label: 'current manifest', maxBytes: maxManifestBytes },
  );
  return {
    policy,
    schemaPolicy,
    publicKeyPath,
    candidateEnvelope: parseReleaseManifestBytes({ bytes: candidateBytes, policy }),
    currentEnvelope: parseReleaseManifestBytes({ bytes: currentBytes, policy }),
  };
}

function usage() {
  return `release-manifest-pointer-guard — verify signed pointer generations

Usage:
  node scripts/release-manifest-pointer-guard.mjs \\
    --candidate-manifest <file> \\
    --current-manifest <file> \\
    --expected-candidate-sha <40-lowercase-hex> \\
    [--public-key ${RELEASE_MANIFEST_COMMITTED_PUBLIC_KEY_PATH}] [--root <repo>]

Activation additionally requires:
  --activation --expected-installed-control-plane-digest <64-lowercase-hex>
`;
}

export function runReleaseManifestPointerGuardCli(
  argv = process.argv.slice(2),
  { nowMs = Date.now(), defaultRoot = process.cwd() } = {},
) {
  const options = parseReleaseManifestPointerGuardArgs(argv, { defaultRoot });
  if (options.help) return { status: 0, stdout: usage(), stderr: '' };
  const inputs = loadReleaseManifestPointerGuardInputs(options);
  const result = verifyReleaseManifestPointer({
    ...inputs,
    expectedCandidateSha: options.expectedCandidateSha,
    mode: options.mode,
    expectedInstalledControlPlaneDigest: options.expectedInstalledControlPlaneDigest,
    nowMs,
  });
  return { status: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const output = runReleaseManifestPointerGuardCli();
    process.stdout.write(output.stdout);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
