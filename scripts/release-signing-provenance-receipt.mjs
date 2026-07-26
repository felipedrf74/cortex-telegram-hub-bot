#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT_SCHEMA = 'nexus.release-signing-provenance-receipt.v1';
const SOURCE_SCHEMA = 'nexus.release-signing-provenance.v3';
const REPOSITORY = 'felipedrf74/cortex-telegram-hub-bot';
const WORKFLOW_NAME = 'Release — Sign exact candidate';
const WORKFLOW_PATH = '.github/workflows/sign-release-manifest.yml';
const MANIFEST_SCHEMA = 'nexus.release-manifest.v2';
const MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RUN_ID = /^[1-9][0-9]*$/u;

function fail(message) {
  throw new Error(message);
}

function valueOf(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) fail(`${name} is required`);
  return process.argv[index + 1];
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} has unexpected fields`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value ?? '');
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
}

function githubTimestamp(value, label) {
  const milliseconds = Date.parse(value ?? '');
  if (!Number.isFinite(milliseconds) || typeof value !== 'string') {
    fail(`${label} is not a GitHub timestamp`);
  }
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical
      && value !== canonical.replace(/\.000Z$/u, 'Z')) {
    fail(`${label} is not a canonical GitHub timestamp`);
  }
  return milliseconds;
}

function readRegular(file, label, { privateFile = false } = {}) {
  const resolved = path.resolve(file);
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size <= 0 || before.size > MAX_JSON_BYTES
      || (privateFile && (
        before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600
      ))) {
    fail(`${label} is not a safe regular file`);
  }
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) {
      fail(`${label} changed while it was opened`);
    }
    const body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== body.length) {
      fail(`${label} changed while it was read`);
    }
    return body;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(file, label, options) {
  const body = readRegular(file, label, options);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { body, parsed };
}

function parseManifest(file, runtimeSha) {
  const { body, parsed: manifest } = readJson(
    file,
    'release manifest',
  );
  const payload = manifest?.payload;
  const artifactDigest = payload?.artifact?.digest;
  const candidateRunId = String(payload?.ci?.runId ?? '');
  const candidateRunAttempt = String(payload?.ci?.runAttempt ?? '');
  if (manifest?.schema !== MANIFEST_SCHEMA
      || payload?.runtimeSha !== runtimeSha
      || payload?.source?.dirty !== false
      || !DIGEST.test(artifactDigest ?? '')
      || !RUN_ID.test(candidateRunId)
      || !RUN_ID.test(candidateRunAttempt)
      || payload?.ci?.provider !== 'github-actions'
      || payload?.ci?.workflow !== 'RC — Release Evidence') {
    fail('release manifest identity is invalid for signer provenance');
  }
  const expiresAt = canonicalTimestamp(
    payload.expiresAt,
    'release manifest expiresAt',
  );
  if (expiresAt <= Date.now()) fail('release manifest is expired');
  return {
    artifactDigest,
    body,
    candidateRunAttempt,
    candidateRunId,
    expiresAt: payload.expiresAt,
    manifest,
    payloadSha256: sha256(canonicalJson(payload)),
  };
}

function validateSourceProvenance(source, body, expected) {
  exactObject(source, [
    'artifactDigest',
    'candidateArtifactDigest',
    'candidateArtifactId',
    'candidateRunAttempt',
    'candidateRunId',
    'iosAttestationDigest',
    'iosContractDigest',
    'iosContractFixtureDigest',
    'iosDistributionAttestationDigest',
    'iosDistributionCiBuildId',
    'iosDistributionPayloadDigest',
    'iosEvidenceRunAttempt',
    'iosEvidenceRunId',
    'keyId',
    'nightlyArtifactDigest',
    'nightlyArtifactId',
    'nightlyRunId',
    'runtimeSha',
    'schema',
    'signedAt',
    'signingRunAttempt',
    'signingRunId',
    'trustedToolingSha',
  ], 'release signing source provenance');
  const signingRunId = String(source.signingRunId ?? '');
  const signingRunAttempt = String(source.signingRunAttempt ?? '');
  if (source.schema !== SOURCE_SCHEMA
      || source.runtimeSha !== expected.runtimeSha
      || source.artifactDigest !== expected.artifactDigest
      || String(source.candidateRunId ?? '') !== expected.candidateRunId
      || String(source.candidateRunAttempt ?? '') !== expected.candidateRunAttempt
      || !RUN_ID.test(signingRunId)
      || !RUN_ID.test(signingRunAttempt)
      || signingRunId !== expected.signingRunId
      || signingRunId === expected.candidateRunId
      || !SHA.test(source.trustedToolingSha ?? '')
      || typeof source.keyId !== 'string'
      || source.keyId.length < 1) {
    fail('release signing source provenance identity is invalid');
  }
  const signedAt = canonicalTimestamp(
    source.signedAt,
    'release signing source signedAt',
  );
  if (signedAt > Date.now() + CLOCK_SKEW_MS) {
    fail('release signing source provenance is from the future');
  }
  return {
    bodySha256: sha256(body),
    keyId: source.keyId,
    signedAt: source.signedAt,
    signingRunAttempt,
    signingRunId,
    trustedToolingSha: source.trustedToolingSha,
  };
}

function validateRunMetadata(run, expected) {
  const runId = String(run?.id ?? '');
  const runAttempt = String(run?.run_attempt ?? '');
  const createdAt = githubTimestamp(
    run?.created_at,
    'release signing run created_at',
  );
  if (runId !== expected.signingRunId
      || runAttempt !== expected.signingRunAttempt
      || run?.name !== WORKFLOW_NAME
      || run?.path !== WORKFLOW_PATH
      || run?.event !== 'workflow_dispatch'
      || run?.head_branch !== 'main'
      || run?.head_sha !== expected.runtimeSha
      || run?.status !== 'completed'
      || run?.conclusion !== 'success'
      || run?.repository?.full_name !== REPOSITORY
      || createdAt > expected.signedAt + CLOCK_SKEW_MS) {
    fail('release signing GitHub run identity is invalid');
  }
  return {
    createdAt: new Date(createdAt).toISOString(),
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    runAttempt,
    runId,
    workflow: run.name,
    workflowPath: run.path,
  };
}

function validateArtifactMetadata(metadata, expected) {
  if (!metadata || !Array.isArray(metadata.artifacts)) {
    fail('release signing artifact metadata is invalid');
  }
  const name = `release-manifest-v2-${expected.runtimeSha}`;
  const matching = metadata.artifacts.filter((artifact) => artifact?.name === name);
  if (matching.length !== 1) {
    fail('release signing artifact identity is missing or ambiguous');
  }
  const artifact = matching[0];
  const artifactId = String(artifact.id ?? '');
  const sizeInBytes = Number(artifact.size_in_bytes);
  if (!RUN_ID.test(artifactId)
      || !Number.isSafeInteger(sizeInBytes)
      || sizeInBytes <= 0
      || !ARTIFACT_DIGEST.test(artifact.digest ?? '')
      || artifact.expired !== false
      || String(artifact.workflow_run?.id ?? '') !== expected.signingRunId
      || artifact.workflow_run?.head_sha !== expected.runtimeSha) {
    fail('release signing artifact identity is invalid');
  }
  return {
    artifactDigest: artifact.digest,
    artifactId,
    artifactName: name,
    sizeInBytes,
    workflowHeadSha: artifact.workflow_run.head_sha,
    workflowRunId: String(artifact.workflow_run.id),
  };
}

function validateReceipt(receipt, manifestIdentity, now = Date.now()) {
  exactObject(receipt, [
    'candidate',
    'downloadedArtifact',
    'manifest',
    'protectedSigning',
    'recordedAt',
    'repository',
    'runtimeSha',
    'schema',
    'sourceProvenance',
  ], 'release signing provenance receipt');
  exactObject(receipt.candidate, [
    'runAttempt',
    'runId',
  ], 'release signing receipt candidate');
  exactObject(receipt.manifest, [
    'artifactDigest',
    'expiresAt',
    'payloadSha256',
    'sha256',
  ], 'release signing receipt manifest');
  exactObject(receipt.protectedSigning, [
    'createdAt',
    'event',
    'headBranch',
    'headSha',
    'runAttempt',
    'runId',
    'workflow',
    'workflowPath',
  ], 'release signing receipt protected run');
  exactObject(receipt.downloadedArtifact, [
    'artifactDigest',
    'artifactId',
    'artifactName',
    'sizeInBytes',
    'workflowHeadSha',
    'workflowRunId',
  ], 'release signing receipt downloaded artifact');
  exactObject(receipt.sourceProvenance, [
    'keyId',
    'sha256',
    'signedAt',
    'signingRunAttempt',
    'signingRunId',
    'trustedToolingSha',
  ], 'release signing receipt source provenance');

  const recordedAt = canonicalTimestamp(
    receipt.recordedAt,
    'release signing receipt recordedAt',
  );
  const createdAt = canonicalTimestamp(
    receipt.protectedSigning.createdAt,
    'release signing receipt protected run createdAt',
  );
  const sourceSignedAt = canonicalTimestamp(
    receipt.sourceProvenance.signedAt,
    'release signing receipt source signedAt',
  );
  if (receipt.schema !== RECEIPT_SCHEMA
      || receipt.repository !== REPOSITORY
      || receipt.runtimeSha !== manifestIdentity.manifest.payload.runtimeSha
      || receipt.candidate.runId !== manifestIdentity.candidateRunId
      || receipt.candidate.runAttempt !== manifestIdentity.candidateRunAttempt
      || receipt.manifest.artifactDigest !== manifestIdentity.artifactDigest
      || receipt.manifest.sha256 !== sha256(manifestIdentity.body)
      || receipt.manifest.payloadSha256 !== manifestIdentity.payloadSha256
      || receipt.manifest.expiresAt !== manifestIdentity.expiresAt
      || !DIGEST.test(receipt.sourceProvenance.sha256 ?? '')
      || !SHA.test(receipt.sourceProvenance.trustedToolingSha ?? '')
      || receipt.sourceProvenance.signingRunId
        !== receipt.protectedSigning.runId
      || receipt.sourceProvenance.signingRunAttempt
        !== receipt.protectedSigning.runAttempt
      || !RUN_ID.test(receipt.protectedSigning.runId ?? '')
      || receipt.protectedSigning.runId === receipt.candidate.runId
      || !RUN_ID.test(receipt.protectedSigning.runAttempt ?? '')
      || receipt.protectedSigning.workflow !== WORKFLOW_NAME
      || receipt.protectedSigning.workflowPath !== WORKFLOW_PATH
      || receipt.protectedSigning.event !== 'workflow_dispatch'
      || receipt.protectedSigning.headBranch !== 'main'
      || receipt.protectedSigning.headSha !== receipt.runtimeSha
      || receipt.downloadedArtifact.artifactName
        !== `release-manifest-v2-${receipt.runtimeSha}`
      || !RUN_ID.test(receipt.downloadedArtifact.artifactId ?? '')
      || !ARTIFACT_DIGEST.test(
        receipt.downloadedArtifact.artifactDigest ?? '',
      )
      || !Number.isSafeInteger(receipt.downloadedArtifact.sizeInBytes)
      || receipt.downloadedArtifact.sizeInBytes <= 0
      || receipt.downloadedArtifact.workflowRunId
        !== receipt.protectedSigning.runId
      || receipt.downloadedArtifact.workflowHeadSha !== receipt.runtimeSha
      || createdAt > sourceSignedAt + CLOCK_SKEW_MS
      || recordedAt !== sourceSignedAt
      || recordedAt > now + CLOCK_SKEW_MS
      || now - recordedAt > MAX_RECEIPT_AGE_MS
      || Date.parse(receipt.manifest.expiresAt) <= now) {
    fail('release signing provenance receipt identity is invalid or stale');
  }
  return receipt;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function completeWrite(descriptor, body) {
  let offset = 0;
  while (offset < body.length) {
    const written = fs.writeSync(
      descriptor,
      body,
      offset,
      body.length - offset,
      offset,
    );
    if (!Number.isSafeInteger(written) || written <= 0) {
      fail('release signing provenance receipt write was incomplete');
    }
    offset += written;
  }
  fs.fsyncSync(descriptor);
}

function atomicInstall(destination, body) {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.uid !== process.getuid()
      || (parentStat.mode & 0o077) !== 0) {
    fail('release signing provenance receipt directory is unsafe');
  }
  if (fs.existsSync(resolved) || fs.lstatSync(parent).isSymbolicLink()) {
    const existing = readRegular(
      resolved,
      'existing release signing provenance receipt',
      { privateFile: true },
    );
    if (!existing.equals(body)) {
      fail('existing release signing provenance receipt differs');
    }
    return;
  }
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.next.${process.pid}.${crypto.randomBytes(8).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    completeWrite(descriptor, body);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, resolved);
    fsyncDirectory(parent);
    fs.unlinkSync(temporary);
    fsyncDirectory(parent);
    const installed = readRegular(
      resolved,
      'installed release signing provenance receipt',
      { privateFile: true },
    );
    if (!installed.equals(body)) {
      fail('installed release signing provenance receipt is incomplete');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function installReceipt() {
  const runtimeSha = valueOf('--runtime-sha');
  const candidateRunId = valueOf('--candidate-run-id');
  const signingRunId = valueOf('--signing-run-id');
  if (!SHA.test(runtimeSha) || !RUN_ID.test(candidateRunId)
      || !RUN_ID.test(signingRunId) || signingRunId === candidateRunId) {
    fail('release signing receipt command identity is invalid');
  }
  const manifestIdentity = parseManifest(valueOf('--manifest'), runtimeSha);
  if (manifestIdentity.candidateRunId !== candidateRunId) {
    fail('release signing receipt candidate run does not match the manifest');
  }
  const { body: sourceBody, parsed: source } = readJson(
    valueOf('--source-provenance'),
    'release signing source provenance',
  );
  const sourceIdentity = validateSourceProvenance(source, sourceBody, {
    artifactDigest: manifestIdentity.artifactDigest,
    candidateRunAttempt: manifestIdentity.candidateRunAttempt,
    candidateRunId,
    runtimeSha,
    signingRunId,
  });
  const { parsed: run } = readJson(
    valueOf('--run-metadata'),
    'release signing run metadata',
  );
  const protectedSigning = validateRunMetadata(run, {
    runtimeSha,
    signedAt: Date.parse(sourceIdentity.signedAt),
    signingRunAttempt: sourceIdentity.signingRunAttempt,
    signingRunId,
  });
  const { parsed: artifacts } = readJson(
    valueOf('--artifact-metadata'),
    'release signing artifact metadata',
  );
  const downloadedArtifact = validateArtifactMetadata(artifacts, {
    runtimeSha,
    signingRunId,
  });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    repository: REPOSITORY,
    runtimeSha,
    recordedAt: sourceIdentity.signedAt,
    candidate: {
      runId: candidateRunId,
      runAttempt: manifestIdentity.candidateRunAttempt,
    },
    protectedSigning,
    downloadedArtifact,
    manifest: {
      sha256: sha256(manifestIdentity.body),
      payloadSha256: manifestIdentity.payloadSha256,
      artifactDigest: manifestIdentity.artifactDigest,
      expiresAt: manifestIdentity.expiresAt,
    },
    sourceProvenance: {
      sha256: sourceIdentity.bodySha256,
      signingRunId: sourceIdentity.signingRunId,
      signingRunAttempt: sourceIdentity.signingRunAttempt,
      trustedToolingSha: sourceIdentity.trustedToolingSha,
      keyId: sourceIdentity.keyId,
      signedAt: sourceIdentity.signedAt,
    },
  };
  validateReceipt(receipt, manifestIdentity);
  const body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  atomicInstall(valueOf('--destination'), body);
  return receipt;
}

function verifyReceipt() {
  const runtimeSha = valueOf('--expect-runtime-sha');
  if (!SHA.test(runtimeSha)) fail('expected runtime SHA is invalid');
  const manifestIdentity = parseManifest(valueOf('--manifest'), runtimeSha);
  const { parsed: receipt } = readJson(
    valueOf('--receipt'),
    'release signing provenance receipt',
    { privateFile: true },
  );
  const validated = validateReceipt(receipt, manifestIdentity);
  const runMetadataIndex = process.argv.indexOf('--run-metadata');
  const artifactMetadataIndex = process.argv.indexOf('--artifact-metadata');
  if ((runMetadataIndex >= 0) !== (artifactMetadataIndex >= 0)) {
    fail('live signing run and artifact metadata must be supplied together');
  }
  if (runMetadataIndex >= 0) {
    const { parsed: run } = readJson(
      valueOf('--run-metadata'),
      'live release signing run metadata',
    );
    const liveRun = validateRunMetadata(run, {
      runtimeSha,
      signedAt: Date.parse(validated.sourceProvenance.signedAt),
      signingRunAttempt: validated.protectedSigning.runAttempt,
      signingRunId: validated.protectedSigning.runId,
    });
    const { parsed: artifacts } = readJson(
      valueOf('--artifact-metadata'),
      'live release signing artifact metadata',
    );
    const liveArtifact = validateArtifactMetadata(artifacts, {
      runtimeSha,
      signingRunId: validated.protectedSigning.runId,
    });
    if (canonicalJson(liveRun)
          !== canonicalJson(validated.protectedSigning)
        || canonicalJson(liveArtifact)
          !== canonicalJson(validated.downloadedArtifact)) {
      fail('live release signing provenance differs from the installed receipt');
    }
  }
  return validated;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2];
  try {
    const receipt = command === 'install'
      ? installReceipt()
      : command === 'verify'
        ? verifyReceipt()
        : fail(
          'Usage: release-signing-provenance-receipt.mjs '
          + '<install|verify> [arguments]',
        );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      artifactDigest: receipt.manifest.artifactDigest,
      candidateRunId: receipt.candidate.runId,
      runtimeSha: receipt.runtimeSha,
      signingRunAttempt: receipt.protectedSigning.runAttempt,
      signingRunId: receipt.protectedSigning.runId,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

export {
  installReceipt,
  validateReceipt,
  verifyReceipt,
};
