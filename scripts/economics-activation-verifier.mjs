#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
  sha256,
  validateImmutableToolSourceBinding,
} from './content-ten-script-evidence.mjs';
import {
  ECONOMICS_ARTIFACT_SCHEMA,
  ECONOMICS_PRODUCER_MODULES,
  RATE_CARD_MAX_AGE_MS,
  computeEconomics,
  economicsSourceBindingSha256,
  validateAcceptanceEvidence,
  validateRateCard,
} from './economics-simulation.mjs';
import {
  validateEconomicsActivationAuthentication,
} from './lib/economics-activation-auth.mjs';
import { assertCanonicalTimestamp, canonicalJson } from './lib/release-canonical.mjs';

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ACCEPTANCE_ENTRYPOINT = 'scripts/content-ten-script-evidence.mjs';
const ECONOMICS_ENTRYPOINT = 'scripts/economics-simulation.mjs';
const VERIFIER_ENTRYPOINT = 'scripts/economics-activation-verifier.mjs';

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} does not match the governed schema`);
  }
  return value;
}

function readStdin() {
  const chunks = [];
  let length = 0;
  const descriptor = fs.openSync('/dev/stdin', fs.constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      length += count;
      if (length > MAX_ARTIFACT_BYTES) throw new Error('activation artifact is oversized');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (length < 1) throw new Error('activation artifact is empty');
  return Buffer.concat(chunks, length);
}

function gitBlobObjectId(bytes, expected) {
  const algorithm = expected.length === 64 ? 'sha256' : 'sha1';
  return crypto.createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}

function validateRuntimeProducerSource(value, sourceRoot) {
  const governed = validateImmutableToolSourceBinding(value, {
    producerSourceSha: value?.producerSourceSha,
    entrypoint: ECONOMICS_ENTRYPOINT,
    modulePaths: ECONOMICS_PRODUCER_MODULES,
  });
  for (const module of governed.modules) {
    const filename = path.join(sourceRoot, module.path);
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size < 1n
          || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
        throw new Error('runtime producer module identity is unsafe');
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const mode = (after.mode & 0o111n) === 0n ? '100644' : '100755';
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || bytes.length !== module.byteLength || sha256(bytes) !== module.sha256
          || gitBlobObjectId(bytes, module.gitBlobObjectId) !== module.gitBlobObjectId
          || mode !== module.gitMode) {
        throw new Error('runtime producer module bytes do not match activation evidence');
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return governed;
}

function assertCanonicalEqual(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} does not match the governed input`);
  }
}

function currentReleaseSourceSha() {
  const source = String(process.env.NEXUS_RELEASE_SOURCE_SHA ?? '').trim();
  const legacy = String(process.env.NEXUS_RELEASE_SHA ?? '').trim();
  if (FULL_SHA.test(source) && FULL_SHA.test(legacy) && source !== legacy) {
    throw new Error('serving release source identity is ambiguous');
  }
  if (FULL_SHA.test(source)) return source;
  if (FULL_SHA.test(legacy)) return legacy;
  throw new Error('serving release source identity is unavailable');
}

export function verifyEconomicsActivationArtifact(
  artifact,
  { sourceRoot, authenticationSecret, now = new Date() },
) {
  exactObject(
    artifact,
    ['schemaVersion', 'digestAlgorithm', 'payloadSha256', 'authentication', 'payload'],
    'activation artifact',
  );
  if (artifact.schemaVersion !== ECONOMICS_ARTIFACT_SCHEMA
      || artifact.digestAlgorithm !== 'sha256-canonical-json-payload-v1'
      || !SHA256.test(artifact.payloadSha256 ?? '')) {
    throw new Error('activation artifact schema is not current');
  }
  const computedPayloadSha256 = sha256(Buffer.from(canonicalJson(artifact.payload)));
  if (computedPayloadSha256 !== artifact.payloadSha256) {
    throw new Error('activation artifact payload digest is invalid');
  }
  validateEconomicsActivationAuthentication(
    artifact.authentication,
    artifact.payloadSha256,
    authenticationSecret,
  );

  const payload = exactObject(artifact.payload, [
    'generatedAt', 'workloadSourceSha', 'producerSourceSha', 'producerToolSource',
    'sourceBindingSha256', 'bindings', 'measuredScriptP95', 'measuredOperationP95',
    'result',
  ], 'activation payload');
  assertCanonicalTimestamp(payload.generatedAt, 'activation payload generatedAt');
  const generatedAtMs = Date.parse(payload.generatedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error('activation verification clock is invalid');
  }
  if (generatedAtMs > nowMs || nowMs - generatedAtMs > RATE_CARD_MAX_AGE_MS) {
    throw new Error('activation artifact is outside the 24-hour activation window');
  }
  if (!FULL_SHA.test(payload.workloadSourceSha ?? '')
      || !FULL_SHA.test(payload.producerSourceSha ?? '')
      || payload.workloadSourceSha === payload.producerSourceSha
      || !SHA256.test(payload.sourceBindingSha256 ?? '')) {
    throw new Error('activation artifact release-source pair is invalid');
  }
  const producerToolSource = validateRuntimeProducerSource(payload.producerToolSource, sourceRoot);
  if (producerToolSource.producerSourceSha !== currentReleaseSourceSha()) {
    throw new Error('activation artifact producer source does not match the serving release');
  }

  const bindings = exactObject(payload.bindings, [
    'rateCard', 'acceptance', 'operationUsage', 'release', 'workloadRelease',
  ], 'activation bindings');
  const rateCard = exactObject(bindings.rateCard, [
    'version', 'capturedAt', 'sha256', 'projectedCohortCounts',
    'projectedCohortCountsSha256', 'data',
  ], 'activation rate-card binding');
  validateRateCard(rateCard.data);
  if (rateCard.version !== rateCard.data.version
      || rateCard.capturedAt !== rateCard.data.capturedAt
      || !SHA256.test(rateCard.sha256 ?? '')
      || rateCard.projectedCohortCountsSha256
        !== sha256(Buffer.from(canonicalJson(rateCard.data.projectedCohortCounts)))) {
    throw new Error('activation rate-card binding is invalid');
  }
  assertCanonicalEqual(
    rateCard.projectedCohortCounts,
    rateCard.data.projectedCohortCounts,
    'activation projected cohort counts',
  );

  const acceptance = exactObject(bindings.acceptance, [
    'schemaVersion', 'acceptancePass', 'workloadSourceSha', 'evidenceSha256',
    'stateSha256', 'producerToolSource', 'qualityReviewSha256', 'scopeSha256',
    'workloadReleaseViewSha256', 'evidence',
  ], 'activation acceptance binding');
  const acceptanceToolSource = validateImmutableToolSourceBinding(
    acceptance.producerToolSource,
    {
      producerSourceSha: payload.producerSourceSha,
      entrypoint: ACCEPTANCE_ENTRYPOINT,
      modulePaths: CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
    },
  );
  for (const acceptanceModule of acceptanceToolSource.modules) {
    const runtimeModule = producerToolSource.modules.find(
      (candidate) => candidate.path === acceptanceModule.path,
    );
    assertCanonicalEqual(
      acceptanceModule,
      runtimeModule,
      `activation acceptance producer module ${acceptanceModule.path}`,
    );
  }
  const evidence = validateAcceptanceEvidence(acceptance.evidence, {
    workloadSourceSha: payload.workloadSourceSha,
    producerSourceSha: payload.producerSourceSha,
    producerToolSource: acceptanceToolSource,
  });
  if (acceptance.schemaVersion !== evidence.schemaVersion
      || acceptance.acceptancePass !== evidence.acceptancePass
      || acceptance.workloadSourceSha !== evidence.workloadSourceSha
      || !SHA256.test(acceptance.evidenceSha256 ?? '')
      || acceptance.stateSha256 !== evidence.stateSha256
      || acceptance.qualityReviewSha256 !== evidence.qualityReview.sha256
      || acceptance.scopeSha256 !== evidence.scopeSha256
      || acceptance.workloadReleaseViewSha256 !== evidence.workloadRelease.viewSha256) {
    throw new Error('activation acceptance binding is invalid');
  }
  const expectedSourceBinding = economicsSourceBindingSha256({
    workloadSourceSha: payload.workloadSourceSha,
    producerSourceSha: payload.producerSourceSha,
    acceptanceSourceBindingSha256: evidence.sourceBindingSha256,
    economicsToolBindingSha256: producerToolSource.bindingSha256,
  });
  if (payload.sourceBindingSha256 !== expectedSourceBinding) {
    throw new Error('activation source binding is invalid');
  }

  const operationUsage = exactObject(bindings.operationUsage, [
    'schemaVersion', 'classificationVersion', 'sha256',
  ], 'activation operation-usage binding');
  if (operationUsage.schemaVersion !== evidence.operationUsage.schemaVersion
      || operationUsage.classificationVersion !== evidence.operationUsage.classificationVersion
      || operationUsage.sha256 !== sha256(Buffer.from(canonicalJson(evidence.operationUsage)))) {
    throw new Error('activation operation-usage binding is invalid');
  }
  assertCanonicalEqual(payload.measuredScriptP95, evidence.p95ByDeliveryMode, 'measured script p95');
  assertCanonicalEqual(payload.measuredOperationP95, evidence.operationUsage, 'measured operation p95');

  const release = bindings.release;
  const workloadRelease = bindings.workloadRelease;
  assertCanonicalEqual(
    { ...evidence.release, producerSourceSha: payload.producerSourceSha },
    release,
    'activation producer release',
  );
  assertCanonicalEqual(evidence.workloadRelease, workloadRelease, 'activation workload release');

  const result = computeEconomics(
    rateCard.data,
    evidence.p95ByDeliveryMode,
    evidence.operationUsage,
  );
  assertCanonicalEqual(payload.result, result, 'activation economics result');
  if (result.launchEligible !== true || Object.values(result.gates).some((value) => value !== true)) {
    throw new Error('activation economics result is not launch eligible');
  }
  return {
    payloadSha256: artifact.payloadSha256,
    sourceBindingSha256: expectedSourceBinding,
    workloadSourceSha: payload.workloadSourceSha,
    producerSourceSha: payload.producerSourceSha,
  };
}

async function main() {
  const sourceRootIndex = process.argv.indexOf('--source-root');
  const sourceRootValue = sourceRootIndex >= 0 ? process.argv[sourceRootIndex + 1] : '';
  if (!path.isAbsolute(sourceRootValue)) throw new Error('source root must be absolute');
  const sourceRoot = fs.realpathSync.native(sourceRootValue);
  const invoked = fs.realpathSync.native(process.argv[1] ?? '');
  if (invoked !== path.join(sourceRoot, VERIFIER_ENTRYPOINT)) {
    throw new Error('activation verifier must execute its governed runtime entrypoint');
  }
  const artifact = JSON.parse(readStdin().toString('utf8'));
  const verified = verifyEconomicsActivationArtifact(artifact, {
    sourceRoot,
    authenticationSecret: process.env.LOCAL_PRIMARY_ACTIVATION_EVIDENCE_HMAC_SECRET,
  });
  process.stdout.write(`${JSON.stringify(verified)}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`activation evidence refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
