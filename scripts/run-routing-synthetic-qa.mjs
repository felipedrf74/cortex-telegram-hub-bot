#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
  ROUTING_SYNTHETIC_QA_SURFACES,
  ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
  buildRoutingSyntheticQaManifest,
  canonicalJson,
} from './lib/routing-synthetic-qa-manifest.mjs';

export const ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA =
  'nexus.routing-synthetic-qa-receipt.v1';

const MANIFEST_SHA256 = /^[0-9a-f]{64}$/u;
const PREFIXED_MANIFEST_SHA256 = /^sha256:([0-9a-f]{64})$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STAGING_BASE_DIR = '/home/dominguez/telegram-hub-bot-staging';
const STAGING_BACKEND_URL = 'http://127.0.0.1:8201';
const STAGING_HOME = '/home/dominguez';
const RELEASE_LOCK_PATH = '/home/dominguez/.local/state/nexus-release/.release.lock';
const PLANNED_TURNS = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const SURFACE_FLAG = Object.freeze({
  classifierKeyword: 'AI_ROUTING_MANIFEST_CLASSIFIER',
  orchestratorPrimary: 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  shadowRoute: 'AI_ROUTING_MANIFEST_SHADOW',
  registrySubset: 'AI_ROUTING_MANIFEST_REGISTRY',
});
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'status',
  'contractVersion',
  'trafficClass',
  'manifestSha256',
  'runtimeSha',
  'artifactDigest',
  'environment',
  'surface',
  'userId',
  'tenantId',
  'plannedTurns',
  'attemptedTurns',
  'acceptedTurns',
  'recordedTurns',
  'startedAt',
  'completedAt',
  'httpStatusCounts',
  'apiUsageDelta',
  'providerReservationDelta',
  'providerCalled',
  'externalCallPerformed',
  'domainMutationPerformed',
]);

export function routingSyntheticQaTurnIdentity(manifestSha256, surface, ordinal) {
  if (!MANIFEST_SHA256.test(manifestSha256)) throw new Error('manifest SHA-256 is invalid');
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > PLANNED_TURNS) {
    throw new Error('synthetic QA ordinal is invalid');
  }
  return `${ROUTING_SYNTHETIC_QA_CONTRACT_VERSION}:${manifestSha256}:${surface}:${String(ordinal).padStart(3, '0')}`;
}

/**
 * Reconstruct the immutable surface chain from protected server state. The
 * current manifest is accepted only after every prior surface has canonical
 * manifest bytes, a strict prior-digest prefix, and a passed zero-provider
 * receipt for the same installed release and dedicated identity.
 */
export function attestRoutingSyntheticQaManifestChain(input) {
  if (!input || typeof input !== 'object' || !Buffer.isBuffer(input.source?.raw)) {
    throw new Error('current synthetic QA manifest source is unavailable');
  }
  if (!MANIFEST_SHA256.test(input.expectedManifestSha256 ?? '')
      || sha256(input.source.raw) !== input.expectedManifestSha256) {
    throw new Error('current manifest SHA-256 does not match the owner binding');
  }
  if (!/^[0-9a-f]{40}$/u.test(input.release?.runtimeSha ?? '')
      || !/^[0-9a-f]{64}$/u.test(input.release?.artifactDigest ?? '')) {
    throw new Error('installed release identity for synthetic QA is invalid');
  }
  if (!Number.isSafeInteger(input.dedicatedId) || input.dedicatedId < 1) {
    throw new Error('dedicated synthetic QA identity is invalid');
  }

  let parsed;
  try {
    parsed = JSON.parse(input.source.raw.toString('utf8'));
  } catch {
    throw new Error('current synthetic QA manifest is not valid JSON');
  }
  const surfaceIndex = ROUTING_SYNTHETIC_QA_SURFACES.indexOf(parsed?.surface);
  if (surfaceIndex < 0) {
    throw new Error('current synthetic QA manifest surface is not governed');
  }
  const expectedSurfaces = ROUTING_SYNTHETIC_QA_SURFACES.slice(0, surfaceIndex);
  const predecessorManifestSha256s = parsed?.predecessorManifestSha256s;
  if (!Array.isArray(predecessorManifestSha256s)
      || predecessorManifestSha256s.length !== expectedSurfaces.length
      || predecessorManifestSha256s.some((digest) => !PREFIXED_MANIFEST_SHA256.test(digest))) {
    throw new Error('current manifest does not bind the strict fixed predecessor surface chain');
  }

  if (typeof input.stateRoot !== 'string' || !path.isAbsolute(input.stateRoot)) {
    throw new Error('synthetic QA predecessor state root must be an absolute path');
  }
  const stateRoot = path.resolve(input.stateRoot);
  const expectedReleaseStateName = `${input.release.runtimeSha}-${input.release.artifactDigest.slice(0, 12)}`;
  if (path.basename(stateRoot) !== expectedReleaseStateName) {
    throw new Error('synthetic QA predecessor state root is not bound to the exact release');
  }

  const predecessorTexts = [];
  const predecessors = [];
  const attestedSha256s = [];
  if (expectedSurfaces.length > 0) {
    if (input.stateAnchor !== undefined) {
      assertPrivateStateDirectoryChain(input.stateAnchor, stateRoot);
    } else {
      assertPrivateStateDirectory(stateRoot, 'synthetic QA release state');
    }
  }
  for (let index = 0; index < expectedSurfaces.length; index += 1) {
    const predecessorSurface = expectedSurfaces[index];
    const prefixedDigest = predecessorManifestSha256s[index];
    const digest = prefixedDigest.slice('sha256:'.length);
    const surfaceDirectory = path.join(stateRoot, predecessorSurface);
    assertPrivateStateDirectory(surfaceDirectory, `synthetic QA ${predecessorSurface} state`);
    const manifestPath = path.join(surfaceDirectory, `${digest}.manifest.json`);
    const receiptPath = path.join(surfaceDirectory, `${digest}.receipt.json`);
    const raw = readPrivateEvidenceFile(manifestPath, `predecessor ${predecessorSurface} manifest`);
    if (sha256(raw) !== digest) {
      throw new Error(`predecessor ${predecessorSurface} manifest digest does not match protected bytes`);
    }
    let predecessorParsed;
    try {
      predecessorParsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error(`predecessor ${predecessorSurface} manifest is not valid JSON`);
    }
    const predecessorBuilt = buildRoutingSyntheticQaManifest(predecessorParsed, {
      expectedRuntimeSha: input.release.runtimeSha,
      expectedArtifactDigest: input.release.artifactDigest,
      expectedSurface: predecessorSurface,
      expectedDedicatedId: String(input.dedicatedId),
      expectedPredecessorManifestSha256s: attestedSha256s,
      referenceTexts: predecessorTexts,
    });
    if (predecessorBuilt.sha256 !== digest
        || !Buffer.from(predecessorBuilt.bytes, 'utf8').equals(raw)) {
      throw new Error(`predecessor ${predecessorSurface} manifest bytes are not canonical`);
    }
    const receipt = readPassedPredecessorReceipt(receiptPath, {
      manifestSha256: prefixedDigest,
      runtimeSha: input.release.runtimeSha,
      artifactDigest: input.release.artifactDigest,
      surface: predecessorSurface,
      dedicatedId: input.dedicatedId,
    });
    attestedSha256s.push(prefixedDigest);
    predecessorTexts.push(...predecessorBuilt.manifest.turns.map((turn) => turn.text));
    predecessors.push({
      surface: predecessorSurface,
      manifestSha256: prefixedDigest,
      manifest: predecessorBuilt.manifest,
      receipt,
    });
  }

  const built = buildRoutingSyntheticQaManifest(parsed, {
    expectedRuntimeSha: input.release.runtimeSha,
    expectedArtifactDigest: input.release.artifactDigest,
    expectedSurface: parsed.surface,
    expectedDedicatedId: String(input.dedicatedId),
    expectedPredecessorManifestSha256s: attestedSha256s,
    referenceTexts: predecessorTexts,
  });
  if (built.sha256 !== input.expectedManifestSha256
      || !Buffer.from(built.bytes, 'utf8').equals(input.source.raw)) {
    throw new Error('manifest bytes are not the exact canonical validated campaign');
  }
  return { built, predecessors, predecessorTexts };
}

/**
 * Execute an already-validated campaign through the ordinary authenticated
 * staging HTTP entrypoint. This function never writes evidence itself: the
 * CLI publishes a passed receipt only after all 200 responses and both ledger
 * snapshots have passed.
 */
export async function executeRoutingSyntheticQaCampaign(input) {
  assertCampaignInput(input);
  await attestRoutingSyntheticQaServingRuntime({
    baseUrl: input.baseUrl,
    healthToken: input.healthToken,
    manifest: input.manifest,
    fetchImpl: input.fetchImpl,
  });
  if (typeof input.onServingRuntimeAttested === 'function') {
    await input.onServingRuntimeAttested();
  }
  const before = normalizeLedgerSnapshot(await input.snapshotLedger());
  const startedAt = canonicalNow(input.now);
  let attemptedTurns = 0;
  let acceptedTurns = 0;
  let recordedTurns = 0;
  const httpStatusCounts = {};

  for (const turn of input.manifest.turns) {
    attemptedTurns += 1;
    const turnId = routingSyntheticQaTurnIdentity(
      input.manifestSha256,
      input.manifest.surface,
      turn.ordinal,
    );
    let response;
    try {
      response = await input.fetchImpl(`${input.baseUrl}/api/v1/chat/message`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.token}`,
          'content-type': 'application/json',
          'x-language': turn.locale,
          'x-nexus-routing-synthetic-qa-contract': ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
          'x-nexus-routing-synthetic-qa-manifest-sha256': `sha256:${input.manifestSha256}`,
          'x-nexus-routing-synthetic-qa-surface': input.manifest.surface,
          'x-nexus-routing-synthetic-qa-ordinal': String(turn.ordinal),
          'x-nexus-routing-synthetic-qa-planned-turns': String(PLANNED_TURNS),
          'x-nexus-routing-synthetic-qa-turn-id': turnId,
        },
        body: JSON.stringify({ text: turn.text, clientMessageId: turnId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`synthetic QA turn ${turn.ordinal} transport failed closed`);
    }
    const statusKey = String(response.status);
    httpStatusCounts[statusKey] = (httpStatusCounts[statusKey] ?? 0) + 1;
    if (response.status !== 200) {
      // The body is deliberately not read or surfaced: it can contain a
      // private diagnostic, while the status and ordinal are sufficient to
      // make this campaign non-acceptable.
      throw new Error(`synthetic QA turn ${turn.ordinal} was not accepted (HTTP ${response.status})`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`synthetic QA turn ${turn.ordinal} returned non-JSON evidence`);
    }
    acceptedTurns += 1;
    assertRecordedTerminal(body, {
      manifestSha256: input.manifestSha256,
      surface: input.manifest.surface,
      ordinal: turn.ordinal,
      turnId,
      locale: turn.locale,
    });
    recordedTurns += 1;
    if (typeof input.onProgress === 'function'
        && (recordedTurns % 25 === 0 || recordedTurns === PLANNED_TURNS)) {
      input.onProgress({ acceptedTurns: recordedTurns, plannedTurns: PLANNED_TURNS });
    }
  }

  const after = normalizeLedgerSnapshot(await input.snapshotLedger());
  const completedAt = canonicalNow(input.now);
  const apiUsageDelta = ledgerDelta(before.apiUsage, after.apiUsage);
  const providerReservationDelta = ledgerDelta(
    before.providerReservations,
    after.providerReservations,
  );
  if (apiUsageDelta.rows !== 0
      || apiUsageDelta.costUsd !== 0
      || providerReservationDelta.rows !== 0
      || providerReservationDelta.costUsd !== 0) {
    throw new Error('synthetic QA provider ledger changed; no passed receipt was produced');
  }

  return {
    schema: ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA,
    status: 'passed',
    contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    manifestSha256: `sha256:${input.manifestSha256}`,
    runtimeSha: input.manifest.runtimeSha,
    artifactDigest: input.manifest.artifactDigest,
    environment: 'staging',
    surface: input.manifest.surface,
    userId: Number(input.manifest.userId),
    tenantId: Number(input.manifest.tenantId),
    plannedTurns: PLANNED_TURNS,
    attemptedTurns,
    acceptedTurns,
    recordedTurns,
    startedAt,
    completedAt,
    httpStatusCounts,
    apiUsageDelta,
    providerReservationDelta,
    providerCalled: false,
    externalCallPerformed: false,
    domainMutationPerformed: false,
  };
}

/**
 * Bind the loopback HTTP listener to the same exact installed release the
 * filesystem attestation selected before any synthetic chat turn can run.
 */
export async function attestRoutingSyntheticQaServingRuntime(input) {
  let response;
  try {
    response = await input.fetchImpl(`${input.baseUrl}/health/detailed`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.healthToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('synthetic QA serving release health attestation was unavailable');
  }
  if (response.status !== 200) {
    throw new Error('synthetic QA serving release health attestation was not accepted');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('synthetic QA serving release health attestation was malformed');
  }
  const attestation = body?.releaseAttestation;
  const dedicatedHook = attestation?.shadowRouteHookEffective?.dedicatedEval;
  const dedicatedPlanner = attestation?.shadowPlannerEffective?.dedicatedEval;
  const selectedFlag = SURFACE_FLAG[input.manifest.surface];
  if (
    body?.status !== 'healthy'
    || body?.database !== 'connected'
    || attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
    || attestation?.runtimeSha !== input.manifest.runtimeSha
    || attestation?.artifactDigest !== input.manifest.artifactDigest
    || attestation?.role !== 'staging'
    || !Number.isSafeInteger(attestation?.processId)
    || attestation.processId < 1
    || attestation?.capabilityRuntimeGuard?.status !== 'clear'
    || dedicatedHook?.present !== true
    || dedicatedHook?.user !== true
    || dedicatedHook?.tenant !== true
    || dedicatedPlanner?.present !== true
    || dedicatedPlanner?.user !== false
    || dedicatedPlanner?.tenant !== false
    || typeof selectedFlag !== 'string'
    || attestation?.capabilityFlags?.masterKill !== false
    || attestation?.capabilityFlags?.effective?.[selectedFlag] !== false
  ) {
    throw new Error('synthetic QA serving release attestation does not match the exact safe campaign scope');
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (!isExactRoutingSyntheticQaFlockChild()) {
    throw new Error('routing synthetic QA must execute under the shared release mutex');
  }
  const args = parseArgs(argv);
  const manifestPath = required(args, 'manifest');
  const manifestDigestMatch = required(args, 'manifest-sha256').match(PREFIXED_MANIFEST_SHA256);
  if (!manifestDigestMatch) throw new Error('--manifest-sha256 must be sha256:<64 lowercase hex>');
  const expectedManifestSha256 = manifestDigestMatch[1];
  const release = attestInstalledStagingRelease();
  const dedicatedId = canonicalDedicatedId(process.env.CHAT_EVAL_DEDICATED_TENANT_ID);
  const source = readPrivateManifest(manifestPath, expectedManifestSha256);
  const chain = attestRoutingSyntheticQaManifestChain({
    source,
    expectedManifestSha256,
    release,
    dedicatedId,
    stateRoot: routingSyntheticQaReleaseStateRoot(release),
    stateAnchor: path.join(STAGING_HOME, '.local/state/nexus-release'),
  });
  const { built } = chain;

  const runtime = loadRuntimeDependencies(release.releaseDir);
  const databasePath = path.join(release.baseDir, 'data/bot.db');
  if (process.env.DATABASE_PATH !== databasePath) {
    throw new Error('DATABASE_PATH must bind the exact staging database');
  }
  attestDedicatedIdentity(runtime.Database, databasePath, dedicatedId);
  const evidence = prepareEvidencePaths(
    release,
    built.manifest.surface,
    expectedManifestSha256,
  );

  let receipt;
  let manifestPublished = false;
  try {
    const token = runtime.signIosJwt({
      userId: dedicatedId,
      tenantId: dedicatedId,
      staging_fixture: true,
      fixture: 'routing-synthetic-qa',
    }, { expiresIn: '15m' });
    receipt = await executeRoutingSyntheticQaCampaign({
      manifest: built.manifest,
      manifestSha256: expectedManifestSha256,
      token,
      healthToken: process.env.HEALTH_TOKEN,
      baseUrl: STAGING_BACKEND_URL,
      fetchImpl: globalThis.fetch,
      snapshotLedger: () => snapshotProviderLedger(runtime.Database, databasePath, dedicatedId),
      now: () => new Date(),
      onServingRuntimeAttested: () => {
        // A zero-turn transient health failure must not consume the immutable
        // campaign identity. Once preflight passes, publication starts the
        // one-shot evidence transaction and every later failure burns it.
        manifestPublished = true;
        writeExclusivePrivateFile(evidence.manifestPath, source.raw);
      },
      onProgress: ({ acceptedTurns, plannedTurns }) => {
        process.stderr.write(`routing synthetic QA accepted ${acceptedTurns}/${plannedTurns}\n`);
      },
    });
  } catch (error) {
    if (manifestPublished) {
      writeFailureEvidence(evidence.failurePath, {
        manifestSha256: `sha256:${expectedManifestSha256}`,
        runtimeSha: release.runtimeSha,
        artifactDigest: release.artifactDigest,
        surface: built.manifest.surface,
        failedAt: new Date().toISOString(),
        reason: safeFailureReason(error),
      });
    }
    throw error;
  }

  writeExclusivePrivateFile(
    evidence.receiptPath,
    Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8'),
  );
  process.stdout.write(`${JSON.stringify({
    schema: ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA,
    status: 'passed',
    trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
    manifestSha256: `sha256:${expectedManifestSha256}`,
    runtimeSha: release.runtimeSha,
    artifactDigest: release.artifactDigest,
    surface: built.manifest.surface,
    plannedTurns: receipt.plannedTurns,
    acceptedTurns: receipt.acceptedTurns,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    receiptSha256: `sha256:${sha256(fs.readFileSync(evidence.receiptPath))}`,
  })}\n`);
  return receipt;
}

function assertCampaignInput(input) {
  if (!input || typeof input !== 'object') throw new Error('campaign input is required');
  if (!input.manifest || typeof input.manifest !== 'object') throw new Error('validated manifest is required');
  if (!MANIFEST_SHA256.test(input.manifestSha256 ?? '')) throw new Error('manifest SHA-256 is invalid');
  if (typeof input.token !== 'string' || input.token.length < 16) throw new Error('short-lived synthetic QA token is unavailable');
  if (
    typeof input.healthToken !== 'string'
    || input.healthToken.length < 16
    || input.healthToken !== input.healthToken.trim()
    || input.healthToken === input.token
  ) {
    throw new Error('a distinct protected health token credential is required');
  }
  if (input.baseUrl !== STAGING_BACKEND_URL) throw new Error('synthetic QA endpoint must be staging loopback');
  if (typeof input.fetchImpl !== 'function' || typeof input.snapshotLedger !== 'function') {
    throw new Error('campaign runtime dependencies are unavailable');
  }
  if (input.onServingRuntimeAttested !== undefined
      && typeof input.onServingRuntimeAttested !== 'function') {
    throw new Error('serving-runtime attestation callback is invalid');
  }
  if (!Array.isArray(input.manifest.turns)
      || input.manifest.plannedTurns !== PLANNED_TURNS
      || input.manifest.turns.length !== PLANNED_TURNS
      || input.manifest.environment !== 'staging'
      || input.manifest.contractVersion !== ROUTING_SYNTHETIC_QA_CONTRACT_VERSION
      || input.manifest.trafficClass !== ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS
      || input.manifest.userId !== input.manifest.tenantId
      || !Number.isSafeInteger(input.manifest.userId)
      || input.manifest.userId < 1) {
    throw new Error('campaign manifest binding is invalid');
  }
  for (let index = 0; index < input.manifest.turns.length; index += 1) {
    const turn = input.manifest.turns[index];
    if (turn?.ordinal !== index + 1
        || typeof turn.text !== 'string'
        || typeof turn.locale !== 'string') {
      throw new Error(`campaign manifest turn ${index + 1} is invalid`);
    }
  }
}

function assertRecordedTerminal(rawBody, expected) {
  const body = rawBody?.data && typeof rawBody.data === 'object' && !Array.isArray(rawBody.data)
    ? rawBody.data
    : rawBody;
  const metadata = body?.metadata;
  const provenance = metadata?.trafficProvenance;
  const provenanceKeys = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? Object.keys(provenance).sort()
    : [];
  const exactProvenanceKeys = [
    'contractVersion',
    'manifestSha256',
    'ordinal',
    'plannedTurns',
    'surface',
    'trafficClass',
    'turnId',
    'locale',
  ].sort();
  if (body?.routeMethod !== 'routing-synthetic-qa'
      || metadata?.type !== 'routing_synthetic_qa_recorded'
      || metadata.providerCalled !== false
      || metadata.externalCallPerformed !== false
      || metadata.domainMutationPerformed !== false
      || typeof metadata.replayBundleId !== 'string'
      || metadata.replayBundleId.length < 1
      || JSON.stringify(provenanceKeys) !== JSON.stringify(exactProvenanceKeys)
      || provenance.contractVersion !== ROUTING_SYNTHETIC_QA_CONTRACT_VERSION
      || provenance.trafficClass !== ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS
      || provenance.manifestSha256 !== `sha256:${expected.manifestSha256}`
      || provenance.surface !== expected.surface
      || provenance.ordinal !== expected.ordinal
      || provenance.plannedTurns !== PLANNED_TURNS
      || provenance.turnId !== expected.turnId
      || provenance.locale !== expected.locale) {
    throw new Error(`synthetic QA turn ${expected.ordinal} did not return exact recorded evidence`);
  }
}

function normalizeLedgerSnapshot(value) {
  const normalize = (entry, label) => {
    const rows = Number(entry?.rows);
    const costUsd = Number(entry?.costUsd);
    if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isFinite(costUsd) || costUsd < 0) {
      throw new Error(`${label} provider ledger snapshot is invalid`);
    }
    return { rows, costUsd: roundUsd(costUsd) };
  };
  return {
    apiUsage: normalize(value?.apiUsage, 'api usage'),
    providerReservations: normalize(value?.providerReservations, 'reservation'),
  };
}

function ledgerDelta(before, after) {
  const rows = after.rows - before.rows;
  const costUsd = roundUsd(after.costUsd - before.costUsd);
  if (!Number.isSafeInteger(rows) || rows < 0 || costUsd < 0) {
    throw new Error('synthetic QA provider ledger moved backwards');
  }
  return { rows, costUsd };
}

function roundUsd(value) {
  return Number(value.toFixed(12));
}

function canonicalNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('campaign timestamp is invalid');
  }
  const timestamp = value.toISOString();
  if (!CANONICAL_TIMESTAMP.test(timestamp)) throw new Error('campaign timestamp is not canonical');
  return timestamp;
}

function attestInstalledStagingRelease() {
  if (process.env.HOME !== STAGING_HOME
      || process.env.NEXUS_RELEASE_ROLE !== 'staging') {
    throw new Error('routing synthetic QA is available only to the staging release owner');
  }
  const releaseDir = fs.realpathSync(process.cwd());
  const expectedPrefix = `${STAGING_BASE_DIR}/releases/`;
  if (!releaseDir.startsWith(expectedPrefix)
      || path.dirname(releaseDir) !== path.join(STAGING_BASE_DIR, 'releases')) {
    throw new Error('routing synthetic QA must run from an installed staging release');
  }
  const markerPath = path.join(releaseDir, '.complete.json');
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
    throw new Error('installed release marker is unsafe');
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker?.schema !== 'nexus.release-bundle.v1'
      || !/^[0-9a-f]{40}$/u.test(marker.runtimeSha ?? '')
      || !/^[0-9a-f]{64}$/u.test(marker.artifactDigest ?? '')
      || path.basename(releaseDir) !== `${marker.runtimeSha}-${marker.artifactDigest.slice(0, 12)}`
      || process.env.NEXUS_RELEASE_SHA !== marker.runtimeSha
      || process.env.NEXUS_RELEASE_ARTIFACT_SHA256 !== marker.artifactDigest) {
    throw new Error('installed release identity is not exact');
  }
  const currentPath = path.join(STAGING_BASE_DIR, 'current');
  const currentStat = fs.lstatSync(currentPath);
  if (!currentStat.isSymbolicLink() || fs.realpathSync(currentPath) !== releaseDir) {
    throw new Error('installed release is not the selected staging runtime');
  }
  return {
    baseDir: STAGING_BASE_DIR,
    releaseDir,
    runtimeSha: marker.runtimeSha,
    artifactDigest: marker.artifactDigest,
  };
}

function readPrivateManifest(inputPath, expectedSha256) {
  const absolute = path.resolve(inputPath);
  const raw = readPrivateEvidenceFile(absolute, 'manifest input');
  if (sha256(raw) !== expectedSha256) throw new Error('manifest SHA-256 does not match owner binding');
  return { raw, parsed: JSON.parse(raw.toString('utf8')) };
}

function readPassedPredecessorReceipt(receiptPath, expected) {
  const raw = readPrivateEvidenceFile(receiptPath, `predecessor ${expected.surface} receipt`);
  let receipt;
  try {
    receipt = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`predecessor ${expected.surface} passed receipt is not valid JSON`);
  }
  const startedAtMs = Date.parse(receipt?.startedAt ?? '');
  const completedAtMs = Date.parse(receipt?.completedAt ?? '');
  if (!isPlainObject(receipt)
      || !hasExactKeys(receipt, RECEIPT_KEYS)
      || !Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8').equals(raw)
      || receipt.schema !== ROUTING_SYNTHETIC_QA_RECEIPT_SCHEMA
      || receipt.status !== 'passed'
      || receipt.contractVersion !== ROUTING_SYNTHETIC_QA_CONTRACT_VERSION
      || receipt.trafficClass !== ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS
      || receipt.manifestSha256 !== expected.manifestSha256
      || receipt.runtimeSha !== expected.runtimeSha
      || receipt.artifactDigest !== expected.artifactDigest
      || receipt.environment !== 'staging'
      || receipt.surface !== expected.surface
      || receipt.userId !== expected.dedicatedId
      || receipt.tenantId !== expected.dedicatedId
      || receipt.plannedTurns !== PLANNED_TURNS
      || receipt.attemptedTurns !== PLANNED_TURNS
      || receipt.acceptedTurns !== PLANNED_TURNS
      || receipt.recordedTurns !== PLANNED_TURNS
      || !CANONICAL_TIMESTAMP.test(receipt.startedAt ?? '')
      || !CANONICAL_TIMESTAMP.test(receipt.completedAt ?? '')
      || !Number.isFinite(startedAtMs)
      || !Number.isFinite(completedAtMs)
      || completedAtMs < startedAtMs
      || canonicalJson(receipt.httpStatusCounts) !== canonicalJson({ 200: PLANNED_TURNS })
      || canonicalJson(receipt.apiUsageDelta) !== canonicalJson({ rows: 0, costUsd: 0 })
      || canonicalJson(receipt.providerReservationDelta) !== canonicalJson({ rows: 0, costUsd: 0 })
      || receipt.providerCalled !== false
      || receipt.externalCallPerformed !== false
      || receipt.domainMutationPerformed !== false) {
    throw new Error(`predecessor ${expected.surface} does not have an exact passed receipt`);
  }
  return receipt;
}

function readPrivateEvidenceFile(filePath, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be an accessible owner-only ordinary mode-0600 single-link file`, {
      cause: error,
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile()
        || stat.nlink !== 1
        || stat.uid !== currentUid
        || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`${label} must be an owner-only ordinary mode-0600 single-link file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateStateDirectory(directoryPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    throw new Error(`${label} must be an accessible owner-only ordinary directory`, { cause: error });
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== currentUid
      || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be an owner-only ordinary directory`);
  }
  return stat;
}

function assertPrivateStateDirectoryChain(anchorPath, targetPath) {
  const anchor = path.resolve(anchorPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(anchor, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('synthetic QA release state is outside its protected state anchor');
  }
  assertPrivateStateDirectory(anchor, 'synthetic QA protected state anchor');
  let current = anchor;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    assertPrivateStateDirectory(current, 'synthetic QA protected state path');
  }
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expectedKeys) {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...expectedKeys].sort());
}

function canonicalDedicatedId(raw) {
  const value = String(raw ?? '').trim();
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('dedicated staging identity is unavailable');
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || String(numeric) !== value) {
    throw new Error('dedicated staging identity is invalid');
  }
  return numeric;
}

function loadRuntimeDependencies(releaseDir) {
  const runtimeRequire = createRequire(path.join(releaseDir, 'package.json'));
  const Database = runtimeRequire('better-sqlite3');
  const jwtRuntime = runtimeRequire(path.join(releaseDir, 'dist/services/ios-jwt.js'));
  if (typeof Database !== 'function' || typeof jwtRuntime.signIosJwt !== 'function') {
    throw new Error('installed staging runtime dependencies are unavailable');
  }
  return { Database, signIosJwt: jwtRuntime.signIosJwt };
}

function attestDedicatedIdentity(Database, databasePath, dedicatedId) {
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('staging database is unsafe');
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    const rows = database.prepare('SELECT id, email FROM users WHERE id = ?').all(dedicatedId);
    const email = typeof rows[0]?.email === 'string' ? rows[0].email.trim().toLowerCase() : '';
    if (rows.length !== 1 || rows[0].id !== dedicatedId || !email.endsWith('.invalid')) {
      throw new Error('dedicated staging identity is not the synthetic .invalid principal');
    }
  } finally {
    database.close();
  }
}

function snapshotProviderLedger(Database, databasePath, dedicatedId) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    const usage = database.prepare(`
      SELECT COUNT(*) AS rows, COALESCE(SUM(cost_usd), 0) AS costUsd
      FROM api_usage
      WHERE user_id = ? AND tenant_id = ?
    `).get(dedicatedId, dedicatedId);
    const reservationTable = database.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'ai_provider_attempt_reservations'
    `).get();
    const providerReservations = reservationTable
      ? database.prepare(`
          SELECT COUNT(*) AS rows, COALESCE(SUM(reserved_cost_usd), 0) AS costUsd
          FROM ai_provider_attempt_reservations
          WHERE user_id = ?
        `).get(dedicatedId)
      : { rows: 0, costUsd: 0 };
    return {
      apiUsage: { rows: Number(usage.rows), costUsd: Number(usage.costUsd) },
      providerReservations: {
        rows: Number(providerReservations.rows),
        costUsd: Number(providerReservations.costUsd),
      },
    };
  } finally {
    database.close();
  }
}

function prepareEvidencePaths(release, surface, manifestSha256) {
  const stateRoot = path.join(routingSyntheticQaReleaseStateRoot(release), surface);
  ensurePrivateStateDirectory(stateRoot);
  return {
    manifestPath: path.join(stateRoot, `${manifestSha256}.manifest.json`),
    receiptPath: path.join(stateRoot, `${manifestSha256}.receipt.json`),
    failurePath: path.join(stateRoot, `${manifestSha256}.failed.json`),
  };
}

function routingSyntheticQaReleaseStateRoot(release) {
  return path.join(
    STAGING_HOME,
    '.local/state/nexus-release/routing-synthetic-qa',
    `${release.runtimeSha}-${release.artifactDigest.slice(0, 12)}`,
  );
}

function ensurePrivateStateDirectory(target) {
  const fixedRoot = path.join(STAGING_HOME, '.local/state/nexus-release');
  const rootStat = fs.lstatSync(fixedRoot);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : rootStat.uid;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== currentUid) {
    throw new Error('release state root is unsafe');
  }
  let current = fixedRoot;
  const relative = path.relative(fixedRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('synthetic QA state path is unsafe');
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory()
        || stat.isSymbolicLink()
        || stat.uid !== currentUid
        || (stat.mode & 0o077) !== 0) {
      throw new Error('synthetic QA state directory is not owner-only');
    }
  }
}

function writeExclusivePrivateFile(filePath, bytes) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
  const directory = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function writeFailureEvidence(filePath, input) {
  try {
    writeExclusivePrivateFile(filePath, Buffer.from(`${canonicalJson({
      schema: 'nexus.routing-synthetic-qa-failure.v1',
      status: 'failed',
      contractVersion: ROUTING_SYNTHETIC_QA_CONTRACT_VERSION,
      trafficClass: ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS,
      ...input,
    })}\n`, 'utf8'));
  } catch {
    // Never replace the original safe failure with evidence-publication noise.
  }
}

function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/provider ledger changed/u.test(message)) return 'provider_ledger_changed';
  if (/was not accepted/u.test(message)) return 'http_not_accepted';
  if (/transport failed/u.test(message)) return 'transport_failed';
  if (/recorded evidence|non-JSON/u.test(message)) return 'response_evidence_invalid';
  return 'campaign_failed_closed';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('expected --manifest <file> --manifest-sha256 sha256:<digest>');
    }
    index += 1;
    const name = key.slice(2);
    if (!['manifest', 'manifest-sha256'].includes(name)) throw new Error(`unknown argument --${name}`);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate argument --${name}`);
    result[name] = value;
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runEntrypoint().catch((error) => {
    process.stderr.write(`routing synthetic QA failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function runEntrypoint() {
  if (isExactRoutingSyntheticQaFlockChild()) {
    await main();
    return;
  }
  validateRoutingSyntheticQaReleaseLockFile(RELEASE_LOCK_PATH);
  const result = spawnSync('/usr/bin/flock', [
    '--exclusive',
    '--nonblock',
    RELEASE_LOCK_PATH,
    process.execPath,
    ...process.execArgv,
    ...process.argv.slice(1),
  ], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw new Error('shared release mutex could not be acquired');
  }
  if (result.status !== 0) {
    throw new Error(`shared release mutex execution failed closed (exit ${result.status ?? 'unknown'})`);
  }
}

export function validateRoutingSyntheticQaReleaseLockFile(filePath = RELEASE_LOCK_PATH) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error('shared release lock is unavailable');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.uid !== currentUid
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error('shared release lock owner, mode, link count, or file type is unsafe');
  }
  return stat;
}

function isExactRoutingSyntheticQaFlockChild() {
  if (process.platform !== 'linux' || !Number.isSafeInteger(process.ppid) || process.ppid < 2) {
    return false;
  }
  try {
    validateRoutingSyntheticQaReleaseLockFile(RELEASE_LOCK_PATH);
    const parentExecutable = fs.realpathSync(`/proc/${process.ppid}/exe`);
    const flockExecutable = fs.realpathSync('/usr/bin/flock');
    if (parentExecutable !== flockExecutable) return false;
    const command = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8')
      .split('\u0000')
      .filter(Boolean);
    return command[1] === '--exclusive'
      && command[2] === '--nonblock'
      && command[3] === RELEASE_LOCK_PATH
      && command[4] === process.execPath
      && command.includes(process.argv[1]);
  } catch {
    return false;
  }
}
