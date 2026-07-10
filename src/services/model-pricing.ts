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
  // When true, dated snapshot names inherit this entry's pricing — but ONLY
  // when the extra suffix looks like a snapshot tag (YYYY-MM-DD, YYYYMMDD,
  // or "latest"; see VARIANT_SUFFIX_PATTERN). Arbitrary suffixes still fall
  // through to the sentinel so a hypothetical "-high-cost-variant" can never
  // silently inherit cheap pricing (review rationale:
  // docs/MODEL-REVIEW-PROCESS.md). Enabled 2026-07-03 for OpenAI entries
  // because the SDK logs response.model, which OpenAI resolves to dated
  // snapshots (e.g. gpt-4o-mini → gpt-4o-mini-2024-07-18) — those rows were
  // booking Sonnet-ceiling sentinel cost (~20x real) as pricing_status
  // 'unresolved'. Migration 221 repriced the historical rows.
  acceptVariantSuffix?: boolean;
}

// Snapshot-style suffixes that may inherit base-model pricing when
// acceptVariantSuffix is set: "2024-07-18", "20251001", "latest".
const VARIANT_SUFFIX_PATTERN = /^(\d{4}-\d{2}-\d{2}|\d{8}|latest)$/;

export interface ModelUsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-billed search/grounding/tool fees not represented by tokens. */
  nonTokenCostUsd?: number;
}

export interface ModelCostResult {
  costUsd: number;
  pricingResolved: boolean;
  pricingModelKey: string | null;
  pricing: ModelPricing | null;
}

export interface ProviderCallCostUpperBoundInput {
  provider: ModelPricingProvider;
  model: string;
  /** Exact provider request payload before network dispatch. */
  payload: unknown;
  /** Provider-enforced hard output-token cap. */
  maxOutputTokens: number;
  /** Hard upper bound for provider-billed search/grounding/tool fees. */
  nonTokenCostUpperBoundUsd?: number;
}

export type ProviderToolFeeKind =
  | 'anthropic_web_search'
  | 'openai_web_search'
  | 'gemini_grounded_prompt';

const PROVIDER_TOOL_FEE_DEFAULTS_USD: Record<ProviderToolFeeKind, number> = {
  // Official list prices verified 2026-07-09. Gemini includes a project-wide
  // free allowance, but this process cannot observe calls made outside Nexus.
  // Defaulting to the billable price is therefore the only safe hard ceiling.
  anthropic_web_search: 0.01,
  openai_web_search: 0.01,
  gemini_grounded_prompt: 0.035,
};

const PROVIDER_TOOL_FEE_ENV: Record<ProviderToolFeeKind, string> = {
  anthropic_web_search: 'ANTHROPIC_WEB_SEARCH_COST_USD_PER_REQUEST',
  openai_web_search: 'OPENAI_WEB_SEARCH_COST_USD_PER_CALL',
  gemini_grounded_prompt: 'GEMINI_GROUNDING_COST_USD_PER_PROMPT',
};

/**
 * Effective billable fee used by both preflight ceilings and api_usage truth.
 * Invalid configuration fails safely to the conservative list-price default.
 * Gemini may be configured to zero only when operations has independently
 * guaranteed that the API project remains inside its shared free allowance.
 */
export function getProviderToolFeeUsd(
  kind: ProviderToolFeeKind,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[PROVIDER_TOOL_FEE_ENV[kind]]?.trim();
  const configured = raw ? Number(raw) : Number.NaN;
  const configuredIsSafe = Number.isFinite(configured)
    && (configured > 0 || (kind === 'gemini_grounded_prompt' && configured === 0));
  return configuredIsSafe
    ? configured
    : PROVIDER_TOOL_FEE_DEFAULTS_USD[kind];
}

/** Provider-enforced cap for one OpenAI Responses web-search request. */
export function getOpenAiWebSearchMaxCalls(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.OPENAI_WEB_SEARCH_MAX_CALLS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 10
    ? configured
    : 1;
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
  { provider: 'openai', model: 'gpt-5.4-nano', inputUsdPerMillion: 0.20, outputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.02, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-5.4-mini', inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.50, cacheReadUsdPerMillion: 0.075, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-5.4', inputUsdPerMillion: 2.50, outputUsdPerMillion: 15.00, cacheReadUsdPerMillion: 0.25, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-5-nano', inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.40, cacheReadUsdPerMillion: 0.005, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-5-mini', inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.00, cacheReadUsdPerMillion: 0.025, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-5', inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.00, cacheReadUsdPerMillion: 0.125, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-4.1-mini', inputUsdPerMillion: 0.40, outputUsdPerMillion: 1.60, cacheReadUsdPerMillion: 0.10, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-4.1-nano', inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40, cacheReadUsdPerMillion: 0.025, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'o4-mini', inputUsdPerMillion: 1.10, outputUsdPerMillion: 4.40, cacheReadUsdPerMillion: 0.275, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60, cacheReadUsdPerMillion: 0.075, batchDiscount: 0.5, acceptVariantSuffix: true },
  { provider: 'openai', model: 'gpt-4o', inputUsdPerMillion: 2.50, outputUsdPerMillion: 10.00, cacheReadUsdPerMillion: 1.25, batchDiscount: 0.5, acceptVariantSuffix: true },

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

// JSON bytes are a conservative ceiling for byte-level text tokenizers: one
// token cannot encode less than one payload byte. Provider protocol framing is
// not present in the caller payload, so retain a fixed margin. Remote media can
// carry tokenized content that is not represented by URL bytes; one million
// tokens per remote item deliberately makes automation defer unless the cap
// can cover the provider's worst case. Inline/base64 media is already covered
// by serialized byte length.
const PROVIDER_PROTOCOL_OVERHEAD_TOKEN_CEILING = 2_048;
const REMOTE_MEDIA_TOKEN_CEILING = 1_000_000;

function countRemoteMediaReferences(value: unknown, seen = new Set<object>()): number {
  if (!value || typeof value !== 'object') return 0;
  if (seen.has(value as object)) return 0;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countRemoteMediaReferences(entry, seen), 0);
  }

  let count = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    const isRemoteMediaKey = normalizedKey === 'image_url'
      || normalizedKey === 'video_url'
      || normalizedKey === 'audio_url'
      || normalizedKey === 'file_uri'
      || normalizedKey === 'filedata';
    if (isRemoteMediaKey) {
      const candidate = typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? String((entry as Record<string, unknown>).url ?? (entry as Record<string, unknown>).fileUri ?? '')
          : '';
      if (/^https?:\/\//i.test(candidate)) count++;
    }
    count += countRemoteMediaReferences(entry, seen);
  }
  return count;
}

/**
 * Worst-case cost of a concrete provider request's caller-controlled input,
 * provider-enforced output cap, and explicitly supplied tool fee ceiling.
 * Provider-hosted search may inject retrieved context whose token count has no
 * contractual request cap; automation/system work must not treat this helper
 * as a hard bound for those tools and instead uses fresh signals, evergreen
 * output, or defers before provider network I/O.
 */
export function computeProviderCallCostUpperBoundUsd(
  input: ProviderCallCostUpperBoundInput,
): number {
  const maxOutputTokens = Number(input.maxOutputTokens);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 0) return Number.POSITIVE_INFINITY;
  const nonTokenCostUpperBoundUsd = Number(input.nonTokenCostUpperBoundUsd ?? 0);
  if (!Number.isFinite(nonTokenCostUpperBoundUsd) || nonTokenCostUpperBoundUsd < 0) {
    return Number.POSITIVE_INFINITY;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input.payload) ?? '';
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  const inputTokenCeiling = Buffer.byteLength(serialized, 'utf8')
    + PROVIDER_PROTOCOL_OVERHEAD_TOKEN_CEILING
    + countRemoteMediaReferences(input.payload) * REMOTE_MEDIA_TOKEN_CEILING;
  const pricing = resolveModelPricing(input.model, input.provider);
  // The sentinel keeps historical accounting conservative, but it is not a
  // contractual maximum for a future/unknown provider model. Every quota class
  // therefore fails closed before network I/O until the model is registered.
  if (!pricing) return Number.POSITIVE_INFINITY;
  const inputRate = Math.max(
    pricing.inputUsdPerMillion,
    pricing.cacheReadUsdPerMillion ?? 0,
    pricing.cacheWriteUsdPerMillion ?? 0,
  );
  const outputRate = pricing.outputUsdPerMillion;
  const upperBound = (
    inputTokenCeiling * inputRate
    + Math.ceil(maxOutputTokens) * outputRate
  ) / 1_000_000 + nonTokenCostUpperBoundUsd;
  // Round upward at sub-micro-dollar precision so floating-point truncation can
  // never turn an exact ceiling comparison into an accidental allow.
  return Math.ceil(upperBound * 1_000_000_000) / 1_000_000_000;
}

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
  // Snapshot-suffix inheritance. The suffix must be date-like or "latest"
  // (VARIANT_SUFFIX_PATTERN), which also disambiguates sibling prefixes:
  // "gpt-4o-mini-2024-07-18" cannot match the "gpt-4o" entry because the
  // remainder "mini-2024-07-18" is not a snapshot tag.
  for (const entry of MODEL_PRICING) {
    if (normalizedProvider && entry.provider !== normalizedProvider) continue;
    if (!entry.acceptVariantSuffix) continue;
    if (!normalizedModel.startsWith(`${entry.model}-`)) continue;
    const suffix = normalizedModel.slice(entry.model.length + 1);
    if (VARIANT_SUFFIX_PATTERN.test(suffix)) return entry;
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
  const nonTokenCostUsd = Number(usage.nonTokenCostUsd ?? 0);
  const safeNonTokenCostUsd = Number.isFinite(nonTokenCostUsd) && nonTokenCostUsd >= 0
    ? nonTokenCostUsd
    : 0;
  const pricing = resolveModelPricing(model, provider);
  if (!pricing) {
    const inputTokens = Math.max(0, usage.inputTokens || 0);
    const outputTokens = Math.max(0, usage.outputTokens || 0);
    const cacheReadTokens = Math.max(0, usage.cacheReadTokens || 0);
    const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens || 0);
    const regularInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const costUsd =
      ((regularInputTokens + cacheReadTokens + cacheWriteTokens) / 1_000_000) * UNRESOLVED_MODEL_SENTINEL_PRICING.inputUsdPerMillion +
      (outputTokens / 1_000_000) * UNRESOLVED_MODEL_SENTINEL_PRICING.outputUsdPerMillion +
      safeNonTokenCostUsd;
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
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion) +
    safeNonTokenCostUsd;

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
