// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatV2LegacyRetirementEvidenceSource } from './chat-legacy-retirement-evidence';

export const CHAT_V2_LEGACY_PARITY_LABEL_VERSION = 'chat_v2_legacy_parity_label.v1';
export const CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION = 'chat_v2_legacy_parity_observation.v1';
export const CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION = 'chat_v2_legacy_parity_review_rubric.v2';

export type ChatV2LegacyParityEvaluator = 'codex' | 'claude' | 'manual' | 'runtime_tool';
export type ChatV2LegacyParitySafetyVerdict =
  | 'equivalent'
  | 'match'
  | 'chatv2_better'
  | 'equivalent_different'
  | 'chatv2_worse'
  | 'chatv2_worse_quality'
  | 'chatv2_worse_safety'
  | 'not_comparable_degraded'
  | 'not_reviewed';
export type ChatV2LegacyParitySafetyDimension =
  | 'answer_quality'
  | 'action_card_contract'
  | 'success_claim'
  | 'write_firewall'
  | 'confirmation'
  | 'verification'
  | 'cloud_privacy'
  | 'web_query_privacy'
  | 'research_grounding'
  | 'health_adjacent_safety'
  | 'locale'
  | 'response_contract'
  | 'tenant_scope'
  | 'none';

export interface ChatV2LegacyParityLabel {
  schemaVersion: typeof CHAT_V2_LEGACY_PARITY_LABEL_VERSION;
  routeId: string;
  replaced: boolean;
  tested: boolean;
  sampleCount: number;
  matchingCount: number;
  oldOwner: string;
  replacement: string;
  evaluator: ChatV2LegacyParityEvaluator;
  evidenceSource?: ChatV2LegacyRetirementEvidenceSource;
  peerReviewSignoffHash?: string;
  safetyRegressionCount?: number;
  qualityRegressionCount?: number;
  degradedNotComparableCount?: number;
  reviewRubricVersion?: typeof CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION;
}

export interface ChatV2LegacyParityObservation {
  schemaVersion: typeof CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION;
  routeId: string;
  sampleHmac: string;
  matched: boolean;
  tested: boolean;
  oldOwner: string;
  replacement: string;
  evaluator: ChatV2LegacyParityEvaluator;
  evidenceSource?: ChatV2LegacyRetirementEvidenceSource;
  peerReviewSignoffHash?: string;
  reasonCode?: string;
  safetyVerdict?: ChatV2LegacyParitySafetyVerdict;
  safetyDimension?: ChatV2LegacyParitySafetyDimension;
  reviewRubricVersion?: typeof CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION;
}

export interface ChatV2LegacyParityEvidenceInput {
  requestId: string;
  routeId: string;
  replaced: boolean;
  tested: boolean;
  shadowParityRate: number;
  sampleCount: number;
  evidenceSource: ChatV2LegacyRetirementEvidenceSource;
  safeMetadata: Record<string, unknown>;
}

export type ChatV2LegacyParityLabelValidation =
  | { ok: true; label: ChatV2LegacyParityLabel }
  | { ok: false; reason: string };

export type ChatV2LegacyParityObservationValidation =
  | { ok: true; observation: ChatV2LegacyParityObservation }
  | { ok: false; reason: string };

export interface ChatV2LegacyParityObservationAggregate {
  routeId: string;
  label: ChatV2LegacyParityLabel;
  blockedReason?: string;
}

const ROUTE_ID_RE = /^[a-z0-9_]{1,120}$/;
const HMAC_SAMPLE_RE = /^hmac:[a-z0-9_-]+:[a-f0-9]{64}$/i;
const SAFE_OWNER_RE = /^[a-z0-9_.:/ -]{1,120}$/i;
const SAFE_REASON_RE = /^[a-z0-9_:-]{1,120}$/i;
const PEER_REVIEW_SIGNOFF_RE = /^[a-f0-9]{64}$/i;
const VALID_EVALUATORS = new Set<ChatV2LegacyParityEvaluator>(['codex', 'claude', 'manual', 'runtime_tool']);
const VALID_SOURCES = new Set<ChatV2LegacyRetirementEvidenceSource>(['runtime_route', 'local_sandbox_seed']);
const VALID_SAFETY_VERDICTS = new Set<ChatV2LegacyParitySafetyVerdict>([
  'equivalent',
  'match',
  'chatv2_better',
  'equivalent_different',
  'chatv2_worse',
  'chatv2_worse_quality',
  'chatv2_worse_safety',
  'not_comparable_degraded',
  'not_reviewed',
]);
const VALID_SAFETY_DIMENSIONS = new Set<ChatV2LegacyParitySafetyDimension>([
  'answer_quality',
  'action_card_contract',
  'success_claim',
  'write_firewall',
  'confirmation',
  'verification',
  'cloud_privacy',
  'web_query_privacy',
  'research_grounding',
  'health_adjacent_safety',
  'locale',
  'response_contract',
  'tenant_scope',
  'none',
]);
const UNSAFE_FIELD_KEY_RE = /raw|message|prompt|response|text|body|content|transcript|calendar|email|finance|health|tasktitle|title/i;

export function normalizeChatV2LegacyParityOwnerLabel(value: string): string {
  const normalized = value
    .replace(/[^0-9A-Za-z_.:/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return normalized || 'unknown';
}

export function validateChatV2LegacyParityLabel(value: unknown): ChatV2LegacyParityLabelValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'label_not_object' };
  }
  const record = value as Record<string, unknown>;
  const unsafeKey = findUnsafeFieldKey(record);
  if (unsafeKey) return { ok: false, reason: `unsafe_field_key:${unsafeKey}` };
  if (record.schemaVersion !== CHAT_V2_LEGACY_PARITY_LABEL_VERSION) {
    return { ok: false, reason: 'invalid_schema_version' };
  }
  if (typeof record.routeId !== 'string' || !ROUTE_ID_RE.test(record.routeId)) {
    return { ok: false, reason: 'invalid_route_id' };
  }
  if (typeof record.replaced !== 'boolean') return { ok: false, reason: 'invalid_replaced' };
  if (typeof record.tested !== 'boolean') return { ok: false, reason: 'invalid_tested' };
  const sampleCount = integerFromUnknown(record.sampleCount);
  if (sampleCount == null || sampleCount < 0) return { ok: false, reason: 'invalid_sample_count' };
  const matchingCount = integerFromUnknown(record.matchingCount);
  if (matchingCount == null || matchingCount < 0 || matchingCount > sampleCount) {
    return { ok: false, reason: 'invalid_matching_count' };
  }
  if (typeof record.oldOwner !== 'string' || !SAFE_OWNER_RE.test(record.oldOwner)) {
    return { ok: false, reason: 'invalid_old_owner' };
  }
  if (typeof record.replacement !== 'string' || !SAFE_OWNER_RE.test(record.replacement)) {
    return { ok: false, reason: 'invalid_replacement' };
  }
  if (typeof record.evaluator !== 'string' || !VALID_EVALUATORS.has(record.evaluator as ChatV2LegacyParityEvaluator)) {
    return { ok: false, reason: 'invalid_evaluator' };
  }
  const evaluator = record.evaluator as ChatV2LegacyParityEvaluator;
  const evidenceSource = (record.evidenceSource as ChatV2LegacyRetirementEvidenceSource | undefined) ?? 'runtime_route';
  let safetyRegressionCount: number | undefined;
  let qualityRegressionCount: number | undefined;
  let degradedNotComparableCount: number | undefined;
  if (record.safetyRegressionCount != null) {
    const parsedSafetyRegressionCount = integerFromUnknown(record.safetyRegressionCount);
    if (parsedSafetyRegressionCount == null || parsedSafetyRegressionCount < 0 || parsedSafetyRegressionCount > sampleCount) {
      return { ok: false, reason: 'invalid_safety_regression_count' };
    }
    safetyRegressionCount = parsedSafetyRegressionCount;
    if (safetyRegressionCount > 0) {
      return { ok: false, reason: 'safety_regression_count_nonzero' };
    }
  }
  if ((evaluator === 'claude' || evaluator === 'manual') && evidenceSource === 'runtime_route') {
    if (safetyRegressionCount == null) {
      return { ok: false, reason: 'missing_safety_regression_count' };
    }
    const parsedQualityRegressionCount = validateZeroCount(record.qualityRegressionCount, sampleCount);
    if (parsedQualityRegressionCount.kind === 'missing') return { ok: false, reason: 'missing_quality_regression_count' };
    if (parsedQualityRegressionCount.kind === 'invalid') return { ok: false, reason: 'invalid_quality_regression_count' };
    qualityRegressionCount = parsedQualityRegressionCount.value;
    if (qualityRegressionCount > 0) return { ok: false, reason: 'quality_regression_count_nonzero' };
    const parsedDegradedNotComparableCount = validateZeroCount(record.degradedNotComparableCount, sampleCount);
    if (parsedDegradedNotComparableCount.kind === 'missing') return { ok: false, reason: 'missing_degraded_not_comparable_count' };
    if (parsedDegradedNotComparableCount.kind === 'invalid') return { ok: false, reason: 'invalid_degraded_not_comparable_count' };
    degradedNotComparableCount = parsedDegradedNotComparableCount.value;
    if (degradedNotComparableCount > 0) return { ok: false, reason: 'degraded_not_comparable_count_nonzero' };
    if (record.reviewRubricVersion !== CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION) {
      return { ok: false, reason: 'missing_review_rubric_version' };
    }
  }
  if ((evaluator === 'claude' || evaluator === 'manual')
    && (typeof record.peerReviewSignoffHash !== 'string' || !PEER_REVIEW_SIGNOFF_RE.test(record.peerReviewSignoffHash))) {
    return { ok: false, reason: 'missing_peer_review_signoff_hash' };
  }
  if (record.peerReviewSignoffHash != null
    && (typeof record.peerReviewSignoffHash !== 'string' || !PEER_REVIEW_SIGNOFF_RE.test(record.peerReviewSignoffHash))) {
    return { ok: false, reason: 'invalid_peer_review_signoff_hash' };
  }
  if (record.evidenceSource != null
    && (typeof record.evidenceSource !== 'string' || !VALID_SOURCES.has(record.evidenceSource as ChatV2LegacyRetirementEvidenceSource))) {
    return { ok: false, reason: 'invalid_evidence_source' };
  }
  return {
    ok: true,
    label: {
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: record.routeId,
      replaced: record.replaced,
      tested: record.tested,
      sampleCount,
      matchingCount,
      oldOwner: record.oldOwner,
      replacement: record.replacement,
      evaluator,
      evidenceSource,
      peerReviewSignoffHash: typeof record.peerReviewSignoffHash === 'string' ? record.peerReviewSignoffHash : undefined,
      safetyRegressionCount,
      qualityRegressionCount,
      degradedNotComparableCount,
      reviewRubricVersion: record.reviewRubricVersion === CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION
        ? CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION
        : undefined,
    },
  };
}

export function validateChatV2LegacyParityObservation(value: unknown): ChatV2LegacyParityObservationValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'observation_not_object' };
  }
  const record = value as Record<string, unknown>;
  const unsafeKey = findUnsafeFieldKey(record);
  if (unsafeKey) return { ok: false, reason: `unsafe_field_key:${unsafeKey}` };
  if (record.schemaVersion !== CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION) {
    return { ok: false, reason: 'invalid_schema_version' };
  }
  if (typeof record.routeId !== 'string' || !ROUTE_ID_RE.test(record.routeId)) {
    return { ok: false, reason: 'invalid_route_id' };
  }
  if (typeof record.sampleHmac !== 'string' || !HMAC_SAMPLE_RE.test(record.sampleHmac)) {
    return { ok: false, reason: 'invalid_sample_hmac' };
  }
  if (typeof record.matched !== 'boolean') return { ok: false, reason: 'invalid_matched' };
  if (typeof record.tested !== 'boolean') return { ok: false, reason: 'invalid_tested' };
  if (typeof record.oldOwner !== 'string' || !SAFE_OWNER_RE.test(record.oldOwner)) {
    return { ok: false, reason: 'invalid_old_owner' };
  }
  if (typeof record.replacement !== 'string' || !SAFE_OWNER_RE.test(record.replacement)) {
    return { ok: false, reason: 'invalid_replacement' };
  }
  if (typeof record.evaluator !== 'string' || !VALID_EVALUATORS.has(record.evaluator as ChatV2LegacyParityEvaluator)) {
    return { ok: false, reason: 'invalid_evaluator' };
  }
  if (record.peerReviewSignoffHash != null
    && (typeof record.peerReviewSignoffHash !== 'string' || !PEER_REVIEW_SIGNOFF_RE.test(record.peerReviewSignoffHash))) {
    return { ok: false, reason: 'invalid_peer_review_signoff_hash' };
  }
  if (record.evidenceSource != null
    && (typeof record.evidenceSource !== 'string' || !VALID_SOURCES.has(record.evidenceSource as ChatV2LegacyRetirementEvidenceSource))) {
    return { ok: false, reason: 'invalid_evidence_source' };
  }
  if (record.reasonCode != null
    && (typeof record.reasonCode !== 'string' || !SAFE_REASON_RE.test(record.reasonCode))) {
    return { ok: false, reason: 'invalid_reason_code' };
  }
  if (record.safetyVerdict != null
    && (typeof record.safetyVerdict !== 'string'
      || !VALID_SAFETY_VERDICTS.has(record.safetyVerdict as ChatV2LegacyParitySafetyVerdict))) {
    return { ok: false, reason: 'invalid_safety_verdict' };
  }
  if (record.safetyDimension != null
    && (typeof record.safetyDimension !== 'string'
      || !VALID_SAFETY_DIMENSIONS.has(record.safetyDimension as ChatV2LegacyParitySafetyDimension))) {
    return { ok: false, reason: 'invalid_safety_dimension' };
  }
  if (isBlockingReviewVerdict(record.safetyVerdict as ChatV2LegacyParitySafetyVerdict | undefined)
    && (record.safetyDimension == null || record.safetyDimension === 'none')) {
    return { ok: false, reason: 'missing_safety_dimension' };
  }
  if ((record.evaluator === 'claude' || record.evaluator === 'manual')
    && (record.evidenceSource ?? 'runtime_route') === 'runtime_route'
    && record.reviewRubricVersion !== CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION) {
    return { ok: false, reason: 'missing_review_rubric_version' };
  }
  return {
    ok: true,
    observation: {
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: record.routeId,
      sampleHmac: record.sampleHmac,
      matched: record.matched,
      tested: record.tested,
      oldOwner: record.oldOwner,
      replacement: record.replacement,
      evaluator: record.evaluator as ChatV2LegacyParityEvaluator,
      evidenceSource: (record.evidenceSource as ChatV2LegacyRetirementEvidenceSource | undefined) ?? 'runtime_route',
      peerReviewSignoffHash: typeof record.peerReviewSignoffHash === 'string' ? record.peerReviewSignoffHash : undefined,
      reasonCode: record.reasonCode as string | undefined,
      safetyVerdict: record.safetyVerdict as ChatV2LegacyParitySafetyVerdict | undefined,
      safetyDimension: record.safetyDimension as ChatV2LegacyParitySafetyDimension | undefined,
      reviewRubricVersion: record.reviewRubricVersion === CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION
        ? CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION
        : undefined,
    },
  };
}

export function aggregateChatV2LegacyParityObservations(
  observations: ChatV2LegacyParityObservation[],
): Array<ChatV2LegacyParityObservationAggregate> {
  const groups = new Map<string, ChatV2LegacyParityObservation[]>();
  for (const observation of observations) {
    const existing = groups.get(observation.routeId) ?? [];
    existing.push(observation);
    groups.set(observation.routeId, existing);
  }

  return [...groups.entries()].map(([routeId, routeObservations]) => {
    const first = routeObservations[0]!;
    const bySample = new Map<string, ChatV2LegacyParityObservation>();
    for (const observation of routeObservations) {
      const existing = bySample.get(observation.sampleHmac);
      if (existing && (existing.matched !== observation.matched || existing.tested !== observation.tested)) {
        return {
          routeId,
          label: emptyLabel(first),
          blockedReason: `conflicting_duplicate_sample:${observation.sampleHmac}`,
        };
      }
      bySample.set(observation.sampleHmac, observation);
    }
    const samples = [...bySample.values()];
    const worseSafetySample = samples.find((sample) => sample.safetyVerdict === 'chatv2_worse' || sample.safetyVerdict === 'chatv2_worse_safety');
    if (worseSafetySample) {
      return {
        routeId,
        label: {
          ...emptyLabel(first),
          sampleCount: samples.length,
          matchingCount: samples.filter(isParityMatchedSample).length,
          safetyRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse' || sample.safetyVerdict === 'chatv2_worse_safety').length,
          qualityRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse_quality').length,
          degradedNotComparableCount: samples.filter((sample) => sample.safetyVerdict === 'not_comparable_degraded').length,
        },
        blockedReason: `chatv2_worse_safety_regression:${worseSafetySample.safetyDimension ?? 'unknown'}`,
      };
    }
    const worseQualitySample = samples.find((sample) => sample.safetyVerdict === 'chatv2_worse_quality');
    if (worseQualitySample) {
      return {
        routeId,
        label: {
          ...emptyLabel(first),
          sampleCount: samples.length,
          matchingCount: samples.filter(isParityMatchedSample).length,
          safetyRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse' || sample.safetyVerdict === 'chatv2_worse_safety').length,
          qualityRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse_quality').length,
          degradedNotComparableCount: samples.filter((sample) => sample.safetyVerdict === 'not_comparable_degraded').length,
        },
        blockedReason: `chatv2_worse_quality_regression:${worseQualitySample.safetyDimension ?? 'unknown'}`,
      };
    }
    const degradedSample = samples.find((sample) => sample.safetyVerdict === 'not_comparable_degraded');
    if (degradedSample) {
      return {
        routeId,
        label: {
          ...emptyLabel(first),
          sampleCount: samples.length,
          matchingCount: samples.filter(isParityMatchedSample).length,
          safetyRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse' || sample.safetyVerdict === 'chatv2_worse_safety').length,
          qualityRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse_quality').length,
          degradedNotComparableCount: samples.filter((sample) => sample.safetyVerdict === 'not_comparable_degraded').length,
        },
        blockedReason: `not_comparable_degraded:${degradedSample.safetyDimension ?? 'unknown'}`,
      };
    }
    const inconsistent = samples.find((sample) =>
      sample.oldOwner !== first.oldOwner
      || sample.replacement !== first.replacement
      || sample.evaluator !== first.evaluator
      || (sample.evidenceSource ?? 'runtime_route') !== (first.evidenceSource ?? 'runtime_route'),
    );
    if (inconsistent) {
      return {
        routeId,
        label: emptyLabel(first),
        blockedReason: 'inconsistent_route_metadata',
      };
    }
    return {
      routeId,
      label: {
        schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
        routeId,
        replaced: samples.length > 0 && samples.every((sample) => sample.tested),
        tested: samples.length > 0 && samples.every((sample) => sample.tested),
        sampleCount: samples.length,
        matchingCount: samples.filter(isParityMatchedSample).length,
        oldOwner: first.oldOwner,
        replacement: first.replacement,
        evaluator: first.evaluator,
        evidenceSource: first.evidenceSource ?? 'runtime_route',
        peerReviewSignoffHash: first.peerReviewSignoffHash,
        safetyRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse' || sample.safetyVerdict === 'chatv2_worse_safety').length,
        qualityRegressionCount: samples.filter((sample) => sample.safetyVerdict === 'chatv2_worse_quality').length,
        degradedNotComparableCount: samples.filter((sample) => sample.safetyVerdict === 'not_comparable_degraded').length,
        reviewRubricVersion: samples.some((sample) => sample.reviewRubricVersion === CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION)
          ? CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION
          : undefined,
      },
    };
  });
}

export function buildChatV2LegacyParityEvidenceInput(input: {
  label: ChatV2LegacyParityLabel;
  requestId: string;
}): ChatV2LegacyParityEvidenceInput {
  const { label } = input;
  const shadowParityRate = label.sampleCount > 0 ? label.matchingCount / label.sampleCount : 0;
  return {
    requestId: input.requestId,
    routeId: label.routeId,
    replaced: label.replaced,
    tested: label.tested,
    shadowParityRate,
    sampleCount: label.sampleCount,
    evidenceSource: label.evidenceSource ?? 'runtime_route',
    safeMetadata: {
      schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
      parityLabelVersion: label.schemaVersion,
      oldOwner: label.oldOwner,
      replacement: label.replacement,
      evaluator: label.evaluator,
      peerReviewSignoffHash: label.peerReviewSignoffHash,
      matchingCount: label.matchingCount,
      sampleCount: label.sampleCount,
      safetyRegressionCount: label.safetyRegressionCount ?? 0,
      qualityRegressionCount: label.qualityRegressionCount ?? 0,
      degradedNotComparableCount: label.degradedNotComparableCount ?? 0,
      reviewRubricVersion: label.reviewRubricVersion,
      parityRate: shadowParityRate,
      parityLabelImport: true,
    },
  };
}

function emptyLabel(observation: ChatV2LegacyParityObservation): ChatV2LegacyParityLabel {
  return {
    schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
    routeId: observation.routeId,
    replaced: false,
    tested: false,
    sampleCount: 0,
    matchingCount: 0,
    oldOwner: observation.oldOwner,
    replacement: observation.replacement,
    evaluator: observation.evaluator,
    evidenceSource: observation.evidenceSource ?? 'runtime_route',
    peerReviewSignoffHash: observation.peerReviewSignoffHash,
    safetyRegressionCount: 0,
    qualityRegressionCount: 0,
    degradedNotComparableCount: 0,
    reviewRubricVersion: observation.reviewRubricVersion,
  };
}

function integerFromUnknown(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function validateZeroCount(
  value: unknown,
  sampleCount: number,
): { kind: 'ok'; value: number } | { kind: 'missing' } | { kind: 'invalid' } {
  if (value == null) return { kind: 'missing' };
  const parsed = integerFromUnknown(value);
  if (parsed == null || parsed < 0 || parsed > sampleCount) return { kind: 'invalid' };
  return { kind: 'ok', value: parsed };
}

function isBlockingReviewVerdict(value: ChatV2LegacyParitySafetyVerdict | undefined): boolean {
  return value === 'chatv2_worse'
    || value === 'chatv2_worse_quality'
    || value === 'chatv2_worse_safety'
    || value === 'not_comparable_degraded';
}

function isParityMatchedSample(sample: ChatV2LegacyParityObservation): boolean {
  if (sample.evaluator === 'claude' || sample.evaluator === 'manual') {
    if (
      sample.safetyVerdict === 'match'
      || sample.safetyVerdict === 'equivalent'
      || sample.safetyVerdict === 'chatv2_better'
      || sample.safetyVerdict === 'equivalent_different'
    ) {
      return true;
    }
    if (isBlockingReviewVerdict(sample.safetyVerdict)) return false;
  }
  return sample.matched;
}

function findUnsafeFieldKey(value: unknown, path = ''): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnsafeFieldKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (UNSAFE_FIELD_KEY_RE.test(key)) return nextPath;
    const found = findUnsafeFieldKey(nested, nextPath);
    if (found) return found;
  }
  return null;
}
