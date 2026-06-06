// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusChatLanguage } from './chat-answer-contract';
import type { NexusAnswerCompositionMode } from './chat-final-answer-composer';

export const NEXUS_CHAT_ANSWER_CANARY_EXIT_VERSION = 'nexus_chat_answer_canary_exit.v1';

export type NexusAnswerCanaryLanguage = NexusChatLanguage | 'pt-BR' | 'pt-PT';

export interface ChatAnswerCanaryThresholds {
  minAcceptedByLanguage: Partial<Record<NexusAnswerCanaryLanguage, number>>;
  requiredLanguages: NexusAnswerCanaryLanguage[];
  minUnsupportedClaimCatchRate: number;
  maxP95FirstProgressMs: number;
  requireZeroRawPrivateLeaks: boolean;
  maxModelConstrainedShare: number;
}

export const DEFAULT_CHAT_ANSWER_CANARY_THRESHOLDS: ChatAnswerCanaryThresholds = {
  minAcceptedByLanguage: {
    en: 0.9,
    pt: 0.85,
    'pt-BR': 0.85,
    'pt-PT': 0.8,
    mixed: 0.75,
  },
  requiredLanguages: ['en', 'pt-BR', 'pt-PT', 'mixed'],
  minUnsupportedClaimCatchRate: 0.95,
  maxP95FirstProgressMs: 2_000,
  requireZeroRawPrivateLeaks: true,
  maxModelConstrainedShare: 0.35,
};

export interface ChatAnswerCanaryAcceptanceSample {
  sampleId: string;
  language: NexusAnswerCanaryLanguage;
  accepted: boolean;
}

export interface ChatAnswerCanaryUnsupportedClaimSample {
  sampleId: string;
  caughtByDeterministicCritic: boolean;
}

export interface ChatAnswerCanaryProgressSample {
  sampleId: string;
  firstProgressMs: number;
}

export interface ChatAnswerCanaryPrivacySample {
  sampleId: string;
  leakedRawPrivateField: boolean;
}

export interface ChatAnswerCanaryCompositionSample {
  sampleId: string;
  mode: NexusAnswerCompositionMode;
}

export interface ChatAnswerCanaryEvaluationInput {
  acceptanceSamples: ChatAnswerCanaryAcceptanceSample[];
  unsupportedClaimSamples: ChatAnswerCanaryUnsupportedClaimSample[];
  progressSamples: ChatAnswerCanaryProgressSample[];
  privacySamples: ChatAnswerCanaryPrivacySample[];
  compositionSamples: ChatAnswerCanaryCompositionSample[];
  thresholds?: Partial<ChatAnswerCanaryThresholds>;
}

export type ChatAnswerCanaryGateId =
  | 'answer_acceptance_by_language'
  | 'deterministic_critic_unsupported_claims'
  | 'first_progress_p95'
  | 'raw_private_cloud_leaks'
  | 'composer_mode_share';

export interface ChatAnswerCanaryLanguageResult {
  language: NexusAnswerCanaryLanguage;
  accepted: number;
  total: number;
  rate: number;
  threshold: number;
  passed: boolean;
}

export interface ChatAnswerCanaryGateResult {
  gateId: ChatAnswerCanaryGateId;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatAnswerCanaryExitResult {
  version: typeof NEXUS_CHAT_ANSWER_CANARY_EXIT_VERSION;
  passed: boolean;
  gates: ChatAnswerCanaryGateResult[];
  languageResults: ChatAnswerCanaryLanguageResult[];
}

export function evaluateChatAnswerCanaryExit(
  input: ChatAnswerCanaryEvaluationInput,
): ChatAnswerCanaryExitResult {
  const thresholds = mergeThresholds(input.thresholds);
  const languageResults = thresholds.requiredLanguages.map((language) =>
    evaluateLanguageAcceptance(language, input.acceptanceSamples, thresholds),
  );
  const gates: ChatAnswerCanaryGateResult[] = [
    {
      gateId: 'answer_acceptance_by_language',
      passed: languageResults.every((result) => result.passed),
      sampleCount: input.acceptanceSamples.length,
      observed: minObservedLanguageRate(languageResults),
      threshold: minRequiredLanguageThreshold(languageResults),
      reasonCode: languageResults.every((result) => result.total > 0)
        ? undefined
        : 'missing_required_language_samples',
    },
    evaluateUnsupportedClaimGate(input.unsupportedClaimSamples, thresholds),
    evaluateFirstProgressGate(input.progressSamples, thresholds),
    evaluatePrivacyGate(input.privacySamples, thresholds),
    evaluateComposerModeGate(input.compositionSamples, thresholds),
  ];
  return {
    version: NEXUS_CHAT_ANSWER_CANARY_EXIT_VERSION,
    passed: gates.every((gate) => gate.passed),
    gates,
    languageResults,
  };
}

function mergeThresholds(overrides?: Partial<ChatAnswerCanaryThresholds>): ChatAnswerCanaryThresholds {
  return {
    ...DEFAULT_CHAT_ANSWER_CANARY_THRESHOLDS,
    ...overrides,
    minAcceptedByLanguage: {
      ...DEFAULT_CHAT_ANSWER_CANARY_THRESHOLDS.minAcceptedByLanguage,
      ...(overrides?.minAcceptedByLanguage ?? {}),
    },
    requiredLanguages: overrides?.requiredLanguages
      ?? DEFAULT_CHAT_ANSWER_CANARY_THRESHOLDS.requiredLanguages,
  };
}

function evaluateLanguageAcceptance(
  language: NexusAnswerCanaryLanguage,
  samples: ChatAnswerCanaryAcceptanceSample[],
  thresholds: ChatAnswerCanaryThresholds,
): ChatAnswerCanaryLanguageResult {
  const relevant = samples.filter((sample) => sample.language === language);
  const accepted = relevant.filter((sample) => sample.accepted).length;
  const rate = relevant.length > 0 ? accepted / relevant.length : 0;
  const threshold = thresholds.minAcceptedByLanguage[language] ?? 1;
  return {
    language,
    accepted,
    total: relevant.length,
    rate,
    threshold,
    passed: relevant.length > 0 && rate >= threshold,
  };
}

function minObservedLanguageRate(results: ChatAnswerCanaryLanguageResult[]): number {
  if (results.length === 0) return 0;
  return Math.min(...results.map((result) => result.rate));
}

function minRequiredLanguageThreshold(results: ChatAnswerCanaryLanguageResult[]): number {
  if (results.length === 0) return 0;
  return Math.min(...results.map((result) => result.threshold));
}

function evaluateUnsupportedClaimGate(
  samples: ChatAnswerCanaryUnsupportedClaimSample[],
  thresholds: ChatAnswerCanaryThresholds,
): ChatAnswerCanaryGateResult {
  const caught = samples.filter((sample) => sample.caughtByDeterministicCritic).length;
  const observed = samples.length > 0 ? caught / samples.length : 0;
  return {
    gateId: 'deterministic_critic_unsupported_claims',
    passed: samples.length > 0 && observed >= thresholds.minUnsupportedClaimCatchRate,
    sampleCount: samples.length,
    observed,
    threshold: thresholds.minUnsupportedClaimCatchRate,
    reasonCode: samples.length > 0 ? undefined : 'missing_unsupported_claim_samples',
  };
}

function evaluateFirstProgressGate(
  samples: ChatAnswerCanaryProgressSample[],
  thresholds: ChatAnswerCanaryThresholds,
): ChatAnswerCanaryGateResult {
  const observed = percentile(
    samples.map((sample) => sample.firstProgressMs),
    0.95,
  );
  return {
    gateId: 'first_progress_p95',
    passed: samples.length > 0 && observed <= thresholds.maxP95FirstProgressMs,
    sampleCount: samples.length,
    observed,
    threshold: thresholds.maxP95FirstProgressMs,
    reasonCode: samples.length > 0 ? undefined : 'missing_progress_samples',
  };
}

function evaluatePrivacyGate(
  samples: ChatAnswerCanaryPrivacySample[],
  thresholds: ChatAnswerCanaryThresholds,
): ChatAnswerCanaryGateResult {
  const leakCount = samples.filter((sample) => sample.leakedRawPrivateField).length;
  return {
    gateId: 'raw_private_cloud_leaks',
    passed: samples.length > 0 && (!thresholds.requireZeroRawPrivateLeaks || leakCount === 0),
    sampleCount: samples.length,
    observed: leakCount,
    threshold: 0,
    reasonCode: samples.length > 0 ? undefined : 'missing_privacy_samples',
  };
}

function evaluateComposerModeGate(
  samples: ChatAnswerCanaryCompositionSample[],
  thresholds: ChatAnswerCanaryThresholds,
): ChatAnswerCanaryGateResult {
  const modelConstrained = samples.filter((sample) => sample.mode === 'model_constrained').length;
  const observed = samples.length > 0 ? modelConstrained / samples.length : 0;
  return {
    gateId: 'composer_mode_share',
    passed: samples.length > 0 && observed <= thresholds.maxModelConstrainedShare,
    sampleCount: samples.length,
    observed,
    threshold: thresholds.maxModelConstrainedShare,
    reasonCode: samples.length > 0 ? undefined : 'missing_composition_samples',
  };
}

function percentile(values: number[], quantile: number): number {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}
