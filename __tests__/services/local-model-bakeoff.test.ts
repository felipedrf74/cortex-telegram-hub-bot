// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildLocalModelBakeoff,
  type LocalModelBakeoffObservation,
} from '../../src/services/local-model-bakeoff';
import {
  SKILL_INFERENCE_PROFILE_VERSION,
  type SkillInferenceSkill,
} from '../../src/services/skill-inference-profiles';

const skills: SkillInferenceSkill[] = [
  'secretary', 'content', 'training', 'triathlon', 'cooking', 'finance',
];
const languages: LocalModelBakeoffObservation['language'][] = ['pt-BR', 'pt-PT', 'en', 'mixed'];
const manifest = JSON.parse(readFileSync('config/local-model-manifest.json', 'utf8'));

function eligibleCorpus(candidateId: string): LocalModelBakeoffObservation[] {
  const modelDigest = manifest.models.find((model: any) => model.id === candidateId)?.digest;
  if (!modelDigest) throw new Error(`candidate digest missing for ${candidateId}`);
  return Array.from({ length: 600 }, (_, index) => ({
    candidateId,
    modelDigest,
    profileVersion: SKILL_INFERENCE_PROFILE_VERSION,
    caseId: `case-${index}`,
    skillId: skills[index % skills.length]!,
    workload: index < 30 ? 'content_script' : index % 5 === 0 ? 'structured_tool_plan' : 'ordinary',
    language: index < 15 ? 'pt-BR' : index < 30 ? 'en' : languages[index % languages.length]!,
    skillAccuracy: 0.9,
    contentQuality: 0.9,
    structuredCorrectness: 1,
    languageQuality: 0.9,
    runtimePerformance: 0.8,
    cloudCriticalQualityDeltaPercent: -2,
    schemaValid: true,
    safetyFailure: false,
    tenantIsolationFailure: false,
    firstTokenMs: 2_000,
    totalDurationMs: 20_000,
    generatedTokensPerSecond: 5,
    peakInferenceMemoryBytes: 18 * 1024 ** 3,
    minimumHostAvailableBytes: 7 * 1024 ** 3,
    swapBytes: 0,
    ...(index < 30 ? {
      scriptWordCount: 2_100,
      scriptComplete: true,
      sourceConsistent: true,
    } : {}),
  }));
}

describe('local model bakeoff scorer', () => {
  it('binds the CLI report to the signed manifest and sanitized observation bytes', () => {
    const source = readFileSync('src/tools/local-model-bakeoff.ts', 'utf8');
    expect(source).toContain('observationInputDigest');
    expect(source).toContain('manifestVersion: manifest.manifestVersion');
    expect(source).toContain('productionEnvelope: manifest.productionEnvelope');
    expect(source).toContain('benchmarkEnvelope: manifest.benchmarkEnvelope');
  });

  it('accepts only a complete, safe, multilingual six-skill corpus inside the production envelope', () => {
    const report = buildLocalModelBakeoff(eligibleCorpus('qwen3.5-9b-candidate'));
    expect(report[0]).toMatchObject({
      candidateId: 'qwen3.5-9b-candidate',
      observationCount: 600,
      uniqueCaseCount: 600,
      scriptCount: 30,
      eligible: true,
      disqualifiers: [],
    });
    expect(report[0]!.score).toBe(90.5);
    expect(report[0]!.metrics).toMatchObject({
      structuredSchemaCount: 114,
      schemaValidityPercent: 100,
      scriptOutputContractPassPercent: 100,
      ordinaryChatP95FirstTokenMs: 2_000,
      ordinaryChatP95TotalDurationMs: 20_000,
      scriptP95TotalDurationMs: 20_000,
    });
  });

  it('calculates the 99 percent schema gate from structured cases only', () => {
    const corpus = eligibleCorpus('qwen3.5-9b-candidate');
    const structured = corpus.filter((row) => row.workload === 'structured_tool_plan');
    structured[0]!.schemaValid = false;
    structured[1]!.schemaValid = false;

    const candidate = buildLocalModelBakeoff(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.metrics.structuredSchemaCount).toBe(114);
    expect(candidate.metrics.schemaValidityPercent).toBeLessThan(99);
    expect(candidate.disqualifiers).toContain('schema_validity_below_99_percent');
  });

  it('disqualifies duplicate cases, a safety failure, swap, and sub-four-token script throughput', () => {
    const corpus = eligibleCorpus('qwen3.5-9b-candidate');
    corpus[599] = {
      ...corpus[599]!,
      caseId: corpus[0]!.caseId,
      safetyFailure: true,
      swapBytes: 1,
    };
    for (let index = 0; index < 30; index += 1) corpus[index]!.generatedTokensPerSecond = 3.9;
    const candidate = buildLocalModelBakeoff(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.eligible).toBe(false);
    expect(candidate.disqualifiers).toEqual(expect.arrayContaining([
      'fewer_than_600_unique_nexus_cases',
      'duplicate_case_observations',
      'safety_or_tenant_isolation_failure',
      'swap_detected',
      'script_throughput_below_4_tokens_per_second',
    ]));
  });

  it('disqualifies incomplete or out-of-length scripts and latency outside the public envelope', () => {
    const corpus = eligibleCorpus('qwen3.5-9b-candidate');
    corpus[0] = {
      ...corpus[0]!,
      scriptWordCount: 1_500,
      scriptComplete: false,
      sourceConsistent: false,
      totalDurationMs: 12 * 60 * 1_000 + 1,
    };
    corpus[1] = {
      ...corpus[1]!,
      totalDurationMs: 12 * 60 * 1_000 + 1,
    };
    for (const row of corpus.filter((entry) => entry.workload === 'ordinary')) {
      row.firstTokenMs = 12_001;
      row.totalDurationMs = 45_001;
    }

    const candidate = buildLocalModelBakeoff(corpus)
      .find((row) => row.candidateId === 'qwen3.5-9b-candidate')!;

    expect(candidate.disqualifiers).toEqual(expect.arrayContaining([
      'long_form_script_output_contract_failed',
      'ordinary_chat_first_token_p95_above_12_seconds',
      'ordinary_chat_total_p95_above_45_seconds',
      'long_form_script_p95_above_12_minutes',
    ]));
  });

  it('fails candidate identity when a digest or specialist profile changes mid-bakeoff', () => {
    const corpus = eligibleCorpus('qwen3.5-9b-candidate');
    corpus[100]!.modelDigest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    corpus[200]!.profileVersion = 'nexus-skill-inference-profiles-v0';

    const candidate = buildLocalModelBakeoff(corpus)
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

  it('reports empty percentile samples as null and never promotes an unobserved candidate', () => {
    const results = buildLocalModelBakeoff([]);

    expect(results.every((candidate) => candidate.eligible === false)).toBe(true);
    expect(results.every((candidate) => candidate.observationCount === 0)).toBe(true);
    expect(results.every((candidate) => candidate.metrics.p95FirstTokenMs === null)).toBe(true);
    expect(results.every((candidate) => candidate.metrics.p95TotalDurationMs === null)).toBe(true);
  });
});
