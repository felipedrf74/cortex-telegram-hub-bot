// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Central model pricing registry.
 *
 * All runtime metering, scenario reports, and eval cost estimates should read
 * from this file. Prices are USD per 1M tokens. Cache prices are included only
 * where the provider exposes cache token counters in our SDK integration.
 */

export type ModelPricingProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama';

import { logger } from '../utils/logger';

export interface ModelPricing {
  provider: ModelPricingProvider;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  batchDiscount?: number;
  // Deliberately unset today. Enabling suffix inheritance is a quota-cost
  // decision and requires review per docs/MODEL-REVIEW-PROCESS.md.
  acceptVariantSuffix?: boolean;
}

export interface ModelUsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelCostResult {
  costUsd: number;
  pricingResolved: boolean;
  pricingModelKey: string | null;
  pricing: ModelPricing | null;
}

export class ModelPricingUnresolvedError extends Error {
  constructor(
    readonly model: string,
    readonly provider?: string | null,
  ) {
    super(`No model pricing configured for ${provider ? `${provider}/` : ''}${model}`);
    this.name = 'ModelPricingUnresolvedError';
  }
}

const MODEL_PRICING: ModelPricing[] = [
  // Gemini API
  { provider: 'gemini', model: 'gemini-2.5-flash-lite', inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40, cacheReadUsdPerMillion: 0.025, batchDiscount: 0.5 },
  { provider: 'gemini', model: 'gemini-2.5-flash', inputUsdPerMillion: 0.30, outputUsdPerMillion: 2.50, cacheReadUsdPerMillion: 0.075, batchDiscount: 0.5 },
  { provider: 'gemini', model: 'gemini-2.5-pro', inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.00, cacheReadUsdPerMillion: 0.31, batchDiscount: 0.5 },
  { provider: 'gemini', model: 'gemini-2.0-flash', inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40, batchDiscount: 0.5 },
  { provider: 'gemini', model: 'gemini-2.0-pro', inputUsdPerMillion: 1.25, outputUsdPerMillion: 5.00 },
  { provider: 'gemini', model: 'gemini-1.5-pro', inputUsdPerMillion: 1.25, outputUsdPerMillion: 5.00 },

  // OpenAI API
  { provider: 'openai', model: 'gpt-5.4-nano', inputUsdPerMillion: 0.20, outputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.02, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-5.4-mini', inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.50, cacheReadUsdPerMillion: 0.075, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-5.4', inputUsdPerMillion: 2.50, outputUsdPerMillion: 15.00, cacheReadUsdPerMillion: 0.25, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-5-nano', inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.40, cacheReadUsdPerMillion: 0.005, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-5-mini', inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.00, cacheReadUsdPerMillion: 0.025, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-5', inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.00, cacheReadUsdPerMillion: 0.125, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-4.1-mini', inputUsdPerMillion: 0.40, outputUsdPerMillion: 1.60, cacheReadUsdPerMillion: 0.10, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-4.1-nano', inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40, cacheReadUsdPerMillion: 0.025, batchDiscount: 0.5 },
  { provider: 'openai', model: 'o4-mini', inputUsdPerMillion: 1.10, outputUsdPerMillion: 4.40, cacheReadUsdPerMillion: 0.275, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60, cacheReadUsdPerMillion: 0.075, batchDiscount: 0.5 },
  { provider: 'openai', model: 'gpt-4o', inputUsdPerMillion: 2.50, outputUsdPerMillion: 10.00, cacheReadUsdPerMillion: 1.25, batchDiscount: 0.5 },

  // Anthropic API
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputUsdPerMillion: 1.00, outputUsdPerMillion: 5.00, cacheReadUsdPerMillion: 0.10, cacheWriteUsdPerMillion: 1.25 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inputUsdPerMillion: 1.00, outputUsdPerMillion: 5.00, cacheReadUsdPerMillion: 0.10, cacheWriteUsdPerMillion: 1.25 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputUsdPerMillion: 3.00, outputUsdPerMillion: 15.00, cacheReadUsdPerMillion: 0.30, cacheWriteUsdPerMillion: 3.75 },
  { provider: 'anthropic', model: 'claude-opus-4-6', inputUsdPerMillion: 5.00, outputUsdPerMillion: 25.00, cacheReadUsdPerMillion: 0.50, cacheWriteUsdPerMillion: 6.25 },

  // Local Ollama (WO-ollama-local-llm) — zero cost, accounted via
  // local_request_units column instead of cost_usd dollars. Listed here
  // so getOrThrow / computeModelUsageCostUsd resolves cleanly without
  // firing the operator alert for unknown models.
  { provider: 'ollama', model: 'qwen3.6:35b-a3b-q4_K_M', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
  { provider: 'ollama', model: 'qwen3.6:27b-q4_K_M', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
];

const UNRESOLVED_MODEL_SENTINEL_PRICING = {
  // Deliberate Sonnet-class ceiling, not Opus-class. Unknown models still
  // trigger first-call operator alerts; Opus models must be registered exactly.
  inputUsdPerMillion: 3.00,
  outputUsdPerMillion: 15.00,
};

const unresolvedPricingAlertDedupe = new Set<string>();
let unresolvedAlertCallCount = 0;
let recordOperatorAlertOverride: typeof import('./operator-alerts').recordOperatorAlert | null = null;

function getRecordOperatorAlert(): typeof import('./operator-alerts').recordOperatorAlert {
  if (recordOperatorAlertOverride) return recordOperatorAlertOverride;
  return require('./operator-alerts').recordOperatorAlert;
}

export function getModelPricingTable(): ModelPricing[] {
  return MODEL_PRICING.map((entry) => ({ ...entry }));
}

export function resolveModelPricing(
  model: string,
  provider?: string | null,
): ModelPricing | null {
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return null;
  const normalizedProvider = provider ? String(provider).trim().toLowerCase() : null;
  for (const entry of MODEL_PRICING) {
    if (normalizedProvider && entry.provider !== normalizedProvider) continue;
    if (normalizedModel === entry.model) {
      return entry;
    }
  }
  for (const entry of MODEL_PRICING) {
    if (normalizedProvider && entry.provider !== normalizedProvider) continue;
    if (!entry.acceptVariantSuffix) continue;
    if (normalizedModel.startsWith(`${entry.model}-`)) return entry;
  }
  return null;
}

export function getModelPricingOrThrow(
  model: string,
  provider?: string | null,
): ModelPricing {
  const pricing = resolveModelPricing(model, provider);
  if (!pricing) throw new ModelPricingUnresolvedError(model, provider);
  return pricing;
}

export function computeModelUsageCostUsd(
  model: string,
  usage: ModelUsageForCost,
  provider?: string | null,
): ModelCostResult {
  const pricing = resolveModelPricing(model, provider);
  if (!pricing) {
    const inputTokens = Math.max(0, usage.inputTokens || 0);
    const outputTokens = Math.max(0, usage.outputTokens || 0);
    const cacheReadTokens = Math.max(0, usage.cacheReadTokens || 0);
    const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens || 0);
    const regularInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const costUsd =
      ((regularInputTokens + cacheReadTokens + cacheWriteTokens) / 1_000_000) * UNRESOLVED_MODEL_SENTINEL_PRICING.inputUsdPerMillion +
      (outputTokens / 1_000_000) * UNRESOLVED_MODEL_SENTINEL_PRICING.outputUsdPerMillion;
    return {
      costUsd,
      pricingResolved: false,
      pricingModelKey: null,
      pricing: null,
    };
  }

  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens || 0);
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens || 0);
  const regularInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const costUsd =
    (regularInputTokens / 1_000_000) * pricing.inputUsdPerMillion +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillion +
    (cacheReadTokens / 1_000_000) * (pricing.cacheReadUsdPerMillion ?? pricing.inputUsdPerMillion) +
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion);

  return {
    costUsd,
    pricingResolved: true,
    pricingModelKey: pricing.model,
    pricing,
  };
}

export function recordUnresolvedModelPricingAlert(input: {
  provider?: string | null;
  model: string;
  category?: string | null;
  userId?: number | null;
}): void {
  if (++unresolvedAlertCallCount % 100 === 0) {
    pruneStaleUnresolvedPricingAlertDedupeKeys();
  }
  const provider = String(input.provider || 'unknown').trim().toLowerCase() || 'unknown';
  const model = String(input.model || 'unknown').trim() || 'unknown';
  const hour = new Date().toISOString().slice(0, 13);
  const dedupeKey = `model-pricing-unresolved:${provider}:${model}:${hour}`;
  if (unresolvedPricingAlertDedupe.has(dedupeKey)) return;
  unresolvedPricingAlertDedupe.add(dedupeKey);

  logger.error(
    {
      provider,
      model,
      category: input.category ?? null,
      userId: input.userId ?? null,
      sentinelInputUsdPerMillion: UNRESOLVED_MODEL_SENTINEL_PRICING.inputUsdPerMillion,
      sentinelOutputUsdPerMillion: UNRESOLVED_MODEL_SENTINEL_PRICING.outputUsdPerMillion,
    },
    'Unresolved model pricing; charging sentinel ceiling rate and alerting ops',
  );

  try {
    getRecordOperatorAlert()({
      severity: 'critical',
      source: 'model_pricing',
      dedupeKey,
      title: `Unresolved AI model pricing: ${provider}/${model}`,
      detail: `AI usage for ${provider}/${model} has no explicit pricing registry entry. Nexus is charging Sonnet-ceiling sentinel rates until ops fixes src/services/model-pricing.ts.`,
      owner: 'ops',
      suspectedArea: 'ai_cost',
      userImpact: 'Quota enforcement remains conservative, but cost reports need registry correction.',
      runbookUrl: 'docs/MODEL-REVIEW-PROCESS.md#model-pricing-registry',
      metadata: {
        provider,
        model,
        category: input.category ?? null,
        userId: input.userId ?? null,
        sentinelInputUsdPerMillion: UNRESOLVED_MODEL_SENTINEL_PRICING.inputUsdPerMillion,
        sentinelOutputUsdPerMillion: UNRESOLVED_MODEL_SENTINEL_PRICING.outputUsdPerMillion,
      },
    });
  } catch (err) {
    logger.warn({ err, provider, model }, 'Failed to record unresolved model-pricing operator alert');
  }
}

function pruneStaleUnresolvedPricingAlertDedupeKeys(): void {
  const cutoffHour = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 13);
  for (const key of unresolvedPricingAlertDedupe) {
    const hour = key.split(':').at(-1);
    if (hour && hour < cutoffHour) {
      unresolvedPricingAlertDedupe.delete(key);
    }
  }
}

export function _resetModelPricingAlertDedupeForTests(): void {
  unresolvedPricingAlertDedupe.clear();
  unresolvedAlertCallCount = 0;
}

export function _setRecordOperatorAlertForTests(
  recorder: typeof import('./operator-alerts').recordOperatorAlert | null,
): void {
  recordOperatorAlertOverride = recorder;
}

export function estimateModelCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider?: string | null,
): number {
  return computeModelUsageCostUsd(model, { inputTokens, outputTokens }, provider).costUsd;
}
