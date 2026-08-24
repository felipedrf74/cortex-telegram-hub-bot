// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import {
  buildLocalModelBakeoff,
} from '../services/local-model-bakeoff';
import { validateSanitizedFinalPassEvidence } from '../services/local-model-bakeoff-evidence';

const artifactPath = readRequired('--observations');
const challengerRawArtifactPath = readRequired('--challenger-artifact');
const controlRawArtifactPath = readRequired('--control-artifact');
const approvedCloudEvidencePath = readOptional('--approved-cloud-evidence');
const approvedCloudEvidenceDigest = readOptional('--approved-cloud-evidence-digest');
const approvedCloudApprovalEvidenceDigest = readOptional('--approved-cloud-approval-evidence-digest');
const validated = validateSanitizedFinalPassEvidence({
  artifactBytes: fs.readFileSync(artifactPath),
  challengerRawArtifactBytes: fs.readFileSync(challengerRawArtifactPath),
  controlRawArtifactBytes: fs.readFileSync(controlRawArtifactPath),
  repositoryRoot: process.cwd(),
  ...(approvedCloudEvidencePath === undefined ? {} : {
    approvedCloudEvidenceBytes: fs.readFileSync(approvedCloudEvidencePath),
  }),
  ...(approvedCloudEvidenceDigest === undefined ? {} : { approvedCloudEvidenceDigest }),
  ...(approvedCloudApprovalEvidenceDigest === undefined ? {} : { approvedCloudApprovalEvidenceDigest }),
});
const artifact = validated.artifact;
const results = buildLocalModelBakeoff(validated.observations, validated.manifest, {
  canonicalCases: artifact.canonicalCases,
  ...(validated.approvedCloudEvidenceDigest === undefined ? {} : {
    approvedCloudEvidenceDigest: validated.approvedCloudEvidenceDigest,
  }),
});
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'nexus-local-model-bakeoff-report-v4',
  generatedAt: new Date().toISOString(),
  manifestVersion: validated.manifest.manifestVersion,
  sanitizedArtifactDigest: validated.artifactDigest,
  corpusReference: artifact.corpusReference,
  corpusSha256: artifact.corpusSha256,
  caseContractSha256: artifact.caseContractSha256,
  profileVersion: artifact.profileVersion,
  controlCandidateId: artifact.controlCandidateId,
  challengerCandidateId: artifact.challengerCandidateId,
  approvedCloudEvidenceDigest: validated.approvedCloudEvidenceDigest ?? null,
  observationCount: validated.observations.length,
  productionEnvelope: validated.manifest.productionEnvelope,
  benchmarkEnvelope: validated.manifest.benchmarkEnvelope,
  results,
}, null, 2)}\n`);

function readRequired(flag: string): string {
  const value = readOptional(flag);
  if (!value) throw new Error(`${flag} requires an artifact path`);
  return value;
}

function readOptional(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value?.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}
