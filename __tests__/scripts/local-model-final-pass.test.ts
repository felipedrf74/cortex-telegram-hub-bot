import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFinalPassCases,
  sanitizeFinalPassPair,
} from '../../scripts/local-model-final-pass.mjs';
import { validateSanitizedFinalPassEvidence } from '../../src/services/local-model-bakeoff-evidence';

const corpusDocument = JSON.parse(readFileSync('config/local-model-final-pass-cases.json', 'utf8'));
const manifest = JSON.parse(readFileSync('config/local-model-manifest.json', 'utf8'));
const policy = JSON.parse(readFileSync('src/services/skill-inference-profile-policy.json', 'utf8'));

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function rawArtifact(candidateId: string) {
  const cases = buildFinalPassCases(corpusDocument);
  const candidate = manifest.models.find((entry: any) => entry.id === candidateId);
  const observations = cases.map((testCase: any) => {
    const answer = testCase.requiredTermGroups.map((group: string[]) => group[0]).join(' ');
    const response = JSON.stringify({
      action: testCase.expectedAction,
      answer,
      data: testCase.expectedData ?? {},
      language: testCase.language,
      skill: testCase.skillId,
    });
    return {
      caseId: testCase.id,
      skillId: testCase.skillId,
      language: testCase.language,
      workload: testCase.workload,
      promptSha256: sha256(testCase.prompt),
      responseSha256: sha256(response),
      response,
      runtime: {
        firstTokenMs: 1_000,
        totalDurationMs: 5_000,
        generatedTokensPerSecond: 10,
        peakInferenceMemoryBytes: 8 * 1024 ** 3,
        minimumHostAvailableBytes: 8 * 1024 ** 3,
        swapBytes: 0,
      },
      evaluation: { storedScoreIsIgnored: true },
    };
  });
  const artifact = {
    schemaVersion: 'nexus.local-model-final-pass-raw.v1',
    generatedAt: '2026-08-24T18:00:00.000Z',
    runnerSha256: sha256(readFileSync('scripts/local-model-final-pass.mjs')),
    manifestVersion: manifest.manifestVersion,
    manifestSha256: sha256(readFileSync('config/local-model-manifest.json')),
    corpusReference: corpusDocument.corpusReference,
    corpusSha256: sha256(Buffer.from(stableJson(cases))),
    profileVersion: policy.version,
    profilePolicySha256: sha256(readFileSync('src/services/skill-inference-profile-policy.json')),
    candidate: {
      id: candidate.id,
      ollamaTag: candidate.ollamaTag,
      modelDigest: candidate.digest,
      thinkMode: candidate.thinkMode,
    },
    observations,
    failure: null,
  };
  return { artifact, bytes: Buffer.from(`${JSON.stringify(artifact)}\n`) };
}

describe('local-model full blind-paired final pass', () => {
  it('locks 6 ordinary, 6 content, and 100 compact structured cases', () => {
    const cases = buildFinalPassCases(corpusDocument);
    expect(cases).toHaveLength(112);
    expect(cases.filter((row: any) => row.workload === 'ordinary')).toHaveLength(6);
    expect(cases.filter((row: any) => row.workload === 'content_sample')).toHaveLength(6);
    expect(cases.filter((row: any) => row.workload === 'structured_tool_plan')).toHaveLength(100);
    expect(new Set(cases.map((row: any) => row.skillId)).size).toBe(6);
    expect(new Set(cases.map((row: any) => row.language)).size).toBe(4);
  });

  it('re-evaluates private raw outputs and emits only sanitized observations', () => {
    const challenger = rawArtifact('gpt-oss-20b-candidate');
    const control = rawArtifact('qwen2.5-3b-control');
    const result = sanitizeFinalPassPair({
      challengerBytes: challenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
    });

    expect(result.observations).toHaveLength(224);
    expect(result.observations.every((row: any) => !('response' in row))).toBe(true);
    expect(result.observations.filter((row: any) => row.workload === 'content_sample'))
      .toHaveLength(12);
    expect(result.observations.every((row: any) => row.schemaValid)).toBe(true);
    expect(validateSanitizedFinalPassEvidence({
      artifactBytes: Buffer.from(`${JSON.stringify(result)}\n`),
      challengerRawArtifactBytes: challenger.bytes,
      controlRawArtifactBytes: control.bytes,
      repositoryRoot: process.cwd(),
    }).artifact.challengerCandidateId).toBe('gpt-oss-20b-candidate');
  });

  it('rejects forged sanitized values by independently re-sanitizing the raw pair', () => {
    const challenger = rawArtifact('gpt-oss-20b-candidate');
    const control = rawArtifact('qwen2.5-3b-control');
    const result = sanitizeFinalPassPair({
      challengerBytes: challenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
      generatedAt: '2026-08-24T18:30:00.000Z',
    });
    for (const row of result.observations) {
      row.skillAccuracy = 0.123;
      row.contentQuality = 0.123;
      row.structuredCorrectness = 0.123;
      row.languageQuality = 0.123;
      row.runtimePerformance = 0.123;
    }

    expect(() => validateSanitizedFinalPassEvidence({
      artifactBytes: Buffer.from(`${JSON.stringify(result)}\n`),
      challengerRawArtifactBytes: challenger.bytes,
      controlRawArtifactBytes: control.bytes,
      repositoryRoot: process.cwd(),
    })).toThrow(/re-sanitization/);
  });

  it('joins only exact independently digested and approval-bound cloud evidence', () => {
    const challenger = rawArtifact('gpt-oss-20b-candidate');
    const control = rawArtifact('qwen2.5-3b-control');
    const result = sanitizeFinalPassPair({
      challengerBytes: challenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
      generatedAt: '2026-08-24T18:30:00.000Z',
    });
    const approvalEvidenceDigest = `sha256:${'a'.repeat(64)}`;
    const cloud = {
      schemaVersion: 'nexus.local-model-approved-cloud-evidence.v1',
      generatedAt: '2026-08-24T18:15:00.000Z',
      status: 'approved',
      provider: 'reviewed-provider',
      model: 'reviewed-model',
      approvalReference: 'owner-review-2026-08-24',
      approvalEvidenceDigest,
      challengerCandidateId: result.challengerCandidateId,
      challengerModelDigest: result.observations.find((row) => (
        row.candidateId === result.challengerCandidateId
      ))!.modelDigest,
      challengerRawArtifactSha256: result.challengerArtifactSha256,
      localSanitizedArtifactSha256: sha256(Buffer.from(`${JSON.stringify(result)}\n`)),
      corpusReference: result.corpusReference,
      corpusSha256: result.corpusSha256,
      caseContractSha256: result.caseContractSha256,
      profileVersion: result.profileVersion,
      observations: result.canonicalCases.map((row) => ({
        caseId: row.caseId,
        cloudCriticalQualityDeltaPercent: -2,
      })),
    };
    const cloudBytes = Buffer.from(`${JSON.stringify(cloud)}\n`);
    const validated = validateSanitizedFinalPassEvidence({
      artifactBytes: Buffer.from(`${JSON.stringify(result)}\n`),
      challengerRawArtifactBytes: challenger.bytes,
      controlRawArtifactBytes: control.bytes,
      repositoryRoot: process.cwd(),
      approvedCloudEvidenceBytes: cloudBytes,
      approvedCloudEvidenceDigest: sha256(cloudBytes),
      approvedCloudApprovalEvidenceDigest: approvalEvidenceDigest,
    });

    expect(validated.approvedCloudEvidenceDigest).toBe(sha256(cloudBytes));
    expect(validated.observations.filter((row) => row.candidateId === result.challengerCandidateId))
      .toHaveLength(112);
    expect(validated.observations.filter((row) => row.candidateId === result.challengerCandidateId)
      .every((row) => row.cloudCriticalQualityDeltaPercent === -2)).toBe(true);
    expect(() => validateSanitizedFinalPassEvidence({
      artifactBytes: Buffer.from(`${JSON.stringify(result)}\n`),
      challengerRawArtifactBytes: challenger.bytes,
      controlRawArtifactBytes: control.bytes,
      repositoryRoot: process.cwd(),
      approvedCloudEvidenceBytes: cloudBytes,
      approvedCloudEvidenceDigest: `sha256:${'b'.repeat(64)}`,
      approvedCloudApprovalEvidenceDigest: approvalEvidenceDigest,
    })).toThrow(/approval-bound/);

    const otherChallenger = rawArtifact('ministral-3-14b-candidate');
    const otherResult = sanitizeFinalPassPair({
      challengerBytes: otherChallenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
      generatedAt: result.generatedAt,
    });
    expect(() => validateSanitizedFinalPassEvidence({
      artifactBytes: Buffer.from(`${JSON.stringify(otherResult)}\n`),
      challengerRawArtifactBytes: otherChallenger.bytes,
      controlRawArtifactBytes: control.bytes,
      repositoryRoot: process.cwd(),
      approvedCloudEvidenceBytes: cloudBytes,
      approvedCloudEvidenceDigest: sha256(cloudBytes),
      approvedCloudApprovalEvidenceDigest: approvalEvidenceDigest,
    })).toThrow(/approval-bound/);
  });

  it('rejects alternate case contracts and raw fields at the release scorer boundary', () => {
    const challenger = rawArtifact('gpt-oss-20b-candidate');
    const control = rawArtifact('qwen2.5-3b-control');
    const result = sanitizeFinalPassPair({
      challengerBytes: challenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
    });
    result.canonicalCases[0].caseId = 'forged-case';
    result.observations[0].response = 'raw output must never be accepted';

    expect(() => validateSanitizedFinalPassEvidence({
      artifactBytes: Buffer.from(`${JSON.stringify(result)}\n`),
      challengerRawArtifactBytes: challenger.bytes,
      controlRawArtifactBytes: control.bytes,
      repositoryRoot: process.cwd(),
    })).toThrow(/canonical release contract/);
  });

  it('rejects raw artifact manifest, model, corpus, or failure-state drift', () => {
    const challenger = rawArtifact('gpt-oss-20b-candidate');
    const control = rawArtifact('qwen2.5-3b-control');
    challenger.artifact.manifestSha256 = `sha256:${'f'.repeat(64)}`;
    challenger.artifact.corpusReference = 'alternate-corpus';
    challenger.artifact.candidate.ollamaTag = 'other:tag';
    challenger.artifact.candidate.thinkMode = false;
    challenger.artifact.failure = { caseId: 'forged', code: 'claimed_failure' };
    challenger.bytes = Buffer.from(`${JSON.stringify(challenger.artifact)}\n`);

    expect(() => sanitizeFinalPassPair({
      challengerBytes: challenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
    })).toThrow(/not bound/);
  });

  it('rejects response tampering instead of trusting stored evaluator scores', () => {
    const challenger = rawArtifact('gpt-oss-20b-candidate');
    const control = rawArtifact('qwen2.5-3b-control');
    challenger.artifact.observations[0].response = '{"tampered":true}';
    challenger.bytes = Buffer.from(`${JSON.stringify(challenger.artifact)}\n`);

    expect(() => sanitizeFinalPassPair({
      challengerBytes: challenger.bytes,
      controlBytes: control.bytes,
      cases: buildFinalPassCases(corpusDocument),
      corpusReference: corpusDocument.corpusReference,
      manifest,
      manifestBytes: readFileSync('config/local-model-manifest.json'),
    })).toThrow(/integrity failed/);
  });
});
