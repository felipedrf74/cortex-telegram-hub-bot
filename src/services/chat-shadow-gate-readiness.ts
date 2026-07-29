// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusChatLanguage } from './chat-answer-contract';
import { createHash } from 'crypto';

export const NEXUS_CHAT_SHADOW_GATE_READINESS_VERSION = 'nexus_chat_shadow_gate_readiness.v1';

export type NexusChatShadowLanguage = NexusChatLanguage | 'pt-BR' | 'pt-PT';

export type ChatShadowIdentifierKind = 'hmac' | 'raw' | 'none';

export interface ChatShadowGateThresholds {
  minRows: number;
  minSchemaValidity: number;
  candidateK: number;
  minRecallByLanguage: Partial<Record<NexusChatShadowLanguage, number>>;
  requiredLanguages: NexusChatShadowLanguage[];
  requireHmacIdentifiers: boolean;
  requireZeroRawMessageText: boolean;
  requireCandidateEvidenceBinding: boolean;
}

export const DEFAULT_CHAT_SHADOW_GATE_THRESHOLDS: ChatShadowGateThresholds = {
  minRows: 50,
  minSchemaValidity: 0.99,
  candidateK: 8,
  minRecallByLanguage: {
    en: 0.98,
    pt: 0.97,
    'pt-BR': 0.97,
    'pt-PT': 0.92,
    mixed: 0.9,
  },
  requiredLanguages: ['en', 'pt-BR', 'pt-PT', 'mixed'],
  requireHmacIdentifiers: true,
  requireZeroRawMessageText: true,
  requireCandidateEvidenceBinding: true,
};

export interface ChatShadowGateSample {
  sampleId: string;
  language: NexusChatShadowLanguage;
  candidateCapabilities: string[];
  finalCapabilityId?: string;
  schemaValidAfterRepair: boolean;
  messageIdentifierKind: ChatShadowIdentifierKind;
  storedRawMessageText: boolean;
  unsafeRawFieldCount?: number;
  candidateEvidenceHash?: string;
}

export interface ChatShadowGateEvaluationInput {
  samples: ChatShadowGateSample[];
  thresholds?: Partial<ChatShadowGateThresholds>;
}

export type ChatShadowGateId =
  | 'shadow_row_floor'
  | 'schema_validity_after_repair'
  | 'recall_at_k_by_language'
  | 'shadow_storage_privacy'
  | 'shadow_candidate_evidence_binding';

export interface ChatShadowLanguageRecallResult {
  language: NexusChatShadowLanguage;
  recalled: number;
  total: number;
  rate: number;
  threshold: number;
  passed: boolean;
}

export interface ChatShadowGateResult {
  gateId: ChatShadowGateId;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatShadowGateReadinessResult {
  version: typeof NEXUS_CHAT_SHADOW_GATE_READINESS_VERSION;
  passed: boolean;
  gates: ChatShadowGateResult[];
  languageResults: ChatShadowLanguageRecallResult[];
}

export function evaluateChatShadowGateReadiness(
  input: ChatShadowGateEvaluationInput,
): ChatShadowGateReadinessResult {
  const thresholds = mergeThresholds(input.thresholds);
  const languageResults = thresholds.requiredLanguages.map((language) =>
    evaluateLanguageRecall(language, input.samples, thresholds),
  );
  const gates: ChatShadowGateResult[] = [
    evaluateRowFloor(input.samples, thresholds),
    evaluateSchemaValidity(input.samples, thresholds),
    {
      gateId: 'recall_at_k_by_language',
      passed: languageResults.every((result) => result.passed),
      sampleCount: input.samples.length,
      observed: minObservedLanguageRate(languageResults),
      threshold: minRequiredLanguageThreshold(languageResults),
      reasonCode: languageResults.every((result) => result.total > 0)
        ? undefined
        : 'missing_required_language_samples',
    },
    evaluateShadowStoragePrivacy(input.samples, thresholds),
    evaluateCandidateEvidenceBinding(input.samples, thresholds),
  ];
  return {
    version: NEXUS_CHAT_SHADOW_GATE_READINESS_VERSION,
    passed: gates.every((gate) => gate.passed),
    gates,
    languageResults,
  };
}

function mergeThresholds(overrides?: Partial<ChatShadowGateThresholds>): ChatShadowGateThresholds {
  return {
    ...DEFAULT_CHAT_SHADOW_GATE_THRESHOLDS,
    ...overrides,
    minRecallByLanguage: {
      ...DEFAULT_CHAT_SHADOW_GATE_THRESHOLDS.minRecallByLanguage,
      ...(overrides?.minRecallByLanguage ?? {}),
    },
    requiredLanguages: overrides?.requiredLanguages
      ?? DEFAULT_CHAT_SHADOW_GATE_THRESHOLDS.requiredLanguages,
  };
}

function evaluateRowFloor(
  samples: ChatShadowGateSample[],
  thresholds: ChatShadowGateThresholds,
): ChatShadowGateResult {
  return {
    gateId: 'shadow_row_floor',
    passed: samples.length >= thresholds.minRows,
    sampleCount: samples.length,
    observed: samples.length,
    threshold: thresholds.minRows,
    reasonCode: samples.length >= thresholds.minRows ? undefined : 'insufficient_shadow_rows',
  };
}

function evaluateSchemaValidity(
  samples: ChatShadowGateSample[],
  thresholds: ChatShadowGateThresholds,
): ChatShadowGateResult {
  const valid = samples.filter((sample) => sample.schemaValidAfterRepair).length;
  const observed = samples.length > 0 ? valid / samples.length : 0;
  return {
    gateId: 'schema_validity_after_repair',
    passed: samples.length > 0 && observed >= thresholds.minSchemaValidity,
    sampleCount: samples.length,
    observed,
    threshold: thresholds.minSchemaValidity,
    reasonCode: samples.length > 0 ? undefined : 'missing_schema_samples',
  };
}

function evaluateLanguageRecall(
  language: NexusChatShadowLanguage,
  samples: ChatShadowGateSample[],
  thresholds: ChatShadowGateThresholds,
): ChatShadowLanguageRecallResult {
  const relevant = samples.filter((sample) => sample.language === language);
  const recalled = relevant.filter((sample) => {
    if (!sample.finalCapabilityId) return false;
    return sample.candidateCapabilities.slice(0, thresholds.candidateK).includes(sample.finalCapabilityId);
  }).length;
  const rate = relevant.length > 0 ? recalled / relevant.length : 0;
  const threshold = thresholds.minRecallByLanguage[language] ?? 1;
  return {
    language,
    recalled,
    total: relevant.length,
    rate,
    threshold,
    passed: relevant.length > 0 && rate >= threshold,
  };
}

function evaluateShadowStoragePrivacy(
  samples: ChatShadowGateSample[],
  thresholds: ChatShadowGateThresholds,
): ChatShadowGateResult {
  const violations = samples.filter((sample) => {
    if (thresholds.requireZeroRawMessageText && sample.storedRawMessageText) return true;
    if (thresholds.requireZeroRawMessageText && (sample.unsafeRawFieldCount ?? 0) > 0) return true;
    if (thresholds.requireHmacIdentifiers && sample.messageIdentifierKind !== 'hmac') return true;
    return false;
  }).length;
  return {
    gateId: 'shadow_storage_privacy',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0 ? undefined : 'missing_shadow_privacy_samples',
  };
}

function evaluateCandidateEvidenceBinding(
  samples: ChatShadowGateSample[],
  thresholds: ChatShadowGateThresholds,
): ChatShadowGateResult {
  const violations = thresholds.requireCandidateEvidenceBinding
    ? samples.filter((sample) => sample.candidateEvidenceHash !== buildChatShadowSampleEvidenceHash(sample)).length
    : 0;
  return {
    gateId: 'shadow_candidate_evidence_binding',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0 ? undefined : 'missing_shadow_candidate_evidence_samples',
  };
}

export function buildChatShadowSampleEvidenceHash(sample: ChatShadowGateSample): string {
  const payload = {
    sampleId: sample.sampleId,
    language: sample.language,
    candidateCapabilities: sample.candidateCapabilities,
    finalCapabilityId: sample.finalCapabilityId ?? null,
    schemaValidAfterRepair: sample.schemaValidAfterRepair,
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function countUnsafeChatShadowRawFields(value: unknown): number {
  return countUnsafeRawFields(value, []);
}

function countUnsafeRawFields(value: unknown, path: string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item, index) => sum + countUnsafeRawFields(item, [...path, String(index)]), 0);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce((sum, [key, child]) =>
      sum + countUnsafeRawFields(child, [...path, key]), 0);
  }
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const keyPath = path.join('.');
  const keyName = path[path.length - 1] ?? '';
  if (SAFE_METADATA_FIELD_RE.test(keyName)) return 0;
  if (!RAW_FIELD_KEY_RE.test(keyPath)) return 0;
  return SAFE_SHADOW_TOKEN_RE.test(trimmed) ? 0 : 1;
}

const RAW_FIELD_KEY_RE = /(raw|message|prompt|history|recentTurns|body|content|text|title|subject)/i;
const SAFE_METADATA_FIELD_RE = /(?:IdentifierKind|Kind|Count|Ids?|Hash|Hashes|Fingerprint|Fingerprints|Capabilities?|CapabilityId|ReasonCode|Version|Policy)$/i;
const SAFE_SHADOW_TOKEN_RE = /^(?:hmac:[a-z0-9_-]+:)?[a-f0-9]{64}$|^[a-z][a-z0-9_.-]{1,80}$/i;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function minObservedLanguageRate(results: ChatShadowLanguageRecallResult[]): number {
  if (results.length === 0) return 0;
  return Math.min(...results.map((result) => result.rate));
}

function minRequiredLanguageThreshold(results: ChatShadowLanguageRecallResult[]): number {
  if (results.length === 0) return 0;
  return Math.min(...results.map((result) => result.threshold));
}
