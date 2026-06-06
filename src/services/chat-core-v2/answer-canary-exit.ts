// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';

import {
  CHAT_CORE_V2_ACCEPTANCE_EXIT_THRESHOLDS,
  CHAT_CORE_V2_ACCEPTANCE_LOCALE_BUCKETS,
  computeAnswerAcceptanceRate,
  type ChatCoreV2AcceptanceLocaleBucket,
} from './answer-acceptance-counter';
import {
  validateComposedAnswerDraft,
  type ComposedAnswerDraft,
} from './answer-composition';

export const CHAT_CORE_V2_ANSWER_CANARY_EXIT_VERSION = 'chat_core_v2_answer_canary_exit@1.0.0';
export const CHAT_CORE_V2_UNSUPPORTED_CLAIM_CRITIC_MIN_COVERAGE = 0.95;

export type ChatCoreV2AnswerCanaryExitReason =
  | 'acceptance_no_data'
  | 'acceptance_below_threshold'
  | 'unsupported_claim_critic_no_samples'
  | 'unsupported_claim_critic_below_threshold'
  | 'ok';

export interface UnsupportedClaimCriticFixture {
  id: string;
  draft: ComposedAnswerDraft;
}

export interface UnsupportedClaimCriticCoverage {
  total: number;
  caught: number;
  coverage: number | null;
  minCoverage: number;
  pass: boolean;
  failedFixtureIds: string[];
}

export interface AnswerCanaryLocaleExitResult {
  bucket: ChatCoreV2AcceptanceLocaleBucket;
  accepted: number;
  total: number;
  rate: number | null;
  threshold: number;
  pass: boolean;
}

export interface AnswerCanaryExitVerdict {
  schemaVersion: typeof CHAT_CORE_V2_ANSWER_CANARY_EXIT_VERSION;
  tenantId: string;
  pass: boolean;
  reasons: ChatCoreV2AnswerCanaryExitReason[];
  localeResults: Record<ChatCoreV2AcceptanceLocaleBucket, AnswerCanaryLocaleExitResult>;
  unsupportedClaimCritic: UnsupportedClaimCriticCoverage;
}

export interface EvaluateAnswerCanaryExitInput {
  db: Database.Database;
  tenantId: string;
  unsupportedClaimFixtures: readonly UnsupportedClaimCriticFixture[];
  requiredLocaleBuckets?: readonly ChatCoreV2AcceptanceLocaleBucket[];
  acceptanceThresholds?: Partial<Record<ChatCoreV2AcceptanceLocaleBucket, number>>;
  minUnsupportedClaimCriticCoverage?: number;
}

export function evaluateUnsupportedClaimCriticCoverage(
  fixtures: readonly UnsupportedClaimCriticFixture[],
  minCoverage = CHAT_CORE_V2_UNSUPPORTED_CLAIM_CRITIC_MIN_COVERAGE,
): UnsupportedClaimCriticCoverage {
  const failedFixtureIds: string[] = [];
  let caught = 0;

  for (const fixture of fixtures) {
    const issues = validateComposedAnswerDraft(fixture.draft);
    if (issues.includes('unsupported_factual_claim')) {
      caught += 1;
    } else {
      failedFixtureIds.push(fixture.id);
    }
  }

  const total = fixtures.length;
  const coverage = total > 0 ? caught / total : null;
  return {
    total,
    caught,
    coverage,
    minCoverage,
    pass: coverage !== null && coverage >= minCoverage,
    failedFixtureIds,
  };
}

export function evaluateAnswerCanaryExit(input: EvaluateAnswerCanaryExitInput): AnswerCanaryExitVerdict {
  const tenantId = String(input.tenantId);
  const requiredBuckets = input.requiredLocaleBuckets ?? CHAT_CORE_V2_ACCEPTANCE_LOCALE_BUCKETS;
  const thresholds = input.acceptanceThresholds ?? {};
  const localeResults = buildEmptyLocaleResults();
  const reasons: ChatCoreV2AnswerCanaryExitReason[] = [];

  for (const bucket of requiredBuckets) {
    const threshold = normalizeThreshold(thresholds[bucket] ?? CHAT_CORE_V2_ACCEPTANCE_EXIT_THRESHOLDS[bucket]);
    const rate = computeAnswerAcceptanceRate(input.db, bucket, { tenantId });
    const pass = rate.rate !== null && rate.rate >= threshold;
    localeResults[bucket] = {
      bucket,
      accepted: rate.accepted,
      total: rate.total,
      rate: rate.rate,
      threshold,
      pass,
    };
    if (rate.rate === null) {
      reasons.push('acceptance_no_data');
    } else if (!pass) {
      reasons.push('acceptance_below_threshold');
    }
  }

  const unsupportedClaimCritic = evaluateUnsupportedClaimCriticCoverage(
    input.unsupportedClaimFixtures,
    input.minUnsupportedClaimCriticCoverage,
  );
  if (unsupportedClaimCritic.coverage === null) {
    reasons.push('unsupported_claim_critic_no_samples');
  } else if (!unsupportedClaimCritic.pass) {
    reasons.push('unsupported_claim_critic_below_threshold');
  }

  const uniqueReasons = [...new Set(reasons)];
  const pass = uniqueReasons.length === 0;
  return {
    schemaVersion: CHAT_CORE_V2_ANSWER_CANARY_EXIT_VERSION,
    tenantId,
    pass,
    reasons: pass ? ['ok'] : uniqueReasons,
    localeResults,
    unsupportedClaimCritic,
  };
}

function buildEmptyLocaleResults(): Record<ChatCoreV2AcceptanceLocaleBucket, AnswerCanaryLocaleExitResult> {
  return CHAT_CORE_V2_ACCEPTANCE_LOCALE_BUCKETS.reduce(
    (acc, bucket) => {
      acc[bucket] = {
        bucket,
        accepted: 0,
        total: 0,
        rate: null,
        threshold: CHAT_CORE_V2_ACCEPTANCE_EXIT_THRESHOLDS[bucket],
        pass: false,
      };
      return acc;
    },
    {} as Record<ChatCoreV2AcceptanceLocaleBucket, AnswerCanaryLocaleExitResult>,
  );
}

function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
