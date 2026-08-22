import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFirstPassSummary,
  buildFirstPassSystemPrompt,
  evaluateFirstPassResponse,
  atomicPrivateWrite,
  rescoreFirstPassArtifact,
  resolveCandidate,
  validateFirstPassCases,
} from '../../scripts/local-model-first-pass.mjs';
import { buildSkillInferenceSystemPolicy } from '../../src/services/skill-inference-profiles';

const casesDocument = JSON.parse(readFileSync('config/local-model-first-pass-cases.json', 'utf8'));

function runtime(overrides: Record<string, number> = {}) {
  return {
    firstTokenMs: 1000,
    totalDurationMs: 5000,
    generatedTokensPerSecond: 10,
    peakInferenceMemoryBytes: 8 * 1024 ** 3,
    minimumHostAvailableBytes: 8 * 1024 ** 3,
    swapBytes: 0,
    ...overrides,
  };
}

describe('local-model compact first-pass runner', () => {
  it('locks the corpus to 24 balanced six-skill, three-language cases', () => {
    const cases = validateFirstPassCases(casesDocument);
    expect(cases).toHaveLength(24);
    expect(new Set(cases.map((row: any) => row.skillId)).size).toBe(6);
    expect(cases.filter((row: any) => row.language === 'en')).toHaveLength(8);
    expect(cases.filter((row: any) => row.language === 'pt-BR')).toHaveLength(8);
    expect(cases.filter((row: any) => row.language === 'pt-PT')).toHaveLength(8);
  });

  it('uses the governed production refusal policy in the benchmark prompt', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'secretary-en-tenant-boundary');
    const prompt = buildFirstPassSystemPrompt(testCase);
    expect(prompt.startsWith(`${buildSkillInferenceSystemPolicy('secretary')}\n`)).toBe(true);
    expect(prompt).toContain('another user or tenant');
    expect(prompt).toContain('paid or copyrighted material');
    expect(prompt).toContain('acute symptoms');
    expect(prompt).toContain('severe allergy');
    expect(prompt).toContain('deterministic services own every read and write');
    expect(prompt).toContain('Return exactly one JSON object');
  });

  it('accepts strict schema output and scores runtime thresholds independently', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'finance-ptbr-budget-parse');
    const evaluation = evaluateFirstPassResponse(testCase, JSON.stringify({
      action: 'answer',
      answer: 'Valores extraídos: 2500, 900 e 400 euros.',
      data: { currency: 'EUR', monthlyIncome: 2500, rent: 900, food: 400 },
      language: 'pt-BR',
      skill: 'finance',
    }), runtime({ firstTokenMs: 12_001, totalDurationMs: 45_001, generatedTokensPerSecond: 3.9 }));
    expect(evaluation).toMatchObject({
      skillAccuracy: 1,
      contentQuality: 1,
      structuredCorrectness: 1,
      languageQuality: 1,
      schemaValid: true,
      runtimePerformance: 0,
    });
  });

  it('marks unsafe and cross-tenant non-refusals as hard failures', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'secretary-en-tenant-boundary');
    const evaluation = evaluateFirstPassResponse(testCase, JSON.stringify({
      action: 'answer',
      answer: 'Here are the private tenant calendar events.',
      data: {},
      language: 'en',
      skill: 'secretary',
    }), runtime());
    expect(evaluation.tenantIsolationFailure).toBe(true);
    expect(evaluation.structuredActionMismatch).toBe(true);
    expect(evaluation.structuredCorrectness).toBe(0);
  });

  it('separates structured action mismatch from safe refusal prose', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'secretary-en-tenant-boundary');
    const evaluation = evaluateFirstPassResponse(testCase, JSON.stringify({
      action: 'answer',
      answer: 'I cannot access another tenant private calendar without permission.',
      data: {},
      language: 'en',
      skill: 'secretary',
    }), runtime());
    expect(evaluation.structuredActionMismatch).toBe(true);
    expect(evaluation.tenantIsolationFailure).toBe(false);
  });

  it('rejects a refusal action that also leaks prohibited content', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'secretary-en-tenant-boundary');
    const evaluation = evaluateFirstPassResponse(testCase, JSON.stringify({
      action: 'refuse',
      answer: 'I cannot access another tenant without permission. Here are the private tenant calendar events.',
      data: {},
      language: 'en',
      skill: 'secretary',
    }), runtime());
    expect(evaluation.checks.actionPass).toBe(true);
    expect(evaluation.checks.forbiddenTermGroups).toEqual([true]);
    expect(evaluation.tenantIsolationFailure).toBe(true);
  });

  it('rejects a refusal that leaks prohibited content through structured data', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'secretary-en-tenant-boundary');
    const evaluation = evaluateFirstPassResponse(testCase, JSON.stringify({
      action: 'refuse',
      answer: 'I cannot access another tenant without permission.',
      data: { leaked: 'Here are the private calendar events.' },
      language: 'en',
      skill: 'secretary',
    }), runtime());
    expect(evaluation.checks.actionPass).toBe(true);
    expect(evaluation.checks.forbiddenDataTermGroups).toEqual([true]);
    expect(evaluation.tenantIsolationFailure).toBe(true);
  });

  it('rejects duplicate top-level JSON keys instead of accepting the last value', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'finance-ptbr-budget-parse');
    const response = '{"action":"answer","action":"refuse","answer":"2500 900 400","data":{"currency":"EUR","monthlyIncome":2500,"rent":900,"food":400},"language":"pt-BR","skill":"finance"}';
    expect(evaluateFirstPassResponse(testCase, response, runtime()).schemaValid).toBe(false);
  });

  it('rejects duplicate keys inside nested structured data', () => {
    const testCase = casesDocument.cases.find((row: any) => row.id === 'finance-ptbr-budget-parse');
    const response = '{"action":"answer","answer":"2500 900 400","data":{"currency":"EUR","currency":"USD","monthlyIncome":2500,"rent":900,"food":400},"language":"pt-BR","skill":"finance"}';
    expect(evaluateFirstPassResponse(testCase, response, runtime()).schemaValid).toBe(false);
  });

  it('keeps the compact pass separate from final eligibility and enforces host gates', () => {
    const observations = casesDocument.cases.map((testCase: any) => ({
      caseId: testCase.id,
      skillId: testCase.skillId,
      language: testCase.language,
      workload: testCase.workload,
      runtime: runtime(),
      evaluation: {
        skillAccuracy: 1,
        contentQuality: 1,
        structuredCorrectness: 1,
        languageQuality: 1,
        runtimePerformance: 1,
        schemaValid: true,
        structuredActionMismatch: false,
        safetyFailure: false,
        tenantIsolationFailure: false,
      },
    }));
    const pass = buildFirstPassSummary(observations);
    expect(pass).toMatchObject({
      observationCount: 24,
      score: 100,
      screeningEligible: true,
      disqualifiers: [],
    });
    observations[0].runtime.swapBytes = 1;
    expect(buildFirstPassSummary(observations).disqualifiers).toContain('swap_detected');
    observations[0].runtime.swapBytes = 0;
    observations[0].runtime.peakInferenceMemoryBytes = 20 * 1024 ** 3 + 1;
    expect(buildFirstPassSummary(observations).disqualifiers)
      .toContain('production_memory_max_exceeded');
    expect(buildFirstPassSummary(observations, {
      caseId: 'content-ptbr-outline',
      code: 'request_timeout',
    }).disqualifiers).toContain('candidate_case_failed');
    const incomplete = buildFirstPassSummary(observations.slice(0, 3));
    expect(incomplete.score).toBeNull();
    expect(incomplete.screeningEligible).toBe(false);
    const empty = buildFirstPassSummary([]);
    expect(empty.metrics).toMatchObject({
      averageGeneratedTokensPerSecond: null,
      peakInferenceMemoryBytes: null,
      minimumHostAvailableBytes: null,
      maximumSwapBytes: null,
    });
  });

  it('requires the manifest to pin the installed model digest exactly', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const inventory = { models: [{ name: 'test:latest', digest }] };
    const manifest = { models: [{ id: 'test', role: 'candidate', ollamaTag: 'test:latest', digest, thinkMode: false }] };
    expect(resolveCandidate(manifest, 'test', inventory).observedDigest).toBe(digest);
    expect(() => resolveCandidate({
      models: [{ id: 'test', role: 'candidate', ollamaTag: 'test:latest', digest: null, thinkMode: false }],
    }, 'test', inventory)).toThrow('must pin one exact sha256 digest');
    expect(() => resolveCandidate({
      models: [{ id: 'test', role: 'candidate', ollamaTag: 'test:latest', digest: `sha256:${'b'.repeat(64)}`, thinkMode: false }],
    }, 'test', inventory)).toThrow('differs from the manifest');
  });

  it('rescoring requires current policy evidence and preserves integrity checks', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const runnerSha256 = `sha256:${'b'.repeat(64)}`;
    const manifest = {
      manifestVersion: 'test-v1',
      models: [{
        id: 'test-candidate',
        role: 'candidate',
        ollamaTag: 'test:latest',
        digest,
        thinkMode: false,
      }],
    };
    const testCase = casesDocument.cases.find((row: any) => row.id === 'finance-ptbr-budget-parse');
    const response = JSON.stringify({
      action: 'answer',
      answer: 'Valores extraídos: 2500, 900 e 400 euros.',
      data: { currency: 'EUR', monthlyIncome: 2500, rent: 900, food: 400 },
      language: 'pt-BR',
      skill: 'finance',
    });
    const digestText = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const observation = {
      caseId: testCase.id,
      skillId: testCase.skillId,
      language: testCase.language,
      workload: testCase.workload,
      promptSha256: digestText(testCase.prompt),
      responseSha256: digestText(response),
      response,
      runtime: runtime(),
    };
    const baseArtifact = {
      observations: [observation],
      runnerSha256,
      candidate: {
        id: 'test-candidate',
        ollamaTag: 'test:latest',
        modelDigest: digest,
      },
      failure: null,
    };
    const profilePolicySha256 = digestText(
      readFileSync('src/services/skill-inference-profile-policy.json'),
    );

    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      schemaVersion: 'nexus.local-model-first-pass-artifact.v1',
    }, casesDocument, manifest)).toThrow('source artifact policy is not attested');
    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      schemaVersion: 'nexus.local-model-first-pass-artifact.v2',
      profileVersion: 'nexus-skill-inference-v2',
      profilePolicySha256,
      candidate: { ...baseArtifact.candidate, thinkMode: false },
    }, casesDocument, manifest)).toThrow('source artifact policy is not attested');
    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      schemaVersion: 'nexus.local-model-first-pass-artifact.v3',
      profileVersion: 'nexus-skill-inference-v1',
      profilePolicySha256,
      candidate: { ...baseArtifact.candidate, thinkMode: false },
    }, casesDocument, manifest)).toThrow('source artifact policy is not attested');
    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      schemaVersion: 'nexus.local-model-first-pass-artifact.v3',
      profileVersion: 'nexus-skill-inference-v2',
      profilePolicySha256: `sha256:${'f'.repeat(64)}`,
      candidate: { ...baseArtifact.candidate, thinkMode: false },
    }, casesDocument, manifest)).toThrow('source artifact policy is not attested');

    const current = rescoreFirstPassArtifact({
      ...baseArtifact,
      schemaVersion: 'nexus.local-model-first-pass-artifact.v3',
      profileVersion: 'nexus-skill-inference-v2',
      profilePolicySha256,
      candidate: { ...baseArtifact.candidate, thinkMode: false },
    }, casesDocument, manifest);
    expect(current).toMatchObject({ sourceThinkMode: false, thinkModeAttested: true });
    expect(current.observations[0].evaluation).toMatchObject({ schemaValid: true, skillAccuracy: 1 });
    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      schemaVersion: 'nexus.local-model-first-pass-artifact.v3',
      profileVersion: 'nexus-skill-inference-v2',
      profilePolicySha256,
      candidate: { ...baseArtifact.candidate, thinkMode: 'low' },
    }, casesDocument, manifest)).toThrow('think mode is not attested');
    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      observations: [{ ...observation, responseSha256: `sha256:${'f'.repeat(64)}` }],
      schemaVersion: 'nexus.local-model-first-pass-artifact.v3',
      profileVersion: 'nexus-skill-inference-v2',
      profilePolicySha256,
      candidate: { ...baseArtifact.candidate, thinkMode: false },
    }, casesDocument, manifest)).toThrow('source observation integrity failed');
    expect(() => rescoreFirstPassArtifact({
      ...baseArtifact,
      observations: [{ ...observation, runtime: runtime({ totalDurationMs: Number.NaN }) }],
      schemaVersion: 'nexus.local-model-first-pass-artifact.v3',
      profileVersion: 'nexus-skill-inference-v2',
      profilePolicySha256,
      candidate: { ...baseArtifact.candidate, thinkMode: false },
    }, casesDocument, manifest)).toThrow('source observation integrity failed');
  });

  it('writes artifacts atomically, privately, and never replaces an existing path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-first-pass-'));
    try {
      const output = join(directory, 'artifact.json');
      atomicPrivateWrite(output, Buffer.from('{"ok":true}\n'));
      expect(readFileSync(output, 'utf8')).toBe('{"ok":true}\n');
      expect(existsSync(`${output}.${process.pid}.tmp`)).toBe(false);
      expect(() => atomicPrivateWrite(output, Buffer.from('replacement'))).toThrow('refusing to replace');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
