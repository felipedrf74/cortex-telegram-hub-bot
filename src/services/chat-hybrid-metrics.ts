// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatHybridActionGateMetrics } from './chat-evaluation-harness';
import { detectResponseLanguage, expectedLanguageForLocale } from './chat-language-detector';

export interface ChatHybridActionMetricCase {
  id: string;
  expectedSkill?: string | null;
  expectedAction?: string | null;
  actualSkill?: string | null;
  actualAction?: string | null;
  expectedSlots?: Record<string, unknown>;
  actualSlots?: Record<string, unknown>;
  expectedActionable?: boolean;
  actualActionable?: boolean;
  expectedRefusal?: boolean;
  actualRequiredArgsPresent?: boolean;
  status?: string | null;
  verificationRequired?: boolean;
  verifiedMutation?: boolean;
  wrongEntity?: boolean;
  falseBlocked?: boolean;
  uiHandoff?: boolean;
  latencyMs?: number;
  costUsd?: number;
  criticalRiskFalseExecution?: boolean;
  falseSuccessWithoutReadBack?: boolean;
  debugInternalLeakage?: boolean;
  portugueseLocalizationLeakage?: boolean;
  /**
   * BCP-47-ish prompt locale (e.g. 'es-419', 'pt-BR', 'en-US'). When set and
   * `actualResponseText` is present, portuguese localization leakage is
   * derived deterministically from chat-language-detector instead of relying
   * on the caller pre-computing the `portugueseLocalizationLeakage` boolean.
   * An explicit boolean always wins, so existing corpora keep their behavior.
   */
  promptLocale?: string | null;
  claimedSuccess?: boolean;
  verifierReadBackOk?: boolean;
  actualResponseText?: string | null;
  expectedEntityId?: string | null;
  actualEntityId?: string | null;
}

export function computeHybridActionMetricsFromCorpus(cases: ChatHybridActionMetricCase[]): ChatHybridActionGateMetrics {
  const actionable = cases.filter((testCase) => testCase.expectedActionable !== false && Boolean(testCase.expectedSkill || testCase.expectedAction));
  const skillBuckets = new Map<string, { correct: number; total: number }>();
  let actionCorrect = 0;
  let actionTotal = 0;
  let recallHits = 0;
  let verifiedRequired = 0;
  let verifiedHits = 0;
  let slotTp = 0;
  let slotFp = 0;
  let slotFn = 0;
  let verifiedSuccesses = 0;
  let totalCost = 0;
  const latencies: number[] = [];

  for (const testCase of cases) {
    const expectedSkill = testCase.expectedSkill ?? null;
    const expectedAction = testCase.expectedAction ?? null;
    const actualSkill = testCase.actualSkill ?? null;
    const actualAction = testCase.actualAction ?? null;
    const isActionable = testCase.expectedActionable !== false && Boolean(expectedSkill || expectedAction);
    const isCorrectAction = (!expectedSkill || expectedSkill === actualSkill) && (!expectedAction || expectedAction === actualAction);

    if (isActionable) {
      actionTotal += 1;
      const bucketKey = expectedSkill ?? 'unknown';
      const bucket = skillBuckets.get(bucketKey) ?? { correct: 0, total: 0 };
      bucket.total += 1;
      if (isCorrectAction) {
        actionCorrect += 1;
        bucket.correct += 1;
        recallHits += 1;
      }
      skillBuckets.set(bucketKey, bucket);
    }

    const expectedSlots = testCase.expectedSlots ?? {};
    const actualSlots = testCase.actualSlots ?? {};
    const expectedKeys = new Set(Object.keys(expectedSlots));
    const actualKeys = new Set(Object.keys(actualSlots));
    for (const key of expectedKeys) {
      if (valuesEqual(expectedSlots[key], actualSlots[key])) slotTp += 1;
      else slotFn += 1;
    }
    for (const key of actualKeys) {
      if (!expectedKeys.has(key)) slotFp += 1;
    }

    if (testCase.verificationRequired) {
      verifiedRequired += 1;
      if (testCase.verifiedMutation) {
        verifiedHits += 1;
        verifiedSuccesses += 1;
      }
    }
    if (typeof testCase.costUsd === 'number' && Number.isFinite(testCase.costUsd)) totalCost += Math.max(0, testCase.costUsd);
    if (typeof testCase.latencyMs === 'number' && Number.isFinite(testCase.latencyMs)) latencies.push(Math.max(0, testCase.latencyMs));
  }

  const precisionBuckets = [...skillBuckets.values()].map((bucket) => bucket.total === 0 ? 1 : bucket.correct / bucket.total);
  const macroActionPrecision = precisionBuckets.length === 0
    ? (cases.length === 0 ? 1 : Number.NaN)
    : average(precisionBuckets);
  const macroSlotF1 = f1(slotTp, slotFp, slotFn);
  const totalActionable = actionable.length;
  const verifiedDenominator = verifiedRequired === 0 ? 1 : verifiedRequired;
  const costDenominator = verifiedSuccesses === 0 ? 1 : verifiedSuccesses;
  const wrongEntityCases = cases.filter((testCase) => {
    if (testCase.expectedEntityId != null || testCase.actualEntityId != null) {
      return Boolean(testCase.expectedEntityId && testCase.actualEntityId && testCase.expectedEntityId !== testCase.actualEntityId);
    }
    return testCase.wrongEntity === true;
  });
  const falseSuccessWithoutReadBackCases = cases.filter((testCase) => {
    if (testCase.claimedSuccess != null || testCase.verifierReadBackOk != null) {
      return testCase.claimedSuccess === true && testCase.verifierReadBackOk === false;
    }
    return testCase.falseSuccessWithoutReadBack === true;
  });
  const debugInternalLeakageCases = cases.filter((testCase) => {
    if (typeof testCase.actualResponseText === 'string') {
      return DEBUG_LEAKAGE_PATTERNS.some((pattern) => pattern.test(testCase.actualResponseText || ''));
    }
    return testCase.debugInternalLeakage === true;
  });
  const falsePositiveOnRefusalCases = cases.filter((testCase) =>
    testCase.expectedActionable === false
    && testCase.expectedRefusal === true
    && testCase.actualActionable === true
    && testCase.actualRequiredArgsPresent === true);

  return {
    macroActionPrecision,
    macroSlotF1,
    actionRecallCoverage: totalActionable === 0 ? 1 : recallHits / totalActionable,
    verifiedMutationSuccessRate: verifiedRequired === 0 ? 1 : verifiedHits / verifiedDenominator,
    wrongEntityRate: (totalActionable || cases.length) === 0 ? 0 : wrongEntityCases.length / (totalActionable || cases.length),
    falseBlockRate: rate(cases, (testCase) => testCase.falseBlocked === true, totalActionable || cases.length),
    clarificationRate: cases.length === 0 ? 0 : cases.filter((testCase) => testCase.status === 'needs_clarification' || testCase.status === 'needs_input').length / cases.length,
    uiHandoffRate: cases.length === 0 ? 0 : cases.filter((testCase) => testCase.uiHandoff === true).length / cases.length,
    p95LatencyMs: percentile(latencies, 0.95),
    costPerVerifiedSuccessUsd: totalCost / costDenominator,
    criticalRiskFalseExecutionCount: cases.filter((testCase) => testCase.criticalRiskFalseExecution === true).length,
    falseSuccessWithoutReadBackCount: falseSuccessWithoutReadBackCases.length,
    falsePositiveOnRefusalCount: falsePositiveOnRefusalCases.length,
    debugInternalLeakageCount: debugInternalLeakageCases.length,
    portugueseLocalizationLeakageCount: cases.filter(isPortugueseLocalizationLeakage).length,
  };
}

/**
 * Portuguese localization leakage: the reply came back in Portuguese for a
 * prompt whose locale expected another language (the recurring es-419 → pt
 * failure class from live eval evidence).
 *
 * Resolution order (additive — existing corpora unchanged):
 *   1. explicit `portugueseLocalizationLeakage` boolean (legacy path) wins;
 *   2. otherwise, when `promptLocale` + `actualResponseText` are present,
 *      derive via the deterministic detector (fail-open: 'unknown' detection
 *      or an unmapped/pt locale never counts as leakage);
 *   3. otherwise, not leakage.
 */
function isPortugueseLocalizationLeakage(testCase: ChatHybridActionMetricCase): boolean {
  if (typeof testCase.portugueseLocalizationLeakage === 'boolean') {
    return testCase.portugueseLocalizationLeakage;
  }
  if (typeof testCase.promptLocale === 'string' && typeof testCase.actualResponseText === 'string') {
    const expected = expectedLanguageForLocale(testCase.promptLocale);
    if (expected === 'pt' || expected === 'unknown') return false;
    return detectResponseLanguage(testCase.actualResponseText).language === 'pt';
  }
  return false;
}

const DEBUG_LEAKAGE_PATTERNS = [
  /\baccountId\b/i,
  /\baccount_id\b/i,
  /\bproviderObjectId\b/i,
  /\bprovider_object_id\b/i,
  /\bmessageId\b/i,
  /\bmessage_id\b/i,
  /\bconversationId\b/i,
  /\bconversation_id\b/i,
  /\bsourceFacts?\b/i,
  /\bsource_facts?\b/i,
  /\bchat_action_runs\b/i,
  /\baction_runs\b/i,
  /\baction_telemetry\b/i,
  /\bSELECT\s+.+\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\btenantId\s*[:=]/i,
  /\btenant_id\s*=/i,
  /\buserId\s*[:=]/i,
  /\bauth\.scope\b/i,
  /\bchatReasoning\b/i,
  /\bchat\.skill_capability_registry\b/i,
  /\btraceId\b/i,
  /\braw\s*json\b/i,
  /\bprovider debug\b/i,
  /\bfallback policy\b/i,
];

// ─── M8: runtime quality-gate outcome counters (additive) ──────────
//
// In-process counters for the unified finalizer's gate outcomes:
// pass / verified-kept / surgical / replaced. Deterministic, no I/O —
// consumers snapshot via the getter (portal/evidence surfaces).

export type ChatQualityGateOutcome =
  | 'pass'
  | 'verified_kept'
  | 'surgical_downgrade'
  | 'replaced'
  | 'sanitized'
  | 'recipe_restructured';

const chatQualityGateOutcomeCounters: Record<ChatQualityGateOutcome, number> = {
  pass: 0,
  verified_kept: 0,
  surgical_downgrade: 0,
  replaced: 0,
  sanitized: 0,
  recipe_restructured: 0,
};

export function recordChatQualityGateOutcome(outcome: ChatQualityGateOutcome): void {
  if (!(outcome in chatQualityGateOutcomeCounters)) return;
  chatQualityGateOutcomeCounters[outcome] += 1;
}

export function getChatQualityGateOutcomeCounters(): Readonly<Record<ChatQualityGateOutcome, number>> {
  return { ...chatQualityGateOutcomeCounters };
}

export function resetChatQualityGateOutcomeCountersForTests(): void {
  for (const key of Object.keys(chatQualityGateOutcomeCounters) as ChatQualityGateOutcome[]) {
    chatQualityGateOutcomeCounters[key] = 0;
  }
}

// ─── M14: routing clarify budget counters (additive) ───────────────
//
// In-process counters for the flag-gated deterministic clarify policy so the
// approved ≤10% clarify budget is observable: clarifiedTurns/evaluatedTurns.
// evaluatedTurns counts routed-overlay orchestrator evaluations (the call
// that carries routedDomain — once per chat turn); pre-routing overlay calls
// and offline replays are not counted. Deterministic, no I/O.

export interface RoutingClarifyCounters {
  evaluatedTurns: number;
  clarifiedTurns: number;
}

const routingClarifyCounters: RoutingClarifyCounters = {
  evaluatedTurns: 0,
  clarifiedTurns: 0,
};

export function recordRoutingClarifyDecision(clarified: boolean): void {
  routingClarifyCounters.evaluatedTurns += 1;
  if (clarified) routingClarifyCounters.clarifiedTurns += 1;
}

export function getRoutingClarifyCounters(): Readonly<RoutingClarifyCounters> {
  return { ...routingClarifyCounters };
}

export function resetRoutingClarifyCountersForTests(): void {
  routingClarifyCounters.evaluatedTurns = 0;
  routingClarifyCounters.clarifiedTurns = 0;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function f1(tp: number, fp: number, fn: number): number {
  if (tp === 0 && fp === 0 && fn === 0) return 1;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index] ?? 0;
}

function rate(cases: ChatHybridActionMetricCase[], predicate: (testCase: ChatHybridActionMetricCase) => boolean, denominator: number): number {
  if (denominator === 0) return 0;
  return cases.filter(predicate).length / denominator;
}
