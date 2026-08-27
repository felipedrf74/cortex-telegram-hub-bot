// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  constants as fsConstants,
  type BigIntStats,
} from 'node:fs';
import path from 'node:path';

export const LOCAL_INFERENCE_ACTIVATION_EVIDENCE_SCHEMA =
  'nexus.pre-release-economics.v7';
const ACCEPTANCE_SOURCE_BINDING_SCHEMA = 'nexus.acceptance-source-binding.v2';
const ECONOMICS_SOURCE_BINDING_SCHEMA = 'nexus.economics-source-binding.v1';
const IMMUTABLE_TOOL_SOURCE_SCHEMA = 'nexus.immutable-tool-source.v1';
const IMMUTABLE_TOOL_SOURCE_BINDING_SCHEMA = 'nexus.immutable-tool-source-binding.v1';
const CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA = 'nexus.content-ten-script-evidence.v6';
const ACCEPTANCE_PRODUCER_ENTRYPOINT = 'scripts/content-ten-script-evidence.mjs';
const ACCEPTANCE_PRODUCER_MODULES = [
  'scripts/content-ten-script-acceptance.mjs',
  'scripts/content-ten-script-evidence.mjs',
] as const;
const ECONOMICS_PRODUCER_ENTRYPOINT = 'scripts/economics-simulation.mjs';
const ECONOMICS_PRODUCER_MODULES = [
  'scripts/content-ten-script-acceptance.mjs',
  'scripts/content-ten-script-evidence.mjs',
  'scripts/economics-activation-verifier.mjs',
  'scripts/economics-simulation.mjs',
  'scripts/lib/economics-activation-auth.mjs',
  'scripts/lib/release-canonical.mjs',
] as const;
const ECONOMICS_VERIFIER_ENTRYPOINT = 'scripts/economics-activation-verifier.mjs';
const PAYLOAD_DIGEST_ALGORITHM = 'sha256-canonical-json-payload-v1';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RELEASE_ID = /^[0-9a-f]{32}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export interface ValidatedLocalInferenceActivationEvidence {
  evidenceReference: string;
  artifactSha256: string;
  payloadSha256: string;
  sourceBindingSha256: string;
  workloadSourceSha: string;
  producerSourceSha: string;
}

export class LocalInferenceActivationEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LocalInferenceActivationEvidenceError';
  }
}

function fail(code: string, message: string): never {
  throw new LocalInferenceActivationEvidenceError(code, message);
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return new Date(milliseconds).toISOString() === normalized;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail('LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SCHEMA_INVALID', `${label} does not match the governed schema.`);
  }
  return value as Record<string, unknown>;
}

function validateImmutableProducerToolSource(
  value: unknown,
  producerSourceSha: string,
  entrypoint: string,
  modulePaths: readonly string[],
  label: string,
): string {
  const source = exactObject(value, [
    'schemaVersion', 'producerSourceSha', 'entrypoint', 'modules',
    'closureSha256', 'bindingSha256',
  ], `Activation ${label} producer tool source`);
  const rawModules = source.modules;
  if (source.schemaVersion !== IMMUTABLE_TOOL_SOURCE_SCHEMA
      || source.producerSourceSha !== producerSourceSha
      || source.entrypoint !== entrypoint
      || !Array.isArray(rawModules)
      || rawModules.length !== modulePaths.length
      || !SHA256.test(String(source.closureSha256 ?? ''))
      || !SHA256.test(String(source.bindingSha256 ?? ''))) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
      `The ${label} producer tool source identity is invalid.`,
    );
  }
  const modules = rawModules.map((value, index) => {
    const module = exactObject(value, [
      'path', 'gitMode', 'gitBlobObjectId', 'sha256', 'byteLength',
    ], `Activation ${label} producer module ${index + 1}`);
    if (module.path !== modulePaths[index]
        || !['100644', '100755'].includes(String(module.gitMode ?? ''))
        || !GIT_OBJECT_ID.test(String(module.gitBlobObjectId ?? ''))
        || !SHA256.test(String(module.sha256 ?? ''))
        || typeof module.byteLength !== 'number'
        || !Number.isSafeInteger(module.byteLength)
        || module.byteLength < 1
        || module.byteLength > MAX_ARTIFACT_BYTES) {
      fail(
        'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
        `The ${label} producer tool module closure is invalid.`,
      );
    }
    return module;
  });
  const closureSha256 = sha256(Buffer.from(canonicalJson({
    schemaVersion: IMMUTABLE_TOOL_SOURCE_SCHEMA,
    producerSourceSha,
    entrypoint,
    modules,
  })));
  const bindingSha256 = sha256(Buffer.from(
    `${IMMUTABLE_TOOL_SOURCE_BINDING_SCHEMA}\n${producerSourceSha}\n${entrypoint}\n${closureSha256}\n`,
  ));
  if (source.closureSha256 !== closureSha256 || source.bindingSha256 !== bindingSha256) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
      `The ${label} producer tool source digest is invalid.`,
    );
  }
  return bindingSha256;
}

export function resolveCurrentReleaseSourceSha(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const containerSource = String(env.NEXUS_RELEASE_SOURCE_SHA ?? '').trim();
  const legacySource = String(env.NEXUS_RELEASE_SHA ?? '').trim();
  const validContainer = FULL_SHA.test(containerSource);
  const validLegacy = FULL_SHA.test(legacySource);
  if (validContainer && validLegacy && containerSource !== legacySource) {
    fail(
      'LOCAL_CONTROL_RELEASE_IDENTITY_AMBIGUOUS',
      'The serving release has conflicting source identities.',
    );
  }
  if (validContainer) return containerSource;
  if (validLegacy) return legacySource;
  fail(
    'LOCAL_CONTROL_RELEASE_IDENTITY_UNAVAILABLE',
    'The serving release source identity is unavailable.',
  );
}

function sameSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && before.nlink === after.nlink
    && before.mode === after.mode
    && before.uid === after.uid;
}

function readTrustedArtifact(artifactPath: string): Buffer {
  if (!path.isAbsolute(artifactPath)) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_PATH_INVALID',
      'The configured activation evidence path must be absolute.',
    );
  }
  const requested = path.resolve(artifactPath);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync.native(path.dirname(requested));
  } catch {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_UNAVAILABLE',
      'The configured activation evidence directory is unavailable.',
    );
  }
  const canonicalPath = path.join(canonicalParent, path.basename(requested));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const parentDescriptor = openSync(canonicalParent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      const effectiveUid = typeof process.geteuid === 'function'
        ? BigInt(process.geteuid())
        : fstatSync(descriptor, { bigint: true }).uid;
      const parent = fstatSync(parentDescriptor, { bigint: true });
      if (!parent.isDirectory() || parent.isSymbolicLink()
          || parent.uid !== effectiveUid || (parent.mode & 0o777n) !== 0o700n) {
        fail(
          'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_PERMISSIONS_INVALID',
          'The activation evidence directory must be an owner-controlled mode-0700 directory.',
        );
      }
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== effectiveUid
          || (before.mode & 0o777n) !== 0o600n
          || before.size < 1n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
        fail(
          'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_FILE_INVALID',
          'The activation evidence must be an owner-controlled mode-0600, single-link, bounded regular file.',
        );
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (!sameSnapshot(before, after) || BigInt(bytes.length) !== before.size) {
        fail(
          'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_CHANGED',
          'The activation evidence changed while it was being validated.',
        );
      }
      return bytes;
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (error instanceof LocalInferenceActivationEvidenceError) throw error;
    return fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_UNAVAILABLE',
      'The configured activation evidence cannot be opened safely.',
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validateLocalInferenceActivationEvidence(input: {
  evidenceReference: string | undefined;
  artifactPath: string;
  env?: Readonly<Record<string, string | undefined>>;
  authenticationSecret?: string;
  sourceRoot?: string;
}): ValidatedLocalInferenceActivationEvidence {
  const evidenceReference = String(input.evidenceReference ?? '').trim();
  if (!SHA256.test(evidenceReference)) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_REFERENCE_INVALID',
      'Production activation requires the exact lowercase SHA-256 reference of the configured economics artifact.',
    );
  }
  if (!input.artifactPath.trim()) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_UNAVAILABLE',
      'No trusted production activation evidence artifact is configured.',
    );
  }
  const bytes = readTrustedArtifact(input.artifactPath.trim());
  const artifactSha256 = sha256(bytes);
  if (artifactSha256 !== evidenceReference) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_DIGEST_MISMATCH',
      'The requested activation evidence reference does not match the configured artifact bytes.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SCHEMA_INVALID',
      'The configured activation evidence is not valid JSON.',
    );
  }
  const artifact = exactObject(
    parsed,
    ['schemaVersion', 'digestAlgorithm', 'payloadSha256', 'authentication', 'payload'],
    'Activation evidence',
  );
  if (artifact.schemaVersion !== LOCAL_INFERENCE_ACTIVATION_EVIDENCE_SCHEMA
      || artifact.digestAlgorithm !== PAYLOAD_DIGEST_ALGORITHM
      || typeof artifact.payloadSha256 !== 'string'
      || !SHA256.test(artifact.payloadSha256)) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SCHEMA_INVALID',
      'The activation evidence schema or digest contract is not current.',
    );
  }
  const payload = exactObject(artifact.payload, [
    'generatedAt', 'workloadSourceSha', 'producerSourceSha', 'producerToolSource',
    'sourceBindingSha256', 'bindings', 'measuredScriptP95', 'measuredOperationP95',
    'result',
  ], 'Activation evidence payload');
  const computedPayloadSha256 = sha256(Buffer.from(canonicalJson(payload)));
  if (computedPayloadSha256 !== artifact.payloadSha256) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_PAYLOAD_DIGEST_MISMATCH',
      'The activation evidence payload digest is invalid.',
    );
  }
  if (!isCanonicalTimestamp(payload.generatedAt)
      || !FULL_SHA.test(String(payload.workloadSourceSha ?? ''))
      || !FULL_SHA.test(String(payload.producerSourceSha ?? ''))
      || payload.workloadSourceSha === payload.producerSourceSha
      || typeof payload.sourceBindingSha256 !== 'string'
      || !SHA256.test(payload.sourceBindingSha256)) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
      'The activation evidence does not contain a valid distinct release-source pair.',
    );
  }
  const workloadSourceSha = payload.workloadSourceSha as string;
  const producerSourceSha = payload.producerSourceSha as string;
  const producerToolBindingSha256 = validateImmutableProducerToolSource(
    payload.producerToolSource,
    producerSourceSha,
    ECONOMICS_PRODUCER_ENTRYPOINT,
    ECONOMICS_PRODUCER_MODULES,
    'economics',
  );

  const bindings = exactObject(payload.bindings, [
    'rateCard', 'acceptance', 'operationUsage', 'release', 'workloadRelease',
  ], 'Activation evidence bindings');
  const acceptance = exactObject(bindings.acceptance, [
    'schemaVersion', 'acceptancePass', 'workloadSourceSha', 'evidenceSha256',
    'stateSha256', 'producerToolSource', 'qualityReviewSha256',
    'scopeSha256', 'workloadReleaseViewSha256', 'evidence',
  ], 'Activation acceptance binding');
  const release = exactObject(bindings.release, [
    'viewSchema', 'capturedAt', 'releaseId', 'sourceSha', 'stateStatus',
    'receiptSchema', 'receiptOutcome', 'receiptCompletedAt', 'releasePayloadDigest',
    'producerSourceSha', 'viewSha256',
  ], 'Activation producer release binding');
  const workloadRelease = exactObject(bindings.workloadRelease, [
    'viewSchema', 'capturedAt', 'releaseId', 'sourceSha', 'stateStatus',
    'receiptSchema', 'receiptOutcome', 'receiptCompletedAt', 'releasePayloadDigest',
    'backendImageDigest', 'boundAt', 'viewSha256',
  ], 'Activation workload release binding');
  if (acceptance.schemaVersion !== CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA
      || acceptance.acceptancePass !== true
      || acceptance.workloadSourceSha !== workloadSourceSha
      || !SHA256.test(String(acceptance.evidenceSha256 ?? ''))
      || !SHA256.test(String(acceptance.stateSha256 ?? ''))
      || !SHA256.test(String(acceptance.qualityReviewSha256 ?? ''))
      || !SHA256.test(String(acceptance.scopeSha256 ?? ''))
      || !SHA256.test(String(acceptance.workloadReleaseViewSha256 ?? ''))
      || release.viewSchema !== 'nexus.release-state-view.v2'
      || release.sourceSha !== producerSourceSha
      || release.producerSourceSha !== producerSourceSha
      || !RELEASE_ID.test(String(release.releaseId ?? ''))
      || !isCanonicalTimestamp(release.capturedAt)
      || release.stateStatus !== 'completed'
      || release.receiptSchema !== 'nexus.release-receipt.v3'
      || release.receiptOutcome !== 'completed'
      || !isCanonicalTimestamp(release.receiptCompletedAt)
      || !SHA256.test(String(release.releasePayloadDigest ?? ''))
      || !SHA256.test(String(release.viewSha256 ?? ''))
      || workloadRelease.viewSchema !== 'nexus.release-state-view.v2'
      || workloadRelease.sourceSha !== workloadSourceSha
      || !RELEASE_ID.test(String(workloadRelease.releaseId ?? ''))
      || !isCanonicalTimestamp(workloadRelease.capturedAt)
      || workloadRelease.stateStatus !== 'completed'
      || workloadRelease.receiptSchema !== 'nexus.release-receipt.v3'
      || workloadRelease.receiptOutcome !== 'completed'
      || !isCanonicalTimestamp(workloadRelease.receiptCompletedAt)
      || !SHA256.test(String(workloadRelease.releasePayloadDigest ?? ''))
      || !SHA256.test(String(workloadRelease.backendImageDigest ?? ''))
      || !isCanonicalTimestamp(workloadRelease.boundAt)
      || !SHA256.test(String(workloadRelease.viewSha256 ?? ''))
      || acceptance.workloadReleaseViewSha256 !== workloadRelease.viewSha256
      || release.releaseId === workloadRelease.releaseId
      || Date.parse(String(release.receiptCompletedAt)) > Date.parse(String(release.capturedAt))
      || Date.parse(String(workloadRelease.receiptCompletedAt)) > Date.parse(String(workloadRelease.capturedAt))
      || Date.parse(String(workloadRelease.capturedAt)) > Date.parse(String(workloadRelease.boundAt))
      || Date.parse(String(release.capturedAt)) > Date.parse(String(payload.generatedAt))
      || Date.parse(String(workloadRelease.boundAt)) > Date.parse(String(payload.generatedAt))) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_NOT_ACCEPTED',
      'The economics artifact is not bound to passing acceptance and the exact completed release-source pair.',
    );
  }
  const acceptanceProducerToolBindingSha256 = validateImmutableProducerToolSource(
    acceptance.producerToolSource,
    producerSourceSha,
    ACCEPTANCE_PRODUCER_ENTRYPOINT,
    ACCEPTANCE_PRODUCER_MODULES,
    'acceptance',
  );
  const acceptanceSourceBindingSha256 = sha256(Buffer.from(
    `${ACCEPTANCE_SOURCE_BINDING_SCHEMA}\n${workloadSourceSha}\n${producerSourceSha}\n${acceptanceProducerToolBindingSha256}\n`,
  ));
  const sourceBindingSha256 = sha256(Buffer.from(
    `${ECONOMICS_SOURCE_BINDING_SCHEMA}\n${workloadSourceSha}\n${producerSourceSha}\n${acceptanceSourceBindingSha256}\n${producerToolBindingSha256}\n`,
  ));
  if (payload.sourceBindingSha256 !== sourceBindingSha256) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_SOURCE_INVALID',
      'The activation evidence release and immutable producer-source binding is invalid.',
    );
  }
  const result = exactObject(payload.result, [
    'profiles', 'blendedMarginPct', 'webMarginPct', 'appleMarginPct', 'gates',
    'launchEligible',
  ], 'Activation economics result');
  const gates = exactObject(result.gates, [
    'blendedAtLeast80', 'webHasPaidCohort', 'webAtLeast80',
    'appleHasPaidCohort', 'appleFloor',
  ], 'Activation economics gates');
  if (result.launchEligible !== true
      || Object.values(gates).some((value) => value !== true)) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_NOT_ELIGIBLE',
      'The configured economics artifact is not launch eligible.',
    );
  }
  if (resolveCurrentReleaseSourceSha(input.env ?? process.env) !== producerSourceSha) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_RELEASE_MISMATCH',
      'The economics artifact producer source does not match the serving release.',
    );
  }

  const sourceRoot = realpathSync.native(path.resolve(input.sourceRoot ?? process.cwd()));
  const verifierPath = path.join(sourceRoot, ECONOMICS_VERIFIER_ENTRYPOINT);
  const verification = spawnSync(process.execPath, [verifierPath, '--source-root', sourceRoot], {
    input: bytes,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 128 * 1024,
    env: {
      ...process.env,
      LOCAL_PRIMARY_ACTIVATION_EVIDENCE_HMAC_SECRET:
        input.authenticationSecret
        ?? process.env.LOCAL_PRIMARY_ACTIVATION_EVIDENCE_HMAC_SECRET
        ?? '',
      NEXUS_RELEASE_SOURCE_SHA:
        input.env?.NEXUS_RELEASE_SOURCE_SHA ?? process.env.NEXUS_RELEASE_SOURCE_SHA ?? '',
      NEXUS_RELEASE_SHA:
        input.env?.NEXUS_RELEASE_SHA ?? process.env.NEXUS_RELEASE_SHA ?? '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (verification.error || verification.status !== 0) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_AUTHENTICATION_INVALID',
      'The activation artifact failed authenticated governed-input verification.',
    );
  }
  let verified: Record<string, unknown>;
  try {
    verified = exactObject(JSON.parse(verification.stdout), [
      'payloadSha256', 'sourceBindingSha256', 'workloadSourceSha', 'producerSourceSha',
    ], 'Activation verifier result');
  } catch {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_AUTHENTICATION_INVALID',
      'The activation artifact verifier returned an invalid result.',
    );
  }
  if (verified.payloadSha256 !== artifact.payloadSha256
      || verified.sourceBindingSha256 !== sourceBindingSha256
      || verified.workloadSourceSha !== workloadSourceSha
      || verified.producerSourceSha !== producerSourceSha) {
    fail(
      'LOCAL_CONTROL_ACCEPTANCE_EVIDENCE_AUTHENTICATION_INVALID',
      'The activation artifact verifier result does not match the trusted artifact.',
    );
  }

  return {
    evidenceReference,
    artifactSha256,
    payloadSha256: artifact.payloadSha256,
    sourceBindingSha256,
    workloadSourceSha,
    producerSourceSha,
  };
}
