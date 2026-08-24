// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type {
  LocalModelBakeoffCaseContract,
  LocalModelBakeoffObservation,
} from './local-model-bakeoff';
import { getLocalModelManifest, type LocalModelManifest } from './ollama-model-policy';
import { SKILL_INFERENCE_PROFILE_VERSION } from './skill-inference-profiles';

export interface SanitizedFinalPassArtifact {
  schemaVersion: 'nexus.local-model-final-pass-sanitized.v1';
  generatedAt: string;
  producerSha256: string;
  manifestVersion: string;
  manifestSha256: string;
  corpusReference: string;
  corpusSha256: string;
  caseContractSha256: string;
  profileVersion: string;
  profilePolicySha256: string;
  controlCandidateId: string;
  challengerCandidateId: string;
  challengerArtifactSha256: string;
  controlArtifactSha256: string;
  canonicalCases: LocalModelBakeoffCaseContract[];
  observations: LocalModelBakeoffObservation[];
}

export interface ValidatedFinalPassEvidence {
  artifact: SanitizedFinalPassArtifact;
  manifest: LocalModelManifest;
  artifactDigest: string;
  observations: LocalModelBakeoffObservation[];
  approvedCloudEvidenceDigest?: string;
}

interface ApprovedCloudObservation {
  caseId: string;
  cloudCriticalQualityDeltaPercent: number;
}

interface ApprovedCloudEvidenceArtifact {
  schemaVersion: 'nexus.local-model-approved-cloud-evidence.v1';
  generatedAt: string;
  status: 'approved';
  provider: string;
  model: string;
  approvalReference: string;
  approvalEvidenceDigest: string;
  challengerCandidateId: string;
  challengerModelDigest: string;
  challengerRawArtifactSha256: string;
  localSanitizedArtifactSha256: string;
  corpusReference: string;
  corpusSha256: string;
  caseContractSha256: string;
  profileVersion: string;
  observations: ApprovedCloudObservation[];
}

const TOP_LEVEL_KEYS = [
  'canonicalCases', 'caseContractSha256',
  'challengerArtifactSha256', 'challengerCandidateId', 'controlArtifactSha256',
  'controlCandidateId', 'corpusReference', 'corpusSha256', 'generatedAt',
  'manifestSha256', 'manifestVersion', 'observations', 'producerSha256',
  'profilePolicySha256', 'profileVersion', 'schemaVersion',
].sort();
const APPROVED_CLOUD_KEYS = [
  'approvalEvidenceDigest', 'approvalReference', 'caseContractSha256',
  'challengerCandidateId', 'challengerModelDigest', 'challengerRawArtifactSha256',
  'corpusReference', 'corpusSha256', 'generatedAt', 'localSanitizedArtifactSha256',
  'model', 'observations', 'profileVersion', 'provider', 'schemaVersion', 'status',
].sort();
const APPROVED_CLOUD_OBSERVATION_KEYS = ['caseId', 'cloudCriticalQualityDeltaPercent'].sort();
const CASE_KEYS = ['caseId', 'language', 'skillId', 'workload'].sort();
const OBSERVATION_KEYS = [
  'candidateId', 'caseId', 'firstTokenMs', 'generatedTokensPerSecond',
  'language', 'languageQuality', 'minimumHostAvailableBytes', 'modelDigest',
  'peakInferenceMemoryBytes', 'profileVersion', 'runtimePerformance',
  'safetyFailure', 'schemaValid', 'skillAccuracy', 'skillId', 'structuredCorrectness',
  'swapBytes', 'tenantIsolationFailure', 'totalDurationMs', 'workload',
  'contentQuality',
].sort();

export function validateSanitizedFinalPassEvidence(input: {
  artifactBytes: Buffer;
  challengerRawArtifactBytes: Buffer;
  controlRawArtifactBytes: Buffer;
  repositoryRoot: string;
  approvedCloudEvidenceBytes?: Buffer;
  approvedCloudEvidenceDigest?: string;
  approvedCloudApprovalEvidenceDigest?: string;
}): ValidatedFinalPassEvidence {
  const artifact = parseArtifact(input.artifactBytes);
  const manifestPath = path.join(input.repositoryRoot, 'config/local-model-manifest.json');
  const corpusPath = path.join(input.repositoryRoot, 'config/local-model-final-pass-cases.json');
  const producerPath = path.join(input.repositoryRoot, 'scripts/local-model-final-pass.mjs');
  const profilePolicyPath = path.join(input.repositoryRoot, 'src/services/skill-inference-profile-policy.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as Record<string, unknown>;
  const manifest = getLocalModelManifest({ fresh: true });
  const control = manifest.models.find((candidate) => candidate.role === 'control');
  const challenger = manifest.models.find((candidate) => candidate.id === artifact.challengerCandidateId);
  const exactTopLevel = sameKeys(artifact as unknown as Record<string, unknown>, TOP_LEVEL_KEYS);
  const exactCases = Array.isArray(artifact.canonicalCases)
    && artifact.canonicalCases.every((row) => sameKeys(row as unknown as Record<string, unknown>, CASE_KEYS));
  const exactObservations = Array.isArray(artifact.observations)
    && artifact.observations.every((row) => sameKeys(
      row as unknown as Record<string, unknown>,
      row.workload === 'content_sample'
        ? [...OBSERVATION_KEYS, 'contentSampleComplete', 'sourceConsistent'].sort()
        : OBSERVATION_KEYS,
    ));

  if (!exactTopLevel
      || artifact.schemaVersion !== 'nexus.local-model-final-pass-sanitized.v1'
      || !Number.isFinite(Date.parse(artifact.generatedAt))
      || artifact.producerSha256 !== sha256(fs.readFileSync(producerPath))
      || artifact.manifestVersion !== manifest.manifestVersion
      || artifact.manifestSha256 !== sha256(manifestBytes)
      || artifact.corpusReference !== corpus.corpusReference
      || artifact.corpusSha256 !== corpus.corpusSha256
      || artifact.caseContractSha256 !== corpus.caseContractSha256
      || artifact.profileVersion !== SKILL_INFERENCE_PROFILE_VERSION
      || artifact.profilePolicySha256 !== sha256(fs.readFileSync(profilePolicyPath))
      || !control || artifact.controlCandidateId !== control.id
      || !challenger || challenger.role !== 'candidate'
      || artifact.challengerArtifactSha256 !== sha256(input.challengerRawArtifactBytes)
      || artifact.controlArtifactSha256 !== sha256(input.controlRawArtifactBytes)
      || !exactCases
      || stableJsonDigest(artifact.canonicalCases) !== corpus.caseContractSha256
      || !exactObservations
      || artifact.observations.length !== artifact.canonicalCases.length * 2
      || artifact.observations.some((row) => (
        row.candidateId !== artifact.controlCandidateId
        && row.candidateId !== artifact.challengerCandidateId
      ))) {
    throw new Error('Sanitized final-pass artifact is not bound to the current canonical release contract');
  }

  const recomputed = resanitizeRawPair({
    artifact,
    challengerRawArtifactBytes: input.challengerRawArtifactBytes,
    controlRawArtifactBytes: input.controlRawArtifactBytes,
    producerPath,
    repositoryRoot: input.repositoryRoot,
  });
  if (stableJson(recomputed) !== stableJson(artifact)) {
    throw new Error('Sanitized final-pass artifact differs from the current producer re-sanitization of its raw pair');
  }

  const cloudInputs = [
    input.approvedCloudEvidenceBytes,
    input.approvedCloudEvidenceDigest,
    input.approvedCloudApprovalEvidenceDigest,
  ];
  const cloudInputCount = cloudInputs.filter((value) => value !== undefined).length;
  if (cloudInputCount !== 0 && cloudInputCount !== cloudInputs.length) {
    throw new Error('Approved cloud evidence bytes, artifact digest, and approval digest must be supplied together');
  }
  const observations = artifact.observations.map((row) => ({ ...row }));
  if (cloudInputCount === cloudInputs.length) {
    const cloud = validateApprovedCloudEvidence({
      artifactBytes: input.approvedCloudEvidenceBytes!,
      artifactDigest: input.approvedCloudEvidenceDigest!,
      approvalEvidenceDigest: input.approvedCloudApprovalEvidenceDigest!,
      localArtifact: artifact,
      localArtifactDigest: sha256(input.artifactBytes),
    });
    const cloudByCase = new Map(cloud.observations.map((row) => [row.caseId, row]));
    for (const row of observations) {
      if (row.candidateId === artifact.challengerCandidateId) {
        row.cloudCriticalQualityDeltaPercent = cloudByCase.get(row.caseId)!.cloudCriticalQualityDeltaPercent;
      }
    }
    return {
      artifact,
      manifest,
      artifactDigest: sha256(input.artifactBytes),
      observations,
      approvedCloudEvidenceDigest: input.approvedCloudEvidenceDigest,
    };
  }
  return { artifact, manifest, artifactDigest: sha256(input.artifactBytes), observations };
}

function validateApprovedCloudEvidence(input: {
  artifactBytes: Buffer;
  artifactDigest: string;
  approvalEvidenceDigest: string;
  localArtifact: SanitizedFinalPassArtifact;
  localArtifactDigest: string;
}): ApprovedCloudEvidenceArtifact {
  const artifact = parseJson<ApprovedCloudEvidenceArtifact>(input.artifactBytes, 'approved cloud evidence');
  const localCaseIds = new Set(input.localArtifact.canonicalCases.map((row) => row.caseId));
  const observedCaseIds = new Set(artifact.observations?.map((row) => row.caseId));
  if (input.artifactDigest !== sha256(input.artifactBytes)
      || !/^sha256:[0-9a-f]{64}$/u.test(input.approvalEvidenceDigest)
      || !sameKeys(artifact as unknown as Record<string, unknown>, APPROVED_CLOUD_KEYS)
      || artifact.schemaVersion !== 'nexus.local-model-approved-cloud-evidence.v1'
      || artifact.status !== 'approved'
      || !Number.isFinite(Date.parse(artifact.generatedAt))
      || !artifact.provider?.trim() || !artifact.model?.trim() || !artifact.approvalReference?.trim()
      || artifact.approvalEvidenceDigest !== input.approvalEvidenceDigest
      || artifact.challengerCandidateId !== input.localArtifact.challengerCandidateId
      || artifact.challengerModelDigest !== input.localArtifact.observations.find((row) => (
        row.candidateId === input.localArtifact.challengerCandidateId
      ))?.modelDigest
      || artifact.challengerRawArtifactSha256 !== input.localArtifact.challengerArtifactSha256
      || artifact.localSanitizedArtifactSha256 !== input.localArtifactDigest
      || artifact.corpusReference !== input.localArtifact.corpusReference
      || artifact.corpusSha256 !== input.localArtifact.corpusSha256
      || artifact.caseContractSha256 !== input.localArtifact.caseContractSha256
      || artifact.profileVersion !== input.localArtifact.profileVersion
      || !Array.isArray(artifact.observations)
      || artifact.observations.length !== input.localArtifact.canonicalCases.length
      || observedCaseIds.size !== localCaseIds.size
      || artifact.observations.some((row) => (
        !sameKeys(row as unknown as Record<string, unknown>, APPROVED_CLOUD_OBSERVATION_KEYS)
        || !localCaseIds.has(row.caseId)
        || !Number.isFinite(row.cloudCriticalQualityDeltaPercent)
        || row.cloudCriticalQualityDeltaPercent < -100
        || row.cloudCriticalQualityDeltaPercent > 100
      ))) {
    throw new Error('Approved cloud evidence is not an exact, approval-bound canonical case join');
  }
  return artifact;
}

function resanitizeRawPair(input: {
  artifact: SanitizedFinalPassArtifact;
  challengerRawArtifactBytes: Buffer;
  controlRawArtifactBytes: Buffer;
  producerPath: string;
  repositoryRoot: string;
}): SanitizedFinalPassArtifact {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-final-pass-verify-'));
  const challengerPath = path.join(tempRoot, 'challenger.raw.json');
  const controlPath = path.join(tempRoot, 'control.raw.json');
  const outputPath = path.join(tempRoot, 'sanitized.json');
  try {
    fs.writeFileSync(challengerPath, input.challengerRawArtifactBytes, { mode: 0o600 });
    fs.writeFileSync(controlPath, input.controlRawArtifactBytes, { mode: 0o600 });
    execFileSync(process.execPath, [
      input.producerPath,
      '--sanitize-pair',
      '--challenger-artifact', challengerPath,
      '--control-artifact', controlPath,
      '--generated-at', input.artifact.generatedAt,
      '--output', outputPath,
    ], {
      cwd: input.repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseJson<SanitizedFinalPassArtifact>(fs.readFileSync(outputPath), 're-sanitized final pass');
  } catch (error) {
    throw new Error(`Raw final-pass pair could not be independently re-sanitized: ${(error as Error).message}`);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
}

function parseArtifact(bytes: Buffer): SanitizedFinalPassArtifact {
  return parseJson<SanitizedFinalPassArtifact>(bytes, 'sanitized final-pass artifact');
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try { return JSON.parse(bytes.toString('utf8')) as T; }
  catch (error) { throw new Error(`Invalid ${label}: ${(error as Error).message}`); }
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return stableJson(Object.keys(value).sort()) === stableJson(expected);
}

function sha256(bytes: crypto.BinaryLike): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`;
}

function stableJsonDigest(value: unknown): string {
  return sha256(Buffer.from(stableJson(value)));
}
