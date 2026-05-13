// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

export type NexusChatOwnerSkill =
  | 'secretary'
  | 'tasks'
  | 'training'
  | 'cooking'
  | 'finance'
  | 'content'
  | 'decision_center'
  | 'connections'
  | 'notifications'
  | 'owner_admin'
  | 'chat'
  | 'system';

export type NexusChatActionability =
  | 'answer_only'
  | 'clarify'
  | 'preview'
  | 'execute'
  | 'decision_center'
  | 'open_surface'
  | 'blocked'
  | 'degraded';

export type NexusChatRiskLevel = 'low' | 'medium' | 'high';
export type NexusChatVerificationStatus = 'not_required' | 'pending' | 'verified' | 'partial_failure' | 'failed' | 'blocked';
export type NexusChatStaleness = 'fresh' | 'recent' | 'stale' | 'unknown';

export interface NexusGroundingFact {
  statement: string;
  source: string;
  field?: string;
  freshness: NexusChatStaleness;
  confidence: number;
  safeForUser: boolean;
}

export interface NexusChatNextBestAction {
  id: string;
  label: string;
  kind: 'ask' | 'retry' | 'open_surface' | 'confirm' | 'refresh' | 'decision_center' | 'none';
  targetSkill?: NexusChatOwnerSkill;
}

export interface NexusChatFallbackMetadata {
  fallbackType: 'none' | 'cached_read' | 'deterministic_summary' | 'provider_fallback' | 'model_unavailable' | 'tool_failure' | 'degraded_response';
  fallbackReason?: string;
  retryable: boolean;
  sourceFreshness: NexusChatStaleness;
  userActionRequired: boolean;
  operatorActionRequired: boolean;
}

export interface NexusChatLatencyMetadata {
  tier: 'tier0_local' | 'tier1_fast_read' | 'tier2_verified_write' | 'tier3_model_assisted' | 'tier4_long_running' | 'unknown';
  durationMs: number;
  stageTimingsMs: Record<string, number>;
  budgetMs?: number;
  budgetExceeded?: boolean;
}

export interface NexusAnswerContract {
  version: 'nexus_answer_contract.v1';
  intent: string;
  ownerSkill: NexusChatOwnerSkill;
  routeMethod: string;
  confidence: number;
  groundingFacts: NexusGroundingFact[];
  missingFacts: string[];
  staleness: NexusChatStaleness;
  riskLevel: NexusChatRiskLevel;
  actionability: NexusChatActionability;
  verificationStatus: NexusChatVerificationStatus;
  fallbackUsed: boolean;
  fallback: NexusChatFallbackMetadata;
  userFacingSummary: string;
  nextBestActions: NexusChatNextBestAction[];
  traceId: string;
  latency: NexusChatLatencyMetadata;
}

export interface ChatLatencyTracker {
  mark(stage: string): void;
  snapshot(tier: NexusChatLatencyMetadata['tier'], budgetMs?: number): NexusChatLatencyMetadata;
}

export function createChatLatencyTracker(startedAt = Date.now()): ChatLatencyTracker {
  const stageMarks: Record<string, number> = {};
  return {
    mark(stage: string) {
      if (!stage || stageMarks[stage] !== undefined) return;
      stageMarks[stage] = Date.now() - startedAt;
    },
    snapshot(tier: NexusChatLatencyMetadata['tier'], budgetMs?: number) {
      const durationMs = Date.now() - startedAt;
      return {
        tier,
        durationMs,
        stageTimingsMs: { ...stageMarks },
        ...(Number.isFinite(budgetMs) && budgetMs! > 0
          ? { budgetMs, budgetExceeded: durationMs > budgetMs! }
          : {}),
      };
    },
  };
}

export function buildNexusAnswerContract(input: {
  intent: string;
  ownerSkill: NexusChatOwnerSkill;
  routeMethod: string;
  confidence?: number;
  groundingFacts?: NexusGroundingFact[];
  missingFacts?: string[];
  staleness?: NexusChatStaleness;
  riskLevel?: NexusChatRiskLevel;
  actionability?: NexusChatActionability;
  verificationStatus?: NexusChatVerificationStatus;
  fallback?: Partial<NexusChatFallbackMetadata>;
  userFacingSummary?: string;
  nextBestActions?: NexusChatNextBestAction[];
  traceId?: string;
  latency?: NexusChatLatencyMetadata;
}): NexusAnswerContract {
  const fallbackUsed = input.fallback?.fallbackType !== undefined && input.fallback.fallbackType !== 'none';
  return {
    version: 'nexus_answer_contract.v1',
    intent: normalizeShortText(input.intent, 'general_chat'),
    ownerSkill: input.ownerSkill,
    routeMethod: normalizeShortText(input.routeMethod, 'unknown'),
    confidence: clamp01(input.confidence ?? 0.5),
    groundingFacts: input.groundingFacts ?? [],
    missingFacts: [...new Set((input.missingFacts ?? []).filter(Boolean))],
    staleness: input.staleness ?? deriveStaleness(input.groundingFacts ?? []),
    riskLevel: input.riskLevel ?? 'low',
    actionability: input.actionability ?? 'answer_only',
    verificationStatus: input.verificationStatus ?? 'not_required',
    fallbackUsed,
    fallback: {
      fallbackType: input.fallback?.fallbackType ?? 'none',
      fallbackReason: input.fallback?.fallbackReason,
      retryable: Boolean(input.fallback?.retryable),
      sourceFreshness: input.fallback?.sourceFreshness ?? input.staleness ?? deriveStaleness(input.groundingFacts ?? []),
      userActionRequired: Boolean(input.fallback?.userActionRequired),
      operatorActionRequired: Boolean(input.fallback?.operatorActionRequired),
    },
    userFacingSummary: normalizeShortText(input.userFacingSummary, ''),
    nextBestActions: input.nextBestActions ?? [],
    traceId: input.traceId || `chat-${randomUUID()}`,
    latency: input.latency ?? {
      tier: 'unknown',
      durationMs: 0,
      stageTimingsMs: {},
    },
  };
}

export function metadataGroundingFacts(facts: NexusGroundingFact[]): Array<{ statement: string; source: string; field?: string }> {
  return facts
    .filter((fact) => fact.safeForUser)
    .map((fact) => ({
      statement: fact.statement,
      source: fact.source,
      ...(fact.field ? { field: fact.field } : {}),
    }));
}

export function summarizeContractForLog(contract: NexusAnswerContract): Record<string, unknown> {
  return {
    intent: contract.intent,
    ownerSkill: contract.ownerSkill,
    routeMethod: contract.routeMethod,
    actionability: contract.actionability,
    verificationStatus: contract.verificationStatus,
    fallbackUsed: contract.fallbackUsed,
    fallbackType: contract.fallback.fallbackType,
    missingFacts: contract.missingFacts,
    traceId: contract.traceId,
    latencyTier: contract.latency.tier,
    durationMs: contract.latency.durationMs,
  };
}

function deriveStaleness(facts: NexusGroundingFact[]): NexusChatStaleness {
  if (facts.length === 0) return 'unknown';
  if (facts.some((fact) => fact.freshness === 'stale')) return 'stale';
  if (facts.some((fact) => fact.freshness === 'unknown')) return 'unknown';
  if (facts.some((fact) => fact.freshness === 'recent')) return 'recent';
  return 'fresh';
}

function normalizeShortText(value: string | undefined, fallback: string): string {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 240) : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
