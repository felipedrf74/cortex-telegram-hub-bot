// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildLocalModelBakeoff,
  compareIdentityBlindFocusedQuality,
  type LocalModelBakeoffObservation,
} from '../../src/services/local-model-bakeoff';
import {
  SKILL_INFERENCE_PROFILE_VERSION,
} from '../../src/services/skill-inference-profiles';
import { buildFinalPassCases } from '../../scripts/local-model-final-pass.mjs';

const manifest = JSON.parse(readFileSync('config/local-model-manifest.json', 'utf8'));
const finalCases = buildFinalPassCases(JSON.parse(
  readFileSync('config/local-model-final-pass-cases.json', 'utf8'),
));
const canonicalCases = finalCases.map((row: any) => ({
  caseId: row.id,
  skillId: row.skillId,
  workload: row.workload,
  language: row.language,
}));

function score(corpus: LocalModelBakeoffObservation[]) {
  return buildLocalModelBakeoff(corpus, manifest, { canonicalCases });
}

function eligibleCorpus(
  candidateId: string,
  quality: 'challenger' | 'control' = 'challenger',
): LocalModelBakeoffObservation[] {
  const modelDigest = manifest.models.find((model: any) => model.id === candidateId)?.digest;
  if (!modelDigest) throw new Error(`candidate digest missing for ${candidateId}`);
  return finalCases.map((testCase: any) => ({
    candidateId,
    modelDigest,
    profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
    caseId: testCase.id,
    skillId: testCase.skillId,
    workload: testCase.workload,
    language: testCase.language,
    skillAccuracy: quality === 'challenger' ? 0.9 : 0.75,
    contentQuality: quality === 'challenger' ? 0.9 : 0.75,
    structuredCorrectness: quality === 'challenger' ? 1 : 0.9,
    languageQuality: quality === 'challenger' ? 0.9 : 0.75,
    runtimePerformance: 0.8,
    schemaValid: true,
    safetyFailure: false,
    tenantIsolationFailure: false,
    firstTokenMs: 2_000,
    totalDurationMs: 20_000,
    generatedTokensPerSecond: 5,
    peakInferenceMemoryBytes: 18 * 1024 ** 3,
    minimumHostAvailableBytes: 7 * 1024 ** 3,
    swapBytes: 0,
    ...(testCase.workload === 'content_sample' ? {
      contentSampleComplete: true,
      sourceConsistent: true,
    } : {}),
  }));
}

function pairedEligibleCorpus(candidateId: string): LocalModelBakeoffObservation[] {
  return [
    ...eligibleCorpus('qwen2.5-3b-control', 'control'),
    ...eligibleCorpus(candidateId),
  ];
}

describe('local model bakeoff scorer', () => {
  it('compares focused outputs using quality fields only and is order-symmetric', () => {
    const higher = { skillAccuracy: 1, contentQuality: 1, structuredCorrectness: 1, languageQuality: 1 };
    const lower = { skillAccuracy: 0.7, contentQuality: 0.7, structuredCorrectness: 0.7, languageQuality: 0.7 };
    expect(compareIdentityBlindFocusedQuality(higher, lower)).toBe(1);
    expect(compareIdentityBlindFocusedQuality(lower, higher)).toBe(-1);
    expect(compareIdentityBlindFocusedQuality(higher, higher)).toBe(0);
  });

  it('binds the CLI report to the signed manifest and sanitized observation bytes', () => {
    const source = readFileSync('src/tools/local-model-bakeoff.ts', 'utf8');
    expect(source).toContain('validateSanitizedFinalPassEvidence');
    expect(source).toContain('sanitizedArtifactDigest: validated.artifactDigest');
    expect(source).toContain('manifestVersion: validated.manifest.manifestVersion');
    expect(source).toContain('productionEnvelope: validated.manifest.productionEnvelope');
  });

  it('accepts only a complete, safe, multilingual six-skill corpus inside the production envelope', () => {
    const report = score(pairedEligibleCorpus('qwen3.5-9b-candidate'));
    expect(report[0]).toMatchObject({
      candidateId: 'qwen3.5-9b-candidate',
      observationCount: 112,
      uniqueCaseCount: 112,
      contentSampleCount: 6,
      controlCandidateId: 'qwen2.5-3b-control',
      pairedCaseCount: 12,
      pairedWins: 12,
      pairedWinPercent: 100,
      eligible: true,
      disqualifiers: [],
    });
    expect(report[0]!.score).toBe(90.5);
    expect(report[0]!.metrics).toMatchObject({
      structuredSchemaCount: 100,
      schemaValidityPercent: 100,
      contentSampleContractPassPercent: 100,
      ordinaryChatP95FirstTokenMs: 2_000,
      ordinaryChatP95TotalDurationMs: 20_000,
      contentSampleP95TotalDurationMs: 20_000,
    });
  });

  it('calculates the 99 percent schema gate from structured cases only', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    const structured = corpus.filter((row) => row.candidateId === 'qwen3.5-9b-candidate'
      && row.workload === 'structured_tool_plan');
    structured[0]!.schemaValid = false;
    structured[1]!.schemaValid = false;

    const candidate = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.metrics.structuredSchemaCount).toBe(100);
    expect(candidate.metrics.schemaValidityPercent).toBeLessThan(99);
    expect(candidate.disqualifiers).toContain('schema_validity_below_99_percent');
  });

  it('disqualifies duplicate cases, a safety failure, swap, and sub-four-token script throughput', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    corpus[223] = {
      ...corpus[223]!,
      caseId: corpus[112]!.caseId,
      safetyFailure: true,
      swapBytes: 1,
    };
    for (const row of corpus.filter((entry) => entry.candidateId === 'qwen3.5-9b-candidate'
      && entry.workload === 'content_sample')) row.generatedTokensPerSecond = 3.9;
    const candidate = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.eligible).toBe(false);
    expect(candidate.disqualifiers).toEqual(expect.arrayContaining([
      'final_pass_case_inventory_incomplete',
      'duplicate_case_observations',
      'safety_or_tenant_isolation_failure',
      'swap_detected',
      'content_sample_throughput_below_4_tokens_per_second',
    ]));
  });

  it('disqualifies incomplete samples and ordinary latency outside the public envelope', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    const sampleIndex = corpus.findIndex((row) => row.candidateId === 'qwen3.5-9b-candidate'
      && row.workload === 'content_sample');
    corpus[sampleIndex] = {
      ...corpus[sampleIndex]!,
      contentSampleComplete: false,
      sourceConsistent: false,
    };
    for (const row of corpus.filter((entry) => entry.workload === 'ordinary')) {
      row.firstTokenMs = 12_001;
      row.totalDurationMs = 45_001;
    }

    const candidate = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.disqualifiers).toEqual(expect.arrayContaining([
      'content_sample_output_contract_failed',
      'ordinary_chat_first_token_p95_above_12_seconds',
      'ordinary_chat_total_p95_above_45_seconds',
    ]));
  });

  it('fails candidate identity when a digest or specialist profile changes mid-bakeoff', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    corpus[212]!.modelDigest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    corpus[213]!.profileVersion = 'nexus-skill-inference-profiles-v0';

    const candidate = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate).toMatchObject({
      eligible: false,
      observedModelDigest: null,
      profileVersion: null,
    });
    expect(candidate.disqualifiers).toEqual(expect.arrayContaining([
      'model_digest_missing_or_changed_during_bakeoff',
      'skill_profile_version_missing_or_changed_during_bakeoff',
    ]));
  });

  it('requires the challenger to win at least 60 percent of identity-blind focused pairs', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    for (const row of corpus.filter((entry) => entry.candidateId === 'qwen3.5-9b-candidate'
      && entry.workload !== 'structured_tool_plan').slice(0, 5)) {
      row.skillAccuracy = 0.7;
      row.contentQuality = 0.7;
      row.structuredCorrectness = 0.8;
      row.languageQuality = 0.7;
    }
    const candidate = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.pairedCaseCount).toBe(12);
    expect(candidate.pairedWins).toBe(7);
    expect(candidate.pairedWinPercent).toBeLessThan(60);
    expect(candidate.disqualifiers).toContain('blind_paired_win_rate_below_60_percent');
  });

  it('rejects an alternate case identity even when all numeric scores pass', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    const candidateRow = corpus.find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;
    candidateRow.caseId = 'forged-case';

    const candidate = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;
    expect(candidate.disqualifiers).toContain('canonical_final_pass_case_identity_mismatch');
    expect(candidate.eligible).toBe(false);
  });

  it('uses cloud parity only with an independently supplied evidence digest', () => {
    const corpus = pairedEligibleCorpus('qwen3.5-9b-candidate');
    for (const row of corpus.filter((entry) => entry.candidateId === 'qwen3.5-9b-candidate')) {
      row.skillAccuracy = 0.8;
      row.contentQuality = 0.8;
      row.structuredCorrectness = 0.95;
      row.languageQuality = 0.8;
      row.cloudCriticalQualityDeltaPercent = -2;
    }
    const withoutEvidence = score(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;
    expect(withoutEvidence.disqualifiers)
      .toContain('challenger_did_not_beat_control_or_match_approved_cloud');

    const withEvidence = buildLocalModelBakeoff(corpus, manifest, {
      canonicalCases,
      approvedCloudEvidenceDigest: `sha256:${'a'.repeat(64)}`,
    }).find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;
    expect(withEvidence.disqualifiers)
      .not.toContain('challenger_did_not_beat_control_or_match_approved_cloud');
  });

  it('reports empty percentile samples as null and never promotes an unobserved candidate', () => {
    const results = score([]);

    expect(results.every((candidate) => candidate.eligible === false)).toBe(true);
    expect(results.every((candidate) => candidate.observationCount === 0)).toBe(true);
    expect(results.every((candidate) => candidate.metrics.p95FirstTokenMs === null)).toBe(true);
    expect(results.every((candidate) => candidate.metrics.p95TotalDurationMs === null)).toBe(true);
  });
});
