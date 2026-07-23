// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OpenAI Provider — AIProvider implementation backed by GPT models.
 *
 * Translates between the provider-agnostic AIProvider interface and the
 * OpenAI Chat Completions API. Uses the same tool definitions and system
 * prompts as the Anthropic provider for consistency.
 *
 * Features:
 * - Token usage tracking (persisted to api_usage table, same as Anthropic)
 * - Retry on 429/5xx with exponential backoff
 */

import OpenAI from 'openai';
import {
  AIProvider,
  AICallResult,
  AIToolCall,
  AIToolResultMessage,
  CallDomainOptions,
  ClassifyOptions,
  StructuredGenerationRequest,
  StructuredGenerationResult,
  getModelRouting,
  normalizeCallDomainOptions,
} from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDomainSystemPrompt, getClassifierSystemPrompt, TOOLS } from './anthropic';
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
import { withTimeout } from '../utils/timeout';
import { getAICallTimeoutMs } from './runtime-flags';
import { buildScopedStateContextPrefix } from './provider-state-context';
import { getDomainModelOverride, type DomainModelRole } from './model-config';
import {
  computeModelUsageCostUsd,
  computeProviderCallCostUpperBoundUsd,
  getOpenAiWebSearchMaxCalls,
  getModelPricingTable,
  getProviderToolFeeUsd,
  recordUnresolvedModelPricingAlert,
} from './model-pricing';
import { settleNexusPointOverageForUser } from './nexus-points';
import {
  insertApiUsageFallback,
  recordApiUsageTimeoutEstimate,
  rethrowAiUsageFailClosedError,
  tripApiUsagePersistenceFailure,
} from './api-usage-fallback';
import { resolveApiUsageAttribution } from './api-usage-attribution';
import { assertAiBudgetReservationForProvider } from './cost-guardrail';

// ─── Client (lazy init — only created if API key is set) ────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    // Retry loops in this module re-run the provider budget boundary before
    // every attempt. Disable opaque SDK retries so no network retry can bypass
    // that fresh daily/monthly/automation headroom decision.
    _client = new OpenAI({ apiKey: config.openai.apiKey, maxRetries: 0 });
  }
  return _client;
}

/** Check if OpenAI is configured (has API key) */
export function isOpenAIConfigured(): boolean {
  return !!config.openai.apiKey;
}

// ─── Cost per million tokens (update when OpenAI changes rates) ─────

export const OPENAI_COST_PER_MTK: Record<string, { in: number; out: number }> = {
  ...Object.fromEntries(
    getModelPricingTable()
      .filter((entry) => entry.provider === 'openai')
      .map((entry) => [entry.model, { in: entry.inputUsdPerMillion, out: entry.outputUsdPerMillion }]),
  ),
};

type OpenAINonStreamingParams = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  max_completion_tokens?: number;
};

type OneShotOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  userId?: number;
  tenantId?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
  /** Optional caller-specific retry cap for latency-bounded workflows. */
  maxRetries?: number;
};

const warnedUnresolvedModels = new Set<string>();

function warnUnresolvedOpenAiPricing(model: string, category: string, userId: number): void {
  const key = `${model}:${category}`;
  if (warnedUnresolvedModels.has(key)) return;
  warnedUnresolvedModels.add(key);
  recordUnresolvedModelPricingAlert({ provider: 'openai', model, category, userId });
}

function usesCompletionTokenCap(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4');
}

function withTokenLimit<T extends { model: string }>(
  params: T,
  maxTokens: number,
): T & { max_tokens?: number; max_completion_tokens?: number } {
  if (usesCompletionTokenCap(params.model)) {
    return { ...params, max_completion_tokens: maxTokens };
  }
  return { ...params, max_tokens: maxTokens };
}

// ─── Token tracking ─────────────────────────────────────────────────

/**
 * Wrapper that records usage metrics for every OpenAI API call.
 * Writes to api_usage table and pushes telemetry event.
 *
 * April 9 2026: added `userId` parameter + persisted it in the INSERT.
 * Previously `trackedCompletion` had the same latent bug as Anthropic
 * and Gemini — the `user_id` column existed in `api_usage` (from
 * migration 029) but was never written, so per-user cost attribution
 * for OpenAI calls showed user_id=0 for everyone. Fixed at the same
 * time as the Anthropic kill switch was added so new OpenAI traffic
 * (from the Gemini fallback path) is attributed correctly from day one.
 */
async function trackedCompletion(
  client: OpenAI,
  params: OpenAINonStreamingParams,
  category: string,
  userId: number = 0,
  tenantId: number = userId,
  timeoutMs?: number,
): Promise<OpenAI.ChatCompletion> {
  const AI_CALL_TIMEOUT_MS = timeoutMs ?? getAICallTimeoutMs();

  const maxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'openai',
    model: params.model,
    payload: params,
    maxOutputTokens: Number(
      (params as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens
      ?? (params as { max_tokens?: number }).max_tokens
      ?? Number.POSITIVE_INFINITY,
    ),
  });
  assertAiBudgetReservationForProvider({
    userId,
    category,
    provider: 'openai',
    model: params.model,
    maxCostUsd,
  });
  const start = Date.now();
  const response = await withTimeout(
    client.chat.completions.create(params),
    AI_CALL_TIMEOUT_MS,
    {
      onTimeout: () => {
        const apiUsageId = recordApiUsageTimeoutEstimate({
          category,
          model: params.model,
          provider: 'openai',
          tenantId,
          userId,
          maxCostUsd,
          timeoutMs: AI_CALL_TIMEOUT_MS,
        });
        void settleNexusPointOverageForUser(userId, apiUsageId).catch((settleErr) => {
          logger.warn({ err: settleErr, apiUsageId, category }, 'nexus_points: OpenAI timeout estimate settlement failed');
        });
      },
    },
  );
  const durationMs = Date.now() - start;

  const usage = response.usage;
  if (
    !usage
    || !Number.isFinite(usage.prompt_tokens)
    || usage.prompt_tokens < 0
    || !Number.isFinite(usage.completion_tokens)
    || usage.completion_tokens < 0
    || (usage.prompt_tokens_details?.cached_tokens != null
      && (!Number.isFinite(usage.prompt_tokens_details.cached_tokens) || usage.prompt_tokens_details.cached_tokens < 0))
  ) {
    const persistenceError = tripApiUsagePersistenceFailure('openai', category);
    logger.error({ code: persistenceError.code, category, model: response.model || params.model }, 'OpenAI response omitted valid usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  if (usage) {
    const model = response.model || params.model;
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const priced = computeModelUsageCostUsd(model, {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cacheReadTokens,
    }, 'openai');
    if (!priced.pricingResolved) {
      warnUnresolvedOpenAiPricing(model, category, userId);
    }
    const costUsd = priced.costUsd;
    const pricingStatus = priced.pricingResolved ? 'resolved' : 'unresolved';
    const attribution = resolveApiUsageAttribution(category, userId);
    let apiUsageId: number | null = null;

    try {
      const db = getDb();
      const result = db.prepare(`
        INSERT INTO api_usage (category, model, tenant_id, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider, pricing_status, pricing_model_key, request_source, job_name, base_category, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).run(category, model, tenantId, userId, usage.prompt_tokens, usage.completion_tokens, cacheReadTokens, costUsd, durationMs, pricingStatus, priced.pricingModelKey, attribution.requestSource, attribution.jobName, attribution.baseCategory, attribution.runId);
      apiUsageId = Number((result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0);
    } catch (e) {
      try {
        const db = getDb();
        apiUsageId = insertApiUsageFallback(db, {
          category,
          model,
          provider: 'openai',
          tenantId,
          userId,
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
          costUsd,
          durationMs,
          pricingStatus: 'legacy',
        });
      } catch (fallbackErr) {
        const persistenceError = tripApiUsagePersistenceFailure('openai', category);
        logger.error({ err: fallbackErr, code: persistenceError.code }, 'Failed to log OpenAI usage; AI usage persistence degraded');
        throw persistenceError;
      }
    }

    try {
      pushEvent({
        ts: new Date().toISOString(),
        type: 'api_call',
        summary: `OpenAI ${model} [${category}] — ${usage.prompt_tokens}+${usage.completion_tokens} tokens`,
        detail: `$${costUsd.toFixed(4)} in ${durationMs}ms`,
      });
    } catch (eventErr) {
      logger.warn({ err: eventErr, userId, category }, 'Failed to publish OpenAI usage telemetry');
    }
    // April 2026 follow-up: per-user metering for OpenAI mirrors
    // anthropic-hook and gemini-provider so quota enforcement sees
    // every provider's traffic, not only the disabled Anthropic path.
    try {
      const { recordUsage } = require('./usage-metering') as typeof import('./usage-metering');
      recordUsage(userId, usage.prompt_tokens, usage.completion_tokens, costUsd, false);
    } catch (meterErr) {
      logger.warn({ err: meterErr, userId }, 'Failed to record OpenAI usage_metering');
    }
    try {
      await settleNexusPointOverageForUser(userId, apiUsageId);
    } catch (settleErr) {
      logger.warn({ err: settleErr, apiUsageId, userId }, 'nexus_points: OpenAI usage settlement failed');
    }
  }

  return response;
}

// ═══════════════════════════════════════════════════════════════════
// ONE-SHOT HELPERS — added April 9 2026 to mirror Gemini's shape
// ═══════════════════════════════════════════════════════════════════
//
// These exports give the Gemini fallback wrappers a shape-compatible
// OpenAI implementation they can call without building an OpenAI
// prompt from scratch. The contract matches `gemini-provider`'s
// `completeOneShot` / `completeVisionOneShot` exactly so the fallback
// wrappers can swap providers without special-casing either one.
//
// Why helpers instead of reusing `OpenAIProvider.callDomain`:
//   • `callDomain` is heavy — it builds the system prompt via the
//     domain router, applies per-domain tool packs, maps message
//     history. The fallback wrappers want a SIMPLE one-shot: system
//     prompt + user prompt in, text out. No tools, no history.
//   • The AIProvider interface evolved for the domain-routed path.
//     The fallback path has different requirements (single call, no
//     conversation state, explicit category for cost attribution).

/**
 * Single-prompt chat completion via OpenAI. Mirrors the Gemini provider's
 * `completeOneShot` in shape so the fallback wrappers can swap providers
 * transparently.
 *
 * Default model is `gpt-4o-mini` because most fallback paths are
 * classification + summarization calls where the quality difference
 * vs full `gpt-4o` doesn't justify the 16× cost multiplier. Callers
 * that need gpt-4o quality can override via `options.model`.
 *
 * Throws on OpenAI errors so the caller can report a hard failure.
 */
export async function completeOneShot(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  options?: OneShotOptions,
): Promise<string> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');
  }
  const model = options?.model ?? 'gpt-4o-mini';
  const maxTokens = options?.maxTokens ?? 2500;
  const temperature = options?.temperature ?? 0.7;

  const response = await withRetry(
    () => trackedCompletion(
      getClient(),
      withTokenLimit({
        model,
        temperature,
        ...(options?.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }, maxTokens),
      category,
      options?.userId ?? 0,
      options?.tenantId ?? options?.userId ?? 0,
      options?.timeoutMs,
    ),
    normalizeRetryCount(options?.maxRetries, 3),
  );

  return response.choices[0]?.message?.content ?? '';
}

export async function completeOneShotWithWebSearch(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  options?: OneShotOptions,
): Promise<{ text: string; sources: string[] }> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');
  }
  const model = options?.model ?? process.env.OPENAI_WEB_SEARCH_MODEL ?? 'gpt-4o-mini';
  const maxOutputTokens = options?.maxTokens ?? 900;
  const maxToolCalls = getOpenAiWebSearchMaxCalls();
  const request = {
    model,
    instructions: systemPrompt,
    input: userPrompt,
    // `low` limits retrieved context for cost/latency, while max_tool_calls
    // below bounds the separately billed search action. Provider-hosted search
    // context is still not a contractual token ceiling, so automation callers
    // must use deterministic fresh signals or evergreen generation instead.
    tools: [{ type: 'web_search', search_context_size: 'low' }],
    tool_choice: 'auto',
    max_output_tokens: maxOutputTokens,
    max_tool_calls: maxToolCalls,
  } as any;
  const maxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'openai',
    model,
    payload: request,
    maxOutputTokens,
    nonTokenCostUpperBoundUsd:
      maxToolCalls * getProviderToolFeeUsd('openai_web_search'),
  });
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? getAICallTimeoutMs();
  const response = await withRetry(() => {
    assertAiBudgetReservationForProvider({
      userId: options?.userId ?? 0,
      category,
      provider: 'openai',
      model,
      maxCostUsd,
      hasUnboundedProviderInjectedContext: true,
    });
    return withTimeout(
      getClient().responses.create(request, { maxRetries: 0 }),
      timeoutMs,
      {
        onTimeout: () => {
          const apiUsageId = recordApiUsageTimeoutEstimate({
            category,
            model,
            provider: 'openai',
            tenantId: options?.tenantId ?? options?.userId ?? 0,
            userId: options?.userId ?? 0,
            maxCostUsd,
            timeoutMs,
            providerToolCostUsd:
              maxToolCalls * getProviderToolFeeUsd('openai_web_search'),
            webSearchRequests: maxToolCalls,
          });
          void settleNexusPointOverageForUser(options?.userId ?? 0, apiUsageId).catch((settleErr) => {
            logger.warn({ err: settleErr, apiUsageId, category }, 'nexus_points: OpenAI search timeout estimate settlement failed');
          });
        },
      },
    );
  }) as any;
  const webSearchRequests = countOpenAiWebSearchCalls(response);

  await recordOpenAIResponseUsage({
    response,
    model: String(response?.model ?? model),
    category,
    userId: options?.userId ?? 0,
    tenantId: options?.tenantId ?? options?.userId ?? 0,
    durationMs: Date.now() - startedAt,
    nonTokenCostUsd:
      webSearchRequests * getProviderToolFeeUsd('openai_web_search'),
    webSearchRequests,
  });

  const text = extractOpenAIResponseText(response);
  if (!text) {
    throw new Error('openai_web_search_empty_response');
  }
  return {
    text,
    sources: collectHttpUrlsFromUnknown(response),
  };
}

function countOpenAiWebSearchCalls(response: unknown): number {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return 0;
  return output.filter((item) => (
    item != null
    && typeof item === 'object'
    && (item as { type?: unknown }).type === 'web_search_call'
  )).length;
}

/**
 * Single-prompt chat completion with an image input (vision mode) via
 * GPT-4o. Mirrors `gemini-provider.completeVisionOneShot`.
 *
 * GPT-4o expects images as `{ type: 'image_url', image_url: { url } }`
 * where the url is a base64 data URL. We build it from the passed
 * `image.base64` + `image.mimeType`, then send the standard chat
 * completion with the image bundled into the user message content.
 *
 * The classifier-tier `gpt-4o-mini` DOES support vision as of 2026-04,
 * and costs roughly 10× less than `gpt-4o`, so that's the default.
 * Override via `options.model` if you need higher quality.
 *
 * Throws on OpenAI errors so the caller can report a hard failure.
 */
export async function completeVisionOneShot(
  systemPrompt: string,
  userPrompt: string,
  image: { base64: string; mimeType: string },
  category: string,
  options?: { model?: string; maxTokens?: number; temperature?: number; userId?: number; tenantId?: number },
): Promise<string> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');
  }
  const model = options?.model ?? 'gpt-4o-mini';
  const maxTokens = options?.maxTokens ?? 1024;
  const temperature = options?.temperature ?? 0.2; // low — vision callers typically want structured JSON

  const dataUrl = `data:${image.mimeType};base64,${image.base64}`;

  const response = await withRetry(() =>
    trackedCompletion(
      getClient(),
      withTokenLimit({
        model,
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: userPrompt },
            ],
          },
        ],
      }, maxTokens),
      category,
      options?.userId ?? 0,
      options?.tenantId ?? options?.userId ?? 0,
    ),
  );

  return response.choices[0]?.message?.content ?? '';
}

async function recordOpenAIResponseUsage(input: {
  response: any;
  model: string;
  category: string;
  userId: number;
  tenantId: number;
  durationMs: number;
  nonTokenCostUsd?: number;
  webSearchRequests?: number;
}): Promise<void> {
  const usage = input.response?.usage;
  if (!usage || typeof usage !== 'object') {
    const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
    logger.error({ code: persistenceError.code, category: input.category, model: input.model }, 'OpenAI Responses API omitted usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  const inputTokens = numberFromUnknown(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = numberFromUnknown(usage.output_tokens ?? usage.completion_tokens);
  if (inputTokens === null || inputTokens < 0 || outputTokens === null || outputTokens < 0) {
    const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
    logger.error({ code: persistenceError.code, category: input.category, model: input.model }, 'OpenAI Responses API returned invalid usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  const cacheReadTokens = numberFromUnknown(usage.input_tokens_details?.cached_tokens) ?? 0;
  const priced = computeModelUsageCostUsd(input.model, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    nonTokenCostUsd: input.nonTokenCostUsd ?? 0,
  }, 'openai');
  if (!priced.pricingResolved) {
    warnUnresolvedOpenAiPricing(input.model, input.category, input.userId);
  }
  let apiUsageId: number | null = null;
  const attribution = resolveApiUsageAttribution(input.category, input.userId);
  try {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO api_usage (category, model, tenant_id, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider, pricing_status, pricing_model_key, request_source, job_name, base_category, run_id, provider_tool_cost_usd, web_search_requests, grounded_search_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      input.category,
      input.model,
      input.tenantId,
      input.userId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      priced.costUsd,
      input.durationMs,
      priced.pricingResolved ? 'resolved' : 'unresolved',
      priced.pricingModelKey,
      attribution.requestSource,
      attribution.jobName,
      attribution.baseCategory,
      attribution.runId,
      input.nonTokenCostUsd ?? 0,
      input.webSearchRequests ?? 0,
    );
    apiUsageId = Number((result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0);
  } catch (err) {
    try {
      const db = getDb();
      apiUsageId = insertApiUsageFallback(db, {
        category: input.category,
        model: input.model,
        provider: 'openai',
        tenantId: input.tenantId,
        userId: input.userId,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        costUsd: priced.costUsd,
        durationMs: input.durationMs,
        pricingStatus: 'legacy',
        providerToolCostUsd: input.nonTokenCostUsd ?? 0,
        webSearchRequests: input.webSearchRequests ?? 0,
        groundedSearchPrompts: 0,
      });
    } catch (fallbackErr) {
      const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
      logger.error({ err: fallbackErr, code: persistenceError.code }, 'Failed to log OpenAI Responses usage; AI usage persistence degraded');
      throw persistenceError;
    }
  }
  try {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `OpenAI ${input.model} [${input.category}] — ${inputTokens}+${outputTokens} tokens`,
      detail: `$${priced.costUsd.toFixed(4)} in ${input.durationMs}ms`,
    });
  } catch (eventErr) {
    logger.warn({ err: eventErr, userId: input.userId, category: input.category }, 'Failed to publish OpenAI Responses usage telemetry');
  }
  // Analytics remains calendar-aligned in usage_metering, while api_usage
  // above is the sole blocking truth. Keep this best-effort and outside the
  // INSERT fallback catch so an analytics failure cannot duplicate quota rows.
  try {
    const { recordUsage } = require('./usage-metering') as typeof import('./usage-metering');
    recordUsage(input.userId, inputTokens, outputTokens, priced.costUsd, false);
  } catch (meterErr) {
    logger.warn({ err: meterErr, userId: input.userId }, 'Failed to record OpenAI Responses usage_metering');
  }
  await settleNexusPointOverageForUser(input.userId, apiUsageId).catch((settleErr) => {
    logger.warn({ err: settleErr, apiUsageId, userId: input.userId }, 'nexus_points: OpenAI Responses usage settlement failed');
  });
}

function extractOpenAIResponseText(response: any): string {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks: string[] = [];
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string') chunks.push(block.text);
    }
  }
  return chunks.join('\n').trim();
}

function collectHttpUrlsFromUnknown(value: unknown, urls = new Set<string>()): string[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s)"'<>]+/gi)) {
      urls.add(match[0].replace(/[),.;\]]+$/g, ''));
    }
    return [...urls];
  }
  if (!value || typeof value !== 'object') return [...urls];
  if (Array.isArray(value)) {
    for (const entry of value) collectHttpUrlsFromUnknown(entry, urls);
    return [...urls];
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if ((key === 'url' || key === 'uri') && typeof entry === 'string' && /^https?:\/\//i.test(entry)) {
      urls.add(entry);
    }
    collectHttpUrlsFromUnknown(entry, urls);
  }
  return [...urls];
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ─── Retry on 429 / 5xx ─────────────────────────────────────────────

/** Injectable sleep — override `.fn` in tests to avoid real setTimeout waits. */
export const _sleep = { fn: (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)) };

/**
 * Retry on OpenAI rate limit (429) and transient server errors (500, 502, 503).
 * Uses exponential backoff with jitter. Max 3 retries.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number }; headers?: Record<string, string> };
      const status = e?.status ?? e?.response?.status;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503;

      if (!isRetryable || attempt === maxRetries) throw err;

      const retryAfter = e?.headers?.['retry-after'];
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : (2 ** attempt) * 1000 + Math.random() * 500;

      logger.warn({ status, attempt, waitMs }, 'OpenAI retryable error, backing off');
      await _sleep.fn(waitMs);
    }
  }
  throw new Error('withRetry: unreachable');
}

function normalizeRetryCount(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(3, Math.floor(value));
}

// ─── Tool format conversion ─────────────────────────────────────────

/**
 * Convert Anthropic-format tool definitions to OpenAI function-calling format.
 */
function toOpenAITools(
  filteredTools: unknown[] | undefined,
  context = 'OpenAI domain call',
  allowLegacyFullTools = false,
): OpenAI.ChatCompletionTool[] {
  if (!Array.isArray(filteredTools) && !allowLegacyFullTools) {
    throw new Error(`${context} requires explicit filteredTools; pass [] for no tools or TOOLS for the full set`);
  }
  const sourceTools = (Array.isArray(filteredTools) ? filteredTools : TOOLS) as Array<{
    name?: unknown;
    description?: unknown;
    input_schema?: unknown;
  }>;
  return sourceTools
    .filter((t): t is { name: string; description?: string; input_schema?: unknown } => (
      typeof t?.name === 'string' && t.name.trim().length > 0
    ))
    .map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

function resolveOpenAIModel(
  domain: DomainName,
  tier?: 'heavy' | 'light',
): { model: string; maxTokens: number } {
  const domainOverride = getDomainModelOverride('openai', domain as DomainModelRole);
  if (domainOverride) {
    return {
      model: domainOverride,
      maxTokens: domain === 'secretary' ? config.openai.secretaryMaxTokens
        : domain === 'triathlon' ? 2048
        : config.openai.maxTokens,
    };
  }

  if (tier === 'light') {
    return {
      model: config.openai.classifierModel,
      maxTokens: domain === 'secretary' || domain === 'triathlon' ? 2048 : config.openai.maxTokens,
    };
  }
  if (tier === 'heavy') {
    return {
      model: config.openai.model,
      maxTokens: domain === 'secretary' ? config.openai.secretaryMaxTokens : config.openai.maxTokens,
    };
  }

  return getModelRouting(config.openai, domain, 'openai');
}

// ─── Response parsing helpers ───────────────────────────────────────

function extractToolCalls(
  choices: OpenAI.ChatCompletion.Choice[],
): AIToolCall[] {
  const choice = choices[0];
  if (!choice?.message?.tool_calls) return [];

  return choice.message.tool_calls
    .filter((tc) => tc.type === 'function')
    .map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.function.name,
      input: safeParse(tc.function.arguments),
    }));
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ─── Provider Implementation ────────────────────────────────────────

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  /**
   * Isolated no-tools completion for privacy-gated cloud reasoning. The
   * routing layer supplies the exact approved model and validates any schema
   * again after the response; this adapter only maps the request to the SDK.
   */
  async callStructuredGeneration(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    if (!/^(?:gpt|chatgpt|o[1-9])(?:[-.:]|$)/i.test(request.model)) {
      throw new Error('OpenAI structured generation requires an OpenAI model');
    }
    const responseFormat = request.responseFormat === 'json'
      ? (request.jsonSchema !== undefined
        && request.jsonSchema !== null
        && typeof request.jsonSchema === 'object'
        && !Array.isArray(request.jsonSchema)
        ? {
          type: 'json_schema' as const,
          json_schema: {
            name: 'nexus_cloud_local_reasoning',
            strict: false,
            schema: request.jsonSchema as Record<string, unknown>,
          },
        }
        : { type: 'json_object' as const })
      : undefined;
    const response = await withRetry(() => trackedCompletion(
      getClient(),
      withTokenLimit({
        model: request.model,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }, request.maxTokens),
      request.category,
      request.userId,
      request.tenantId,
    ));
    const choice = response.choices[0];
    return {
      text: choice?.message?.content ?? '',
      stopReason: choice?.finish_reason ?? 'stop',
    };
  }

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    // O3-A11/F-new-6: ClassifyOptions must carry user attribution for
    // routed classify calls. Without this, OpenAI fallback classify rows
    // silently fall back to user_id=0 / tenant_id=0.
    const usageUserId = options?.userId ?? 0;
    const usageTenantId = options?.tenantId ?? options?.userId ?? 0;
    try {
      let userContent = message;
      if (activeContext) {
        userContent = `[ACTIVE CONVERSATION — domain: "${activeContext.domain}"]
Last assistant message: "${activeContext.lastAssistantMessage.substring(0, 300)}"

[NEW USER MESSAGE]
${message}`;
      }

      const response = await withRetry(() =>
        trackedCompletion(getClient(), withTokenLimit({
          model: config.openai.classifierModel,
          messages: [
            { role: 'system', content: getClassifierSystemPrompt() },
            { role: 'user', content: userContent },
          ],
        }, 100), 'openai_classify', usageUserId, usageTenantId, options?.timeoutMs)
      );

      let text = response.choices[0]?.message?.content || '';
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(text);
      const domain = parsed.domain as DomainName;
      const confidence = parsed.confidence as number;

      if (confidence < 0.6) return { domain: 'secretary', confidence };
      return { domain, confidence };
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      logger.error({ err }, 'OpenAI classification failed, defaulting to secretary');
      return { domain: 'secretary', confidence: 0 };
    }
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    const opts = normalizeCallDomainOptions(optionsOrMaxTokens);
    // v2: honor options.modelOverride (set by cloud-reasoning-gate so the
    // approved reasoning model is actually used).
    const baseRouting = resolveOpenAIModel(domain, opts.modelTier);
    const routing = opts.modelOverride
      ? { model: opts.modelOverride, maxTokens: baseRouting.maxTokens }
      : baseRouting;
    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const allowLegacyFullTools = optionsOrMaxTokens == null || typeof optionsOrMaxTokens === 'number';
    const tools = useTools ? toOpenAITools(opts.filteredTools, 'OpenAI callDomain', allowLegacyFullTools) : [];
    const contextPrefix = buildScopedStateContextPrefix(stateContext);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ];

    const response = await withRetry(() =>
      trackedCompletion(getClient(), withTokenLimit({
        model: routing.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }, opts.maxTokensOverride || routing.maxTokens), `openai_domain_${domain}`, opts.userId ?? 0, opts.tenantId ?? opts.userId ?? 0)
    );

    const choice = response.choices[0];
    return {
      text: choice?.message?.content || '',
      toolCalls: extractToolCalls(response.choices),
      stopReason: choice?.finish_reason || 'stop',
    };
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
    options?: CallDomainOptions,
  ): Promise<AICallResult> {
    const opts = normalizeCallDomainOptions(options);
    // v2: honor options.modelOverride (set by cloud-reasoning-gate so the
    // approved reasoning model is actually used).
    const baseRouting = resolveOpenAIModel(domain, opts.modelTier);
    const routing = opts.modelOverride
      ? { model: opts.modelOverride, maxTokens: baseRouting.maxTokens }
      : baseRouting;
    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const tools = useTools ? toOpenAITools(opts.filteredTools, 'OpenAI continueWithToolResults', options == null) : [];
    const contextPrefix = buildScopedStateContextPrefix(stateContext);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ];

    // Append tool conversation in OpenAI format
    for (const msg of toolConversation) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const textParts = (msg.content as any[]).filter((b: any) => b.type === 'text');
        const toolUses = (msg.content as any[]).filter((b: any) => b.type === 'tool_use');
        messages.push({
          role: 'assistant',
          content: textParts.map((b: any) => b.text).join('') || null,
          tool_calls: toolUses.map((tc: any) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input || {}),
            },
          })),
        } as OpenAI.ChatCompletionMessageParam);
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const result of msg.content as any[]) {
          if (result.type === 'tool_result') {
            messages.push({
              role: 'tool',
              tool_call_id: result.tool_use_id,
              content: result.content,
            });
          }
        }
      }
    }

    const response = await withRetry(() =>
      trackedCompletion(getClient(), withTokenLimit({
        model: routing.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }, opts.maxTokensOverride || routing.maxTokens), 'openai_tool_continuation', opts.userId ?? 0, opts.tenantId ?? opts.userId ?? 0)
    );

    const choice = response.choices[0];
    return {
      text: choice?.message?.content || '',
      toolCalls: extractToolCalls(response.choices),
      stopReason: choice?.finish_reason || 'stop',
    };
  }

}
