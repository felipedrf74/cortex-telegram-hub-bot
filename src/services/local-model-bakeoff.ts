// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getLocalModelManifest } from './ollama-model-policy';
import { SKILL_INFERENCE_PROFILE_VERSION, type SkillInferenceSkill } from './skill-inference-profiles';
import type { LocalModelManifest } from './ollama-model-policy';

const REQUIRED_SKILLS: readonly SkillInferenceSkill[] = [
  'secretary', 'content', 'training', 'triathlon', 'cooking', 'finance',
];
const REQUIRED_LANGUAGES = ['pt-BR', 'pt-PT', 'en', 'mixed'] as const;

export interface LocalModelBakeoffObservation {
  candidateId: string;
  modelDigest: string;
  profileVersion: string;
  caseId: string;
  skillId: SkillInferenceSkill;
  workload: 'ordinary' | 'content_script' | 'structured_tool_plan';
  language: 'pt-BR' | 'pt-PT' | 'en' | 'mixed';
  skillAccuracy: number;
  contentQuality: number;
  structuredCorrectness: number;
  languageQuality: number;
  runtimePerformance: number;
  cloudCriticalQualityDeltaPercent: number;
  schemaValid: boolean;
  safetyFailure: boolean;
  tenantIsolationFailure: boolean;
  firstTokenMs: number;
  totalDurationMs: number;
  generatedTokensPerSecond: number;
  peakInferenceMemoryBytes: number;
  minimumHostAvailableBytes: number;
  swapBytes: number;
  scriptWordCount?: number;
  scriptComplete?: boolean;
  sourceConsistent?: boolean;
}

export interface LocalModelBakeoffResult {
  candidateId: string;
  ollamaTag: string;
  observedModelDigest: string | null;
  profileVersion: string | null;
  observationCount: number;
  uniqueCaseCount: number;
  scriptCount: number;
  languageCoverage: string[];
  score: number;
  eligible: boolean;
  disqualifiers: string[];
  metrics: {
    skillAccuracyPercent: number;
    contentQualityPercent: number;
    structuredCorrectnessPercent: number;
    languageQualityPercent: number;
    runtimePerformancePercent: number;
    structuredSchemaCount: number;
    schemaValidityPercent: number;
    averageScriptTokensPerSecond: number | null;
    scriptOutputContractPassPercent: number | null;
    p95FirstTokenMs: number | null;
    p95TotalDurationMs: number | null;
    ordinaryChatP95FirstTokenMs: number | null;
    ordinaryChatP95TotalDurationMs: number | null;
    scriptP95TotalDurationMs: number | null;
    peakInferenceMemoryBytes: number;
    minimumHostAvailableBytes: number;
    maximumSwapBytes: number;
    worstCloudCriticalQualityDeltaPercent: number;
  };
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function percent(value: number): number {
  return Number((value * 100).toFixed(2));
}

function boundedScore(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
}

export function buildLocalModelBakeoff(
  observations: LocalModelBakeoffObservation[],
  manifest: LocalModelManifest = getLocalModelManifest({ fresh: true }),
): LocalModelBakeoffResult[] {
  const byCandidate = new Map<string, LocalModelBakeoffObservation[]>();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') {
      throw new Error('Bakeoff observation must be an object');
    }
    if (typeof observation.candidateId !== 'string'
        || !manifest.models.some((candidate) => candidate.id === observation.candidateId)) {
      throw new Error(`Observation references unknown manifest candidate ${observation.candidateId}`);
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(observation.modelDigest)) {
      throw new Error('Bakeoff observation modelDigest must be a normalized SHA-256 digest');
    }
    if (typeof observation.profileVersion !== 'string' || !observation.profileVersion.trim()) {
      throw new Error('Bakeoff observation profileVersion is required');
    }
    for (const field of [
      'skillAccuracy',
      'contentQuality',
      'structuredCorrectness',
      'languageQuality',
      'runtimePerformance',
    ] as const) boundedScore(observation[field], field);
    if (typeof observation.caseId !== 'string' || !observation.caseId.trim()) {
      throw new Error('Bakeoff observation caseId is required');
    }
    if (!['ordinary', 'content_script', 'structured_tool_plan'].includes(observation.workload)) {
      throw new Error(`Bakeoff observation has unsupported workload ${String(observation.workload)}`);
    }
    if (!REQUIRED_LANGUAGES.includes(observation.language)) {
      throw new Error(`Bakeoff observation has unsupported language ${String(observation.language)}`);
    }
    if (!REQUIRED_SKILLS.includes(observation.skillId)) {
      throw new Error(`Bakeoff observation has unsupported skill ${String(observation.skillId)}`);
    }
    if (typeof observation.schemaValid !== 'boolean'
        || typeof observation.safetyFailure !== 'boolean'
        || typeof observation.tenantIsolationFailure !== 'boolean') {
      throw new Error('Bakeoff schema and safety observations must be boolean');
    }
    for (const field of [
      'cloudCriticalQualityDeltaPercent',
      'firstTokenMs',
      'totalDurationMs',
      'generatedTokensPerSecond',
      'peakInferenceMemoryBytes',
      'minimumHostAvailableBytes',
      'swapBytes',
    ] as const) {
      if (!Number.isFinite(observation[field])
          || (field !== 'cloudCriticalQualityDeltaPercent' && observation[field] < 0)) {
        throw new Error(`${field} must be finite${field === 'cloudCriticalQualityDeltaPercent' ? '' : ' and non-negative'}`);
      }
    }
    if (observation.workload === 'content_script') {
      if (!Number.isSafeInteger(observation.scriptWordCount)
          || Number(observation.scriptWordCount) < 0
          || typeof observation.scriptComplete !== 'boolean'
          || typeof observation.sourceConsistent !== 'boolean') {
        throw new Error('Long-form script observations require word count, completeness, and source consistency');
      }
    }
    byCandidate.set(observation.candidateId, [
      ...(byCandidate.get(observation.candidateId) ?? []),
      observation,
    ]);
  }

  return manifest.models.map((candidate): LocalModelBakeoffResult => {
    const rows = byCandidate.get(candidate.id) ?? [];
    const scripts = rows.filter((row) => row.workload === 'content_script');
    const ordinaryChat = rows.filter((row) => row.workload === 'ordinary');
    const structuredSchemaRows = rows.filter((row) => row.workload === 'structured_tool_plan');
    const uniqueCases = new Set(rows.map((row) => row.caseId));
    const uniqueScripts = new Set(scripts.map((row) => row.caseId));
    const observedModelDigests = new Set(rows.map((row) => row.modelDigest));
    const observedProfileVersions = new Set(rows.map((row) => row.profileVersion));
    const skill = mean(rows.map((row) => row.skillAccuracy));
    const content = mean(rows.map((row) => row.contentQuality));
    const structured = mean(rows.map((row) => row.structuredCorrectness));
    const language = mean(rows.map((row) => row.languageQuality));
    const runtime = mean(rows.map((row) => row.runtimePerformance));
    const schemaValidity = structuredSchemaRows.length > 0
      ? structuredSchemaRows.filter((row) => row.schemaValid).length / structuredSchemaRows.length
      : 0;
    const scriptTps = scripts.length > 0
      ? mean(scripts.map((row) => row.generatedTokensPerSecond))
      : null;
    const scriptContractPasses = scripts.filter((row) => (
      row.scriptComplete === true
      && row.sourceConsistent === true
      && Number(row.scriptWordCount) >= 1_900
      && Number(row.scriptWordCount) <= 2_400
    ));
    const ordinaryChatP95FirstTokenMs = ordinaryChat.length > 0
      ? p95(ordinaryChat.map((row) => row.firstTokenMs))
      : null;
    const ordinaryChatP95TotalDurationMs = ordinaryChat.length > 0
      ? p95(ordinaryChat.map((row) => row.totalDurationMs))
      : null;
    const scriptP95TotalDurationMs = scripts.length > 0
      ? p95(scripts.map((row) => row.totalDurationMs))
      : null;
    const peakMemory = Math.max(0, ...rows.map((row) => row.peakInferenceMemoryBytes));
    const minimumHostAvailable = rows.length > 0
      ? Math.min(...rows.map((row) => row.minimumHostAvailableBytes))
      : 0;
    const maximumSwap = Math.max(0, ...rows.map((row) => row.swapBytes));
    const worstCloudDelta = rows.length > 0
      ? Math.min(...rows.map((row) => row.cloudCriticalQualityDeltaPercent))
      : -100;
    const disqualifiers: string[] = [];
    if (observedModelDigests.size !== 1) disqualifiers.push('model_digest_missing_or_changed_during_bakeoff');
    if (candidate.digest !== null && !observedModelDigests.has(candidate.digest)) {
      disqualifiers.push('model_digest_does_not_match_manifest_candidate');
    }
    if (observedProfileVersions.size !== 1
        || !observedProfileVersions.has(SKILL_INFERENCE_PROFILE_VERSION)) {
      disqualifiers.push('skill_profile_version_missing_or_changed_during_bakeoff');
    }
    if (uniqueCases.size < 600) disqualifiers.push('fewer_than_600_unique_nexus_cases');
    if (uniqueCases.size !== rows.length) disqualifiers.push('duplicate_case_observations');
    if (uniqueScripts.size < 30) disqualifiers.push('fewer_than_30_unique_long_form_scripts');
    if (scripts.filter((row) => row.language === 'pt-BR').length < 15
        || scripts.filter((row) => row.language === 'en').length < 15) {
      disqualifiers.push('long_form_language_split_missing');
    }
    if (REQUIRED_SKILLS.some((skillId) => !rows.some((row) => row.skillId === skillId))) {
      disqualifiers.push('six_skill_coverage_missing');
    }
    if (REQUIRED_LANGUAGES.some((languageId) => !rows.some((row) => row.language === languageId))) {
      disqualifiers.push('required_language_coverage_missing');
    }
    if (structuredSchemaRows.length < 100) disqualifiers.push('fewer_than_100_structured_schema_cases');
    if (schemaValidity < 0.99) disqualifiers.push('schema_validity_below_99_percent');
    if (worstCloudDelta < -5) disqualifiers.push('critical_quality_more_than_5_percent_below_cloud');
    if (rows.some((row) => row.safetyFailure || row.tenantIsolationFailure)) {
      disqualifiers.push('safety_or_tenant_isolation_failure');
    }
    if (scriptTps == null || scriptTps < 4) disqualifiers.push('script_throughput_below_4_tokens_per_second');
    if (scripts.length === 0 || scriptContractPasses.length !== scripts.length) {
      disqualifiers.push('long_form_script_output_contract_failed');
    }
    if (ordinaryChatP95FirstTokenMs == null || ordinaryChatP95FirstTokenMs > 12_000) {
      disqualifiers.push('ordinary_chat_first_token_p95_above_12_seconds');
    }
    if (ordinaryChatP95TotalDurationMs == null || ordinaryChatP95TotalDurationMs > 45_000) {
      disqualifiers.push('ordinary_chat_total_p95_above_45_seconds');
    }
    if (scriptP95TotalDurationMs == null || scriptP95TotalDurationMs > 12 * 60 * 1_000) {
      disqualifiers.push('long_form_script_p95_above_12_minutes');
    }
    if (peakMemory > manifest.productionEnvelope.memoryMaxBytes) disqualifiers.push('production_memory_max_exceeded');
    if (minimumHostAvailable < (manifest.productionEnvelope.minimumHostAvailableBytes ?? 0)) {
      disqualifiers.push('minimum_host_headroom_not_preserved');
    }
    if (maximumSwap > manifest.productionEnvelope.memorySwapMaxBytes) disqualifiers.push('swap_detected');
    const score = percent(
      skill * 0.35
      + content * 0.30
      + structured * 0.15
      + language * 0.10
      + runtime * 0.10,
    );
    return {
      candidateId: candidate.id,
      ollamaTag: candidate.ollamaTag,
      observedModelDigest: observedModelDigests.size === 1 ? [...observedModelDigests][0]! : null,
      profileVersion: observedProfileVersions.size === 1 ? [...observedProfileVersions][0]! : null,
      observationCount: rows.length,
      uniqueCaseCount: uniqueCases.size,
      scriptCount: scripts.length,
      languageCoverage: [...new Set(rows.map((row) => row.language))].sort(),
      score,
      eligible: disqualifiers.length === 0,
      disqualifiers,
      metrics: {
        skillAccuracyPercent: percent(skill),
        contentQualityPercent: percent(content),
        structuredCorrectnessPercent: percent(structured),
        languageQualityPercent: percent(language),
        runtimePerformancePercent: percent(runtime),
        structuredSchemaCount: structuredSchemaRows.length,
        schemaValidityPercent: percent(schemaValidity),
        averageScriptTokensPerSecond: scriptTps == null ? null : Number(scriptTps.toFixed(2)),
        scriptOutputContractPassPercent: scripts.length === 0
          ? null
          : percent(scriptContractPasses.length / scripts.length),
        p95FirstTokenMs: p95(rows.map((row) => row.firstTokenMs)),
        p95TotalDurationMs: p95(rows.map((row) => row.totalDurationMs)),
        ordinaryChatP95FirstTokenMs,
        ordinaryChatP95TotalDurationMs,
        scriptP95TotalDurationMs,
        peakInferenceMemoryBytes: peakMemory,
        minimumHostAvailableBytes: minimumHostAvailable,
        maximumSwapBytes: maximumSwap,
        worstCloudCriticalQualityDeltaPercent: worstCloudDelta,
      },
    };
  }).sort((left, right) => (
    Number(right.eligible) - Number(left.eligible)
    || right.score - left.score
    || (left.metrics.p95TotalDurationMs ?? Number.POSITIVE_INFINITY)
      - (right.metrics.p95TotalDurationMs ?? Number.POSITIVE_INFINITY)
  ));
}
