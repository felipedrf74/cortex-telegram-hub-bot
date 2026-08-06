#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  backendIosContractFixtureIdentity,
  canonicalJson,
  sha256,
} from './lib/backend-ios-contract-fixture.mjs';
import { validateIosContractAttestation } from './lib/ios-contract-attestation.mjs';
import { validateIosDistributionAttestation } from './lib/ios-distribution-attestation.mjs';
import { verifyReleaseBundle } from './lib/release-artifact-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_SCHEMA = 'nexus.shared-ios-release-gate.v1';
const EXPECTED_PRODUCTION_CHECKS = Object.freeze({
  artifactParity: 'passed',
  migrationStartup: 'passed',
  authenticatedSmoke: 'passed',
  databaseIntegrity: 'passed',
  prePromotionBackup: 'passed',
  rollbackReadiness: 'passed',
});

function fail(message) {
  throw new Error(message);
}

function parseTimestamp(value, label) {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) fail(`${label} timestamp is invalid`);
  return parsed;
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function validateCheckpointManifest(manifest, expectedBackendRuntimeSha, verifiedBundle) {
  exactObject(manifest, 'release checksum manifest');
  const artifact = exactObject(manifest.artifact, 'release checksum manifest artifact');
  if (manifest.schema !== 'nexus.release-checksum-manifest.v1'
      || manifest.sourceSha !== expectedBackendRuntimeSha
      || artifact.sha256 !== verifiedBundle.digest
      || artifact.name !== `release-bundle-${expectedBackendRuntimeSha}-${verifiedBundle.digest}`
      || manifest.version !== verifiedBundle.marker.packageVersion) {
    fail('release checksum manifest does not bind the exact backend runtime bundle');
  }
}

function validateProductionState(state, manifest, nowMs) {
  exactObject(state, 'production release transaction');
  const checks = exactObject(state.checks, 'production release transaction checks');
  const startedAtMs = parseTimestamp(state.startedAt, 'production startedAt');
  const soakStartedAtMs = parseTimestamp(state.soakStartedAt, 'production soakStartedAt');
  const soakCompletedAtMs = parseTimestamp(state.soakCompletedAt, 'production soakCompletedAt');
  const completedAtMs = parseTimestamp(state.completedAt, 'production completedAt');
  const updatedAtMs = parseTimestamp(state.updatedAt, 'production updatedAt');
  if (state.schema !== 'nexus.lean-release-transaction.v1'
      || state.role !== 'production'
      || !/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(state.transactionId ?? '')
      || state.runtimeSha !== manifest.sourceSha
      || state.artifactDigest !== manifest.artifact.sha256
      || state.phase !== 'completed'
      || state.status !== 'passed'
      || state.healthResult !== 'passed'
      || state.rollbackResult !== 'not_required'
      || state.rollbackDurationMs !== null
      || state.faultInjection !== null
      || state.candidateRemoved !== false
      || state.predecessorSha !== manifest.releaseImpact?.deployedSha
      || !Number.isSafeInteger(state.stabilitySeconds)
      || state.stabilitySeconds < 60
      || soakCompletedAtMs - soakStartedAtMs < state.stabilitySeconds * 1_000
      || state.candidateHealthBudgetSeconds !== 45
      || state.rollbackHealthBudgetSeconds !== 45
      || state.rollbackObjectiveSeconds !== 120
      || startedAtMs > soakStartedAtMs
      || soakCompletedAtMs > completedAtMs
      || completedAtMs > updatedAtMs
      || completedAtMs > nowMs + 5 * 60_000
      || typeof state.releaseDir !== 'string'
      || !state.releaseDir.startsWith('/home/dominguez/telegram-hub-bot/releases/')
      || typeof state.predecessor !== 'string'
      || !state.predecessor.startsWith('/home/dominguez/telegram-hub-bot/releases/')
      || state.predecessor === state.releaseDir
      || canonicalJson(checks) !== canonicalJson(EXPECTED_PRODUCTION_CHECKS)) {
    fail('production release transaction is not a passing exact-manifest promotion');
  }
  return completedAtMs;
}

/**
 * Evaluate already-parsed evidence. The caller must supply the canonical
 * checkpoint validator; the CLI always supplies the repository's existing
 * manifest + transaction validators before this cross-repository layer runs.
 */
export function evaluateSharedIosReleaseGate({
  manifest,
  bundleRoot,
  productionState,
  contractAttestation,
  distributionAttestation,
  expectedBackendRuntimeSha,
  expectedIosSha,
  expectedIosBuildNumber,
  trustedRoot,
  nowMs = Date.now(),
  canonicalCheckpointValidator,
}) {
  if (typeof canonicalCheckpointValidator !== 'function') {
    fail('canonical backend checkpoint validator is required');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedBackendRuntimeSha ?? '')) {
    fail('expected backend runtime SHA is invalid');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedIosSha ?? '')) fail('expected iOS SHA is invalid');
  if (!/^[1-9][0-9]*$/.test(String(expectedIosBuildNumber ?? ''))) {
    fail('expected iOS build number is invalid');
  }
  if (!Number.isFinite(nowMs)) fail('shared release gate time is invalid');
  let gateGeneratedAt;
  try {
    gateGeneratedAt = new Date(nowMs).toISOString();
  } catch {
    fail('shared release gate time is invalid');
  }

  canonicalCheckpointValidator();
  const verifiedBundle = verifyReleaseBundle(bundleRoot, expectedBackendRuntimeSha);
  validateCheckpointManifest(manifest, expectedBackendRuntimeSha, verifiedBundle);
  const productionCompletedAtMs = validateProductionState(productionState, manifest, nowMs);
  const fixture = backendIosContractFixtureIdentity({
    bundleRoot: verifiedBundle.bundleRoot,
    artifact: verifiedBundle.manifest,
  });

  const contract = validateIosContractAttestation({
    attestation: contractAttestation,
    backendRuntimeSha: expectedBackendRuntimeSha,
    backendArtifactDigest: verifiedBundle.digest,
    backendFixtureDigest: fixture.digest,
    iosSha: expectedIosSha,
    buildNumber: expectedIosBuildNumber,
    trustedRoot,
    nowMs,
  });
  const distribution = validateIosDistributionAttestation({
    attestation: distributionAttestation,
    iosSha: expectedIosSha,
    buildNumber: expectedIosBuildNumber,
    trustedRoot,
    nowMs,
  });

  if (contract.binding.iosSha !== distribution.binding.sourceCommit
      || contract.binding.buildNumber !== distribution.binding.release.sourceBuildNumber) {
    fail('iOS compatibility and distribution attestations describe different source builds');
  }
  const contractGeneratedAtMs = parseTimestamp(
    contract.payload.generatedAt,
    'iOS compatibility generatedAt',
  );
  const productionStartedAtMs = parseTimestamp(productionState.startedAt, 'production startedAt');
  if (contractGeneratedAtMs > productionStartedAtMs) {
    fail('iOS compatibility attestation postdates the start of backend production promotion');
  }
  const distributionGeneratedAtMs = parseTimestamp(
    distribution.payload.generatedAt,
    'iOS distribution generatedAt',
  );
  if (distributionGeneratedAtMs < productionCompletedAtMs) {
    fail('iOS distribution attestation predates the completed backend production promotion');
  }

  return {
    schema: RECEIPT_SCHEMA,
    result: 'passed',
    generatedAt: gateGeneratedAt,
    backend: {
      runtimeSha: expectedBackendRuntimeSha,
      artifactDigest: verifiedBundle.digest,
      manifestDigest: sha256(canonicalJson(manifest)),
      fixture: {
        schema: fixture.fixture.schema,
        path: fixture.relativePath,
        digest: fixture.digest,
      },
    },
    production: {
      transactionId: productionState.transactionId,
      stateDigest: sha256(canonicalJson(productionState)),
      completedAt: productionState.completedAt,
    },
    ios: {
      sourceSha: expectedIosSha,
      sourceBuildNumber: String(expectedIosBuildNumber),
      distributedBuildNumber: distribution.binding.release.distributedBuildNumber,
      contractAttestationDigest: contract.binding.attestationDigest,
      contractSelectionDigest: contract.binding.selectionDigest,
      distributionAttestationDigest: distribution.binding.attestationDigest,
      exportedArtifactDigest: distribution.binding.exportedArtifact.artifactDigest,
    },
    chronology: {
      contractGeneratedAt: contract.payload.generatedAt,
      productionStartedAt: productionState.startedAt,
      productionCompletedAt: productionState.completedAt,
      distributionGeneratedAt: distribution.payload.generatedAt,
    },
  };
}

function stableStatMatches(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertPrivateInputStat(stat, label, maxBytes) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} is a symbolic link or non-file`);
  }
  if (stat.nlink !== 1n) fail(`${label} is hard-linked`);
  if (stat.uid !== BigInt(currentUid()) || (stat.mode & 0o077n) !== 0n) {
    fail(`${label} mode or owner is unsafe`);
  }
  if (stat.size <= 0n || stat.size > BigInt(maxBytes)) {
    fail(`${label} is not a bounded regular file`);
  }
}

/**
 * Read one release input through a no-follow descriptor and retain only its
 * canonical bytes. The original caller path is never reopened by the gate.
 */
export function readPrivateReleaseJson(filePath, label, maxBytes) {
  const resolved = path.resolve(filePath);
  assertPathComponentsAreNotSymlinks(resolved, label);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.uid !== BigInt(currentUid()) || (parentStat.mode & 0o077n) !== 0n) {
    fail(`${label} parent mode or owner is unsafe`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(resolved, flags);
  let bytes;
  let before;
  let after;
  try {
    before = fs.fstatSync(descriptor, { bigint: true });
    assertPrivateInputStat(before, label, maxBytes);
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor, { bigint: true });
    assertPrivateInputStat(after, label, maxBytes);
    if (!stableStatMatches(before, after) || BigInt(bytes.length) !== after.size) {
      fail(`${label} changed while it was being read`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  assertPathComponentsAreNotSymlinks(resolved, label);
  const pathStat = fs.lstatSync(resolved, { bigint: true });
  assertPrivateInputStat(pathStat, label, maxBytes);
  if (!stableStatMatches(after, pathStat)) fail(`${label} changed after it was read`);

  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} JSON is invalid`);
  }
  exactObject(value, label);
  const canonicalBytes = Buffer.from(canonicalJson(value));
  return {
    path: resolved,
    value,
    canonicalBytes,
    digest: sha256(canonicalBytes),
  };
}

function writePrivateCanonicalSnapshot(directory, name, input) {
  if (!input || !Buffer.isBuffer(input.canonicalBytes)
      || input.digest !== sha256(input.canonicalBytes)) {
    fail(`${name} canonical snapshot input is invalid`);
  }
  const filename = path.join(directory, name);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(filename, flags, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, input.canonicalBytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return filename;
}

/**
 * Give canonical child validators private immutable snapshots, then prove the
 * exact snapshot bytes survived validation before returning their result.
 */
export function withCanonicalCheckpointSnapshots({ manifestInput, productionInput }, callback) {
  if (typeof callback !== 'function') fail('canonical checkpoint snapshot callback is required');
  const snapshotRoot = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'nexus-shared-ios-checkpoint-',
  ));
  fs.chmodSync(snapshotRoot, 0o700);
  const manifestPath = writePrivateCanonicalSnapshot(
    snapshotRoot,
    'release-manifest.json',
    manifestInput,
  );
  const productionStatePath = writePrivateCanonicalSnapshot(
    snapshotRoot,
    'production-state.json',
    productionInput,
  );
  try {
    const result = callback({ manifestPath, productionStatePath });
    const verifiedManifest = readPrivateReleaseJson(
      manifestPath,
      'canonical release manifest snapshot',
      4 * 1024 * 1024,
    );
    const verifiedProduction = readPrivateReleaseJson(
      productionStatePath,
      'canonical production state snapshot',
      256 * 1024,
    );
    if (verifiedManifest.digest !== manifestInput.digest
        || verifiedProduction.digest !== productionInput.digest) {
      fail('canonical checkpoint snapshots changed during validation');
    }
    return result;
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

function assertRegularDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a regular directory`);
  return resolved;
}

function canonicalCheckpointValidator({
  manifestPath,
  manifest,
  bundleRoot,
  productionStatePath,
}) {
  const script = path.join(root, 'scripts/release-checksum-manifest.mjs');
  execFileSync(process.execPath, [
    script,
    'validate',
    '--manifest', manifestPath,
    '--bundle', bundleRoot,
    '--expect-source-sha', manifest.sourceSha,
    '--expect-artifact-digest', manifest.artifact?.sha256 ?? '',
  ], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync(process.execPath, [
    script,
    'validate-state',
    '--manifest', manifestPath,
    '--state', productionStatePath,
    '--role', 'production',
  ], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
}

function currentUid() {
  if (typeof process.getuid !== 'function') fail('receipt owner verification is unavailable');
  return process.getuid();
}

function assertPathComponentsAreNotSymlinks(resolvedPath, label) {
  const parsed = path.parse(resolvedPath);
  const parts = resolvedPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`${label} path includes a symbolic link`);
    if (cursor !== resolvedPath && !stat.isDirectory()) {
      fail(`${label} path includes a non-directory parent`);
    }
  }
}

function preparePrivateReceiptParent(parent) {
  assertPathComponentsAreNotSymlinks(parent, 'shared iOS release gate receipt parent');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPathComponentsAreNotSymlinks(parent, 'shared iOS release gate receipt parent');
  const before = fs.lstatSync(parent);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== currentUid()) {
    fail('shared iOS release gate receipt parent mode or owner is unsafe');
  }
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY ?? 0)
    | (fs.constants.O_NOFOLLOW ?? 0);
  const directoryFd = fs.openSync(parent, flags);
  try {
    const opened = fs.fstatSync(directoryFd);
    if (!opened.isDirectory()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.uid !== currentUid()) {
      fail('shared iOS release gate receipt parent changed during verification');
    }
    fs.fchmodSync(directoryFd, 0o700);
    const secured = fs.fstatSync(directoryFd);
    if ((secured.mode & 0o777) !== 0o700 || secured.uid !== currentUid()) {
      fail('shared iOS release gate receipt parent mode or owner is unsafe');
    }
    return directoryFd;
  } catch (error) {
    fs.closeSync(directoryFd);
    throw error;
  }
}

function assertPrivateSingleLinkFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('shared iOS release gate receipt is a symbolic link or non-file');
  }
  if (stat.nlink !== 1) fail('shared iOS release gate receipt is hard-linked');
  if (stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o600) {
    fail('shared iOS release gate receipt mode or owner is unsafe');
  }
}

export function writeSharedIosReleaseGateReceipt(outputPath, receipt) {
  const resolved = path.resolve(outputPath);
  const parent = path.dirname(resolved);
  const parentFd = preparePrivateReceiptParent(parent);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    assertPathComponentsAreNotSymlinks(resolved, 'shared iOS release gate receipt');
    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      assertPrivateSingleLinkFile(stat);
      if (!fs.readFileSync(resolved).equals(bytes)) {
        fail('shared iOS release gate receipt already exists with different evidence');
      }
      return resolved;
    }

    const flags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(resolved, flags, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      assertPrivateSingleLinkFile(fs.fstatSync(fd));
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      assertPrivateSingleLinkFile(fs.fstatSync(fd));
    } finally {
      fs.closeSync(fd);
    }
    const written = fs.lstatSync(resolved);
    assertPrivateSingleLinkFile(written);
    fs.fsyncSync(parentFd);
    return resolved;
  } finally {
    fs.closeSync(parentFd);
  }
}

export function runSharedIosReleaseGate({
  manifestPath,
  bundleRoot,
  productionStatePath,
  contractAttestationPath,
  distributionAttestationPath,
  expectedBackendRuntimeSha,
  expectedIosSha,
  expectedIosBuildNumber,
  outputPath,
  nowMs = Date.now(),
}) {
  const resolvedBundle = assertRegularDirectory(bundleRoot, 'release bundle');
  const resolvedTrustedRoot = assertRegularDirectory(root, 'trusted repository root');
  const manifestInput = readPrivateReleaseJson(
    manifestPath,
    'release checksum manifest',
    4 * 1024 * 1024,
  );
  const productionInput = readPrivateReleaseJson(
    productionStatePath,
    'production release transaction',
    256 * 1024,
  );
  const contractInput = readPrivateReleaseJson(
    contractAttestationPath,
    'iOS contract attestation',
    512 * 1024,
  );
  const distributionInput = readPrivateReleaseJson(
    distributionAttestationPath,
    'iOS distribution attestation',
    512 * 1024,
  );
  const receipt = withCanonicalCheckpointSnapshots({ manifestInput, productionInput }, ({
    manifestPath: manifestSnapshotPath,
    productionStatePath: productionSnapshotPath,
  }) => evaluateSharedIosReleaseGate({
    manifest: manifestInput.value,
    bundleRoot: resolvedBundle,
    productionState: productionInput.value,
    contractAttestation: contractInput.value,
    distributionAttestation: distributionInput.value,
    expectedBackendRuntimeSha,
    expectedIosSha,
    expectedIosBuildNumber,
    trustedRoot: resolvedTrustedRoot,
    nowMs,
    canonicalCheckpointValidator: () => canonicalCheckpointValidator({
      manifestPath: manifestSnapshotPath,
      manifest: manifestInput.value,
      bundleRoot: resolvedBundle,
      productionStatePath: productionSnapshotPath,
    }),
  }));
  if (receipt.backend.manifestDigest !== manifestInput.digest
      || receipt.production.stateDigest !== productionInput.digest
      || receipt.ios.contractAttestationDigest !== contractInput.digest
      || receipt.ios.distributionAttestationDigest !== distributionInput.digest) {
    fail('shared release receipt does not bind the exact validated input bytes');
  }
  return { receipt, output: writeSharedIosReleaseGateReceipt(outputPath, receipt) };
}

function parseArgs(argv) {
  const allowed = new Set([
    '--manifest', '--bundle', '--production-state', '--ios-contract-attestation',
    '--ios-distribution-attestation', '--expect-backend-runtime-sha', '--expect-ios-sha',
    '--expect-ios-build-number', '--output',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values[key]) fail(`unknown, duplicated, or valueless option: ${key}`);
    values[key] = value;
  }
  for (const required of allowed) {
    if (!values[required]) fail(`missing required option: ${required}`);
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = runSharedIosReleaseGate({
      manifestPath: args['--manifest'],
      bundleRoot: args['--bundle'],
      productionStatePath: args['--production-state'],
      contractAttestationPath: args['--ios-contract-attestation'],
      distributionAttestationPath: args['--ios-distribution-attestation'],
      expectedBackendRuntimeSha: args['--expect-backend-runtime-sha'],
      expectedIosSha: args['--expect-ios-sha'],
      expectedIosBuildNumber: args['--expect-ios-build-number'],
      outputPath: args['--output'],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
