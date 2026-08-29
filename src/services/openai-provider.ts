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

import crypto from 'node:crypto';
import OpenAI, { toFile } from 'openai';
import {
  AIProvider,
  AICallResult,
  AIToolCall,
  AIToolResultMessage,
  CallDomainOptions,
  ClassifyOptions,
  StructuredGenerationRequest,
  StructuredGenerationResult,
  StructuredGenerationBatchCancellationRequest,
  StructuredGenerationBatchFileCleanupRequest,
  StructuredGenerationBatchIntentReconciliationRequest,
  StructuredGenerationBatchIntentReconciliationResult,
  getModelRouting,
  isProviderRequestCancellation,
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
import { resolveManifestClassifierDisposition } from '../router/classifier-prompt-builder';
import {
  contentFreeOpenAIBatchError,
  replaceContentFreeOpenAIBatchError,
} from './openai-batch-diagnostics';

// ─── Client (lazy init — only created if API key is set) ────────────

let _client: OpenAI | null = null;
let _batchClient: OpenAI | null = null;
const SILENT_OPENAI_LOGGER = {
  error: (_message: string, ..._rest: unknown[]) => undefined,
  warn: (_message: string, ..._rest: unknown[]) => undefined,
  info: (_message: string, ..._rest: unknown[]) => undefined,
  debug: (_message: string, ..._rest: unknown[]) => undefined,
};

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

function getBatchClient(): OpenAI {
  if (!config.openai.batchApiKey || !config.openai.batchProjectId) return getClient();
  if (!_batchClient) {
    _batchClient = new OpenAI({
      apiKey: config.openai.batchApiKey,
      project: config.openai.batchProjectId,
      maxRetries: 0,
    });
  }
  return _batchClient;
}

function getOpenAIBatchClients(): OpenAI[] {
  const primary = getBatchClient();
  const legacy = getClient();
  return primary === legacy ? [primary] : [primary, legacy];
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

type OpenAIDirectServiceTier = 'default' | 'flex' | 'priority';

function openAIServiceTierCostMultiplier(serviceTier: unknown): number {
  if (serviceTier === 'flex' || serviceTier === 'batch') return 0.5;
  if (serviceTier === 'priority') return 2;
  return 1;
}

const OPENAI_BATCH_POLL_INTERVAL_MS = 15_000;
const OPENAI_BATCH_FILE_READY_POLL_INTERVAL_MS = 1_000;
const OPENAI_BATCH_FILE_READY_REQUEST_TIMEOUT_MS = 5_000;
const OPENAI_BATCH_FILE_READY_MAX_WAIT_MS = 2 * 60 * 1_000;
const OPENAI_BATCH_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const OPENAI_BATCH_RECONCILIATION_PAGE_SIZE = 100;
const OPENAI_BATCH_RECONCILIATION_MAX_PAGES = 5;
const OPENAI_BATCH_BODY_KEYS = new Set([
  'model', 'messages', 'max_completion_tokens', 'max_tokens', 'response_format',
  'reasoning_effort',
]);

function openAIBatchInputJsonl(
  customId: string,
  body: Record<string, unknown>,
  options: { allowLegacyGpt56ReasoningOmission?: boolean } = {},
): string {
  const messages = body.messages;
  const tokenFields = ['max_completion_tokens', 'max_tokens']
    .filter((field) => Object.hasOwn(body, field));
  const validMessages = Array.isArray(messages) && messages.length === 2
    && messages.every((message) => message !== null
      && typeof message === 'object' && !Array.isArray(message)
      && typeof (message as { content?: unknown }).content === 'string')
    && ['system', 'developer'].includes(String((messages[0] as { role?: unknown }).role))
    && (messages[1] as { role?: unknown }).role === 'user';
  const tokenLimit = tokenFields.length === 1 ? body[tokenFields[0]!] : undefined;
  const reasoningEffort = body.reasoning_effort;
  const hasReasoningEffort = Object.hasOwn(body, 'reasoning_effort');
  const gpt56Model = isGpt56Model(body.model);
  if (!/^[0-9a-f]{64}$/u.test(customId)
      || typeof body.model !== 'string' || body.model.length < 1 || body.model.length > 120
      || Object.keys(body).some((key) => !OPENAI_BATCH_BODY_KEYS.has(key))
      || !validMessages
      || !Number.isSafeInteger(tokenLimit) || Number(tokenLimit) < 1 || Number(tokenLimit) > 1_000_000
      || (gpt56Model && !hasReasoningEffort && !options.allowLegacyGpt56ReasoningOmission)
      || (hasReasoningEffort && (!gpt56Model || reasoningEffort !== 'none'))
      || (Object.hasOwn(body, 'response_format')
        && (body.response_format === null || typeof body.response_format !== 'object'
          || Array.isArray(body.response_format)))) {
    throw batchError(
      'OPENAI_BATCH_INPUT_ENVELOPE_INVALID',
      'OpenAI Batch input envelope failed local structural validation.',
    );
  }
  return `${JSON.stringify({
    custom_id: customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body,
  })}\n`;
}

export const _openAIBatchSleep = {
  resetClients: (): void => {
    _client = null;
    _batchClient = null;
  },
  fn: (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error('OpenAI Batch cancelled'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? Object.assign(new Error('OpenAI Batch cancelled'), { name: 'AbortError' }));
    }, { once: true });
  }),
};

const GPT_56_LONG_CONTEXT_INPUT_TOKENS = 272_000;

function isGpt56Model(model: unknown): boolean {
  return /^gpt-5\.6(?:[-.:]|$)/i.test(String(model || '').trim());
}

function openAIBatchInstructionRole(model: unknown): 'system' | 'developer' {
  // OpenAI's current Chat Completions contract uses developer messages in
  // place of legacy system messages for o1 and newer reasoning models. Keep
  // older models on their established role while aligning GPT-5.6 Batch JSONL
  // with the provider's model-specific validation contract.
  return isGpt56Model(model) ? 'developer' : 'system';
}

function openAIContextRateMultipliers(model: string, inputTokens: number): {
  inputRateMultiplier: number;
  outputRateMultiplier: number;
} {
  return isGpt56Model(model) && inputTokens > GPT_56_LONG_CONTEXT_INPUT_TOKENS
    ? { inputRateMultiplier: 2, outputRateMultiplier: 1.5 }
    : { inputRateMultiplier: 1, outputRateMultiplier: 1 };
}

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
  /** Caller cancellation prevents SDK retries and later provider fallback. */
  abortSignal?: AbortSignal;
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
  abortSignal?: AbortSignal,
): Promise<OpenAI.ChatCompletion> {
  const AI_CALL_TIMEOUT_MS = timeoutMs ?? getAICallTimeoutMs();

  const baseMaxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'openai',
    model: params.model,
    payload: params,
    maxOutputTokens: Number(
      (params as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens
      ?? (params as { max_tokens?: number }).max_tokens
      ?? Number.POSITIVE_INFINITY,
    ),
  });
  // An explicit tier is verified only after the billable provider response.
  // Reserve the most expensive direct tier so an unexpected tier cannot make
  // an already-incurred call exceed the caller's budget boundary.
  // GPT-5.6 switches to a 2x input / 1.5x output schedule above 272K input.
  // The exact provider token count is unavailable before dispatch, so reserve
  // the 2x ceiling for every GPT-5.6 request.
  const contextCeilingMultiplier = isGpt56Model(params.model) ? 2 : 1;
  const maxCostUsd = baseMaxCostUsd
    * contextCeilingMultiplier
    * (params.service_tier ? 2 : 1);
  assertAiBudgetReservationForProvider({
    userId,
    category,
    provider: 'openai',
    model: params.model,
    maxCostUsd,
  });
  const start = Date.now();
  const response = await withTimeout(
    client.chat.completions.create(
      params,
      abortSignal ? { maxRetries: 0, signal: abortSignal } : undefined,
    ),
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
          logger.warn({
            errorName: settleErr instanceof Error ? settleErr.name : typeof settleErr,
            apiUsageId,
            category,
          }, 'nexus_points: OpenAI timeout estimate settlement failed');
        });
      },
    },
  );
  const durationMs = Date.now() - start;

  const usage = response.usage;
  const promptTokenDetails = usage?.prompt_tokens_details as ({
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  } | undefined);
  const cacheReadTokens = promptTokenDetails?.cached_tokens ?? 0;
  const cacheWriteTokens = promptTokenDetails?.cache_write_tokens ?? 0;
  if (
    !usage
    || !Number.isFinite(usage.prompt_tokens)
    || usage.prompt_tokens < 0
    || !Number.isFinite(usage.completion_tokens)
    || usage.completion_tokens < 0
    || !Number.isFinite(cacheReadTokens)
    || cacheReadTokens < 0
    || !Number.isFinite(cacheWriteTokens)
    || cacheWriteTokens < 0
    || cacheReadTokens + cacheWriteTokens > usage.prompt_tokens
  ) {
    const persistenceError = tripApiUsagePersistenceFailure('openai', category);
    logger.error({ code: persistenceError.code, category, model: response.model || params.model }, 'OpenAI response omitted valid usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  if (usage) {
    const model = response.model || params.model;
    const contextRates = openAIContextRateMultipliers(model, usage.prompt_tokens);
    const priced = computeModelUsageCostUsd(model, {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...contextRates,
    }, 'openai');
    if (!priced.pricingResolved) {
      warnUnresolvedOpenAiPricing(model, category, userId);
    }
    const costUsd = priced.costUsd
      * openAIServiceTierCostMultiplier(response.service_tier ?? params.service_tier);
    const pricingStatus = priced.pricingResolved ? 'resolved' : 'unresolved';
    const attribution = resolveApiUsageAttribution(category, userId);
    let apiUsageId: number | null = null;

    try {
      const db = getDb();
      const result = db.prepare(`
        INSERT INTO api_usage (category, model, tenant_id, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider, pricing_status, pricing_model_key, request_source, job_name, base_category, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).run(category, model, tenantId, userId, usage.prompt_tokens, usage.completion_tokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs, pricingStatus, priced.pricingModelKey, attribution.requestSource, attribution.jobName, attribution.baseCategory, attribution.runId);
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
          cacheWriteTokens,
          costUsd,
          durationMs,
          pricingStatus: 'legacy',
        });
      } catch (fallbackErr) {
        const persistenceError = tripApiUsagePersistenceFailure('openai', category);
        logger.error({
          errorName: fallbackErr instanceof Error ? fallbackErr.name : typeof fallbackErr,
          code: persistenceError.code,
        }, 'Failed to log OpenAI usage; AI usage persistence degraded');
        throw persistenceError;
      }
    }

    try {
      pushEvent({
        ts: new Date().toISOString(),
        type: 'api_call',
        summary: `OpenAI API call metered [${category}]`,
        detail: `${durationMs}ms`,
      });
    } catch (eventErr) {
      logger.warn({
        errorName: eventErr instanceof Error ? eventErr.name : typeof eventErr,
        userId,
        category,
      }, 'Failed to publish OpenAI usage telemetry');
    }
    // April 2026 follow-up: per-user metering for OpenAI mirrors
    // anthropic-hook and gemini-provider so quota enforcement sees
    // every provider's traffic, not only the disabled Anthropic path.
    try {
      const { recordUsage } = require('./usage-metering') as typeof import('./usage-metering');
      recordUsage(userId, usage.prompt_tokens, usage.completion_tokens, costUsd, false);
    } catch (meterErr) {
      logger.warn({
        errorName: meterErr instanceof Error ? meterErr.name : typeof meterErr,
        userId,
      }, 'Failed to record OpenAI usage_metering');
    }
    try {
      await settleNexusPointOverageForUser(userId, apiUsageId);
    } catch (settleErr) {
      logger.warn({
        errorName: settleErr instanceof Error ? settleErr.name : typeof settleErr,
        apiUsageId,
        userId,
      }, 'nexus_points: OpenAI usage settlement failed');
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
      options?.abortSignal,
    ),
    normalizeRetryCount(options?.maxRetries, 3),
    options?.abortSignal,
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
  const baseMaxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'openai',
    model,
    payload: request,
    maxOutputTokens,
    nonTokenCostUpperBoundUsd:
      maxToolCalls * getProviderToolFeeUsd('openai_web_search'),
  });
  const maxCostUsd = baseMaxCostUsd * (isGpt56Model(model) ? 2 : 1);
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
      getClient().responses.create(request, {
        maxRetries: 0,
        ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
      }),
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
            logger.warn({
              errorName: settleErr instanceof Error ? settleErr.name : typeof settleErr,
              apiUsageId,
              category,
            }, 'nexus_points: OpenAI search timeout estimate settlement failed');
          });
        },
      },
    );
  }, normalizeRetryCount(options?.maxRetries, 3), options?.abortSignal) as any;
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
  if (options?.abortSignal?.aborted) {
    throw openAiCancellationError(options.abortSignal);
  }

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
  options?: OneShotOptions,
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
      options?.timeoutMs,
      options?.abortSignal,
    ),
    normalizeRetryCount(options?.maxRetries, 3),
    options?.abortSignal,
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
  const rawCacheReadTokens = usage.input_tokens_details?.cached_tokens;
  const rawCacheWriteTokens = usage.input_tokens_details?.cache_write_tokens;
  const parsedCacheReadTokens = numberFromUnknown(rawCacheReadTokens);
  const parsedCacheWriteTokens = numberFromUnknown(rawCacheWriteTokens);
  const cacheReadTokens = parsedCacheReadTokens ?? 0;
  const cacheWriteTokens = parsedCacheWriteTokens ?? 0;
  if ((rawCacheReadTokens != null && parsedCacheReadTokens === null)
      || (rawCacheWriteTokens != null && parsedCacheWriteTokens === null)
      || cacheReadTokens < 0 || cacheWriteTokens < 0
      || cacheReadTokens + cacheWriteTokens > inputTokens) {
    const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
    logger.error({ code: persistenceError.code, category: input.category, model: input.model }, 'OpenAI Responses API returned invalid cache usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  const contextRates = openAIContextRateMultipliers(input.model, inputTokens);
  const priced = computeModelUsageCostUsd(input.model, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...contextRates,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      input.category,
      input.model,
      input.tenantId,
      input.userId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
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
        cacheWriteTokens,
        costUsd: priced.costUsd,
        durationMs: input.durationMs,
        pricingStatus: 'legacy',
        providerToolCostUsd: input.nonTokenCostUsd ?? 0,
        webSearchRequests: input.webSearchRequests ?? 0,
        groundedSearchPrompts: 0,
      });
    } catch (fallbackErr) {
      const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
      logger.error({
        errorName: fallbackErr instanceof Error ? fallbackErr.name : typeof fallbackErr,
        code: persistenceError.code,
      }, 'Failed to log OpenAI Responses usage; AI usage persistence degraded');
      throw persistenceError;
    }
  }
  try {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `OpenAI API call metered [${input.category}]`,
      detail: `${input.durationMs}ms`,
    });
  } catch (eventErr) {
    logger.warn({
      errorName: eventErr instanceof Error ? eventErr.name : typeof eventErr,
      userId: input.userId,
      category: input.category,
    }, 'Failed to publish OpenAI Responses usage telemetry');
  }
  // Analytics remains calendar-aligned in usage_metering, while api_usage
  // above is the sole blocking truth. Keep this best-effort and outside the
  // INSERT fallback catch so an analytics failure cannot duplicate quota rows.
  try {
    const { recordUsage } = require('./usage-metering') as typeof import('./usage-metering');
    recordUsage(input.userId, inputTokens, outputTokens, priced.costUsd, false);
  } catch (meterErr) {
    logger.warn({
      errorName: meterErr instanceof Error ? meterErr.name : typeof meterErr,
      userId: input.userId,
    }, 'Failed to record OpenAI Responses usage_metering');
  }
  await settleNexusPointOverageForUser(input.userId, apiUsageId).catch((settleErr) => {
    logger.warn({
      errorName: settleErr instanceof Error ? settleErr.name : typeof settleErr,
      apiUsageId,
      userId: input.userId,
    }, 'nexus_points: OpenAI Responses usage settlement failed');
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

function openAiCancellationError(abortSignal: AbortSignal): Error {
  return abortSignal.reason instanceof Error
    ? abortSignal.reason
    : Object.assign(new Error('openai_request_cancelled'), {
      name: 'AbortError',
      code: 'CHAT_REQUEST_CANCELLED',
    });
}

/** Injectable, cancellation-aware sleep — tests may replace `.fn`. */
export const _sleep = {
  fn: (ms: number, abortSignal?: AbortSignal): Promise<void> => {
    if (!abortSignal) return new Promise(resolve => setTimeout(resolve, ms));
    if (abortSignal.aborted) return Promise.reject(openAiCancellationError(abortSignal));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(openAiCancellationError(abortSignal));
      };
      const timer = setTimeout(() => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  },
};

/**
 * Retry on OpenAI rate limit (429) and transient server errors (500, 502, 503).
 * Uses exponential backoff with jitter. Max 3 retries.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  abortSignal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (abortSignal?.aborted) {
        throw openAiCancellationError(abortSignal);
      }
      const result = await fn();
      if (abortSignal?.aborted) throw openAiCancellationError(abortSignal);
      return result;
    } catch (err: unknown) {
      if (isProviderRequestCancellation(err)) {
        throw err;
      }
      if (abortSignal?.aborted) throw openAiCancellationError(abortSignal);
      const e = err as { status?: number; response?: { status?: number }; headers?: Record<string, string> };
      const status = e?.status ?? e?.response?.status;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503;

      if (!isRetryable || attempt === maxRetries) throw err;

      const retryAfter = e?.headers?.['retry-after'];
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : (2 ** attempt) * 1000 + Math.random() * 500;

      logger.warn({ status, attempt, waitMs }, 'OpenAI retryable error, backing off');
      await _sleep.fn(waitMs, abortSignal);
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

function stableBatchJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableBatchJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableBatchJson(record[key])}`).join(',')}}`;
}

function batchError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isOpenAINotFound(error: unknown): boolean {
  return (error as { status?: number } | undefined)?.status === 404;
}

async function resolveOpenAIBatchClientByBatchId(
  providerBatchId: string,
  clients = getOpenAIBatchClients(),
  abortSignal?: AbortSignal,
): Promise<{ client: OpenAI; batch: OpenAI.Batches.Batch }> {
  let notFound: unknown;
  for (const client of clients) {
    try {
      return {
        client,
        batch: await client.batches.retrieve(providerBatchId, {
          maxRetries: 0,
          ...(abortSignal ? { signal: abortSignal } : {}),
        }),
      };
    } catch (error) {
      if (!isOpenAINotFound(error)) throw error;
      notFound = error;
    }
  }
  throw notFound ?? batchError(
    'OPENAI_BATCH_PROJECT_OWNERSHIP_NOT_FOUND',
    'OpenAI Batch project ownership could not be resolved.',
  );
}

async function resolveOpenAIBatchClientByFileId(
  inputFileId: string,
  abortSignal?: AbortSignal,
): Promise<OpenAI> {
  const clients = getOpenAIBatchClients();
  if (clients.length === 1) return clients[0];
  let notFound: unknown;
  for (const client of clients) {
    try {
      await client.files.retrieve(inputFileId, {
        maxRetries: 0,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      return client;
    } catch (error) {
      if (!isOpenAINotFound(error)) throw error;
      notFound = error;
    }
  }
  throw notFound ?? batchError(
    'OPENAI_BATCH_FILE_PROJECT_OWNERSHIP_NOT_FOUND',
    'OpenAI Batch file project ownership could not be resolved.',
  );
}

interface OpenAIBoundedPage<T> {
  data: T[];
  hasNextPage(): boolean;
  getNextPage(): Promise<OpenAIBoundedPage<T>>;
}

function assertOpenAIBatchReconciliationIdentity(
  request: StructuredGenerationBatchIntentReconciliationRequest,
): void {
  if (!/^[0-9a-f]{64}$/u.test(request.stageKey)
      || !/^[0-9a-f]{64}$/u.test(request.requestDigest)
      || request.customId !== request.stageKey) {
    throw batchError('OPENAI_BATCH_RECONCILIATION_IDENTITY_INVALID', 'OpenAI Batch intent identity is invalid.');
  }
  const expectedFilename = `${request.stageKey}.jsonl`;
  if (request.inputFileIntentFilename
      && request.inputFileIntentFilename !== expectedFilename) {
    throw batchError('OPENAI_BATCH_FILE_INTENT_IDENTITY_MISMATCH', 'OpenAI Batch file intent identity does not match its stage.');
  }
}

async function collectOpenAIReconciliationPages<T>(
  firstPage: Promise<OpenAIBoundedPage<T>>,
  exhaustionCode: string,
): Promise<T[]> {
  const items: T[] = [];
  let page = await firstPage;
  for (let pageNumber = 0; pageNumber < OPENAI_BATCH_RECONCILIATION_MAX_PAGES; pageNumber += 1) {
    items.push(...page.data);
    if (!page.hasNextPage()) return items;
    if (pageNumber === OPENAI_BATCH_RECONCILIATION_MAX_PAGES - 1) {
      throw batchError(exhaustionCode, 'OpenAI Batch intent reconciliation exceeded its bounded provider inventory scan.');
    }
    page = await page.getNextPage();
  }
  throw batchError(exhaustionCode, 'OpenAI Batch intent reconciliation did not terminate.');
}

async function reconcileOpenAIBatchIntent(
  client: OpenAI,
  request: StructuredGenerationBatchIntentReconciliationRequest,
): Promise<StructuredGenerationBatchIntentReconciliationResult> {
  assertOpenAIBatchReconciliationIdentity(request);

  let inputFileId = request.inputFileId;
  if (request.inputFileIntentFilename && !inputFileId) {
    const files = await collectOpenAIReconciliationPages(
      client.files.list(
        { purpose: 'batch', order: 'desc', limit: OPENAI_BATCH_RECONCILIATION_PAGE_SIZE },
        { maxRetries: 0, ...(request.abortSignal ? { signal: request.abortSignal } : {}) },
      ),
      'OPENAI_BATCH_FILE_RECONCILIATION_EXHAUSTED',
    );
    const matching = files.filter((file) => file.purpose === 'batch'
      && file.filename === request.inputFileIntentFilename);
    if (matching.length > 1) {
      throw batchError('OPENAI_BATCH_FILE_RECONCILIATION_AMBIGUOUS', 'OpenAI Batch file intent matched more than one provider object.');
    }
    inputFileId = matching[0]?.id;
  }

  if (!request.batchCreateIntent) {
    return inputFileId ? { inputFileId } : {};
  }
  if (!inputFileId) {
    throw batchError('OPENAI_BATCH_CREATE_INTENT_INPUT_MISSING', 'OpenAI Batch create intent has no reconciled input file.');
  }
  const batches = await collectOpenAIReconciliationPages(
    client.batches.list(
      { limit: OPENAI_BATCH_RECONCILIATION_PAGE_SIZE },
      { maxRetries: 0, ...(request.abortSignal ? { signal: request.abortSignal } : {}) },
    ),
    'OPENAI_BATCH_CREATE_RECONCILIATION_EXHAUSTED',
  );
  const matching = batches.filter((batch) => batch.input_file_id === inputFileId
    && batch.endpoint === '/v1/chat/completions'
    && batch.metadata?.nexus_stage_key === request.stageKey
    && batch.metadata?.nexus_request_digest === request.requestDigest);
  if (matching.length > 1) {
    throw batchError('OPENAI_BATCH_CREATE_RECONCILIATION_AMBIGUOUS', 'OpenAI Batch create intent matched more than one provider object.');
  }
  const batch = matching[0];
  if (!batch) return { inputFileId };
  return {
    inputFileId,
    providerBatchId: batch.id,
    status: batch.status,
    ...(batch.output_file_id ? { outputFileId: batch.output_file_id } : {}),
    ...(batch.error_file_id ? { errorFileId: batch.error_file_id } : {}),
    ...contentFreeOpenAIBatchError(batch.errors?.data?.[0]),
  };
}

async function reconcileOpenAIBatchIntentAcrossProjects(
  request: StructuredGenerationBatchIntentReconciliationRequest,
): Promise<{ client: OpenAI; result: StructuredGenerationBatchIntentReconciliationResult }> {
  assertOpenAIBatchReconciliationIdentity(request);
  if (request.inputFileId) {
    const clients = getOpenAIBatchClients();
    if (clients.length === 1) {
      return { client: clients[0], result: await reconcileOpenAIBatchIntent(clients[0], request) };
    }
    if (request.batchCreateIntent) {
      const matches: Array<{
        client: OpenAI;
        result: StructuredGenerationBatchIntentReconciliationResult;
      }> = [];
      for (const client of clients) {
        const result = await reconcileOpenAIBatchIntent(client, request);
        if (result.providerBatchId) matches.push({ client, result });
      }
      if (matches.length > 1) {
        throw batchError(
          'OPENAI_BATCH_PROJECT_RECONCILIATION_AMBIGUOUS',
          'OpenAI Batch intent matched provider objects in more than one project.',
        );
      }
      if (matches[0]) return matches[0];
    }
    try {
      const client = await resolveOpenAIBatchClientByFileId(
        request.inputFileId,
        request.abortSignal,
      );
      return { client, result: { inputFileId: request.inputFileId } };
    } catch (error) {
      if (!isOpenAINotFound(error)) throw error;
      return { client: clients[0], result: { inputFileId: request.inputFileId } };
    }
  }
  const clients = getOpenAIBatchClients();
  if (!request.inputFileIntentFilename) {
    return { client: clients[0], result: await reconcileOpenAIBatchIntent(clients[0], request) };
  }
  const matches: Array<{ client: OpenAI; inputFileId: string }> = [];
  for (const client of clients) {
    const result = await reconcileOpenAIBatchIntent(client, {
      ...request,
      batchCreateIntent: false,
    });
    if (result.inputFileId) matches.push({ client, inputFileId: result.inputFileId });
  }
  if (matches.length > 1) {
    throw batchError(
      'OPENAI_BATCH_PROJECT_RECONCILIATION_AMBIGUOUS',
      'OpenAI Batch intent matched provider objects in more than one project.',
    );
  }
  const match = matches[0];
  if (!match) {
    if (request.batchCreateIntent) {
      throw batchError('OPENAI_BATCH_CREATE_INTENT_INPUT_MISSING', 'OpenAI Batch create intent has no reconciled input file.');
    }
    return { client: clients[0], result: {} };
  }
  if (!request.batchCreateIntent) {
    return { client: match.client, result: { inputFileId: match.inputFileId } };
  }
  return {
    client: match.client,
    result: await reconcileOpenAIBatchIntent(match.client, {
      ...request,
      inputFileId: match.inputFileId,
    }),
  };
}

async function recordOpenAIBatchUsage(input: {
  response: OpenAI.ChatCompletion;
  requestedModel: string;
  category: string;
  userId: number;
  tenantId: number;
  providerBatchId: string;
  durationMs: number;
}): Promise<void> {
  const usage = input.response.usage;
  const details = usage?.prompt_tokens_details as ({
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  } | undefined);
  const cacheReadTokens = details?.cached_tokens ?? 0;
  const cacheWriteTokens = details?.cache_write_tokens ?? 0;
  if (!usage
      || !Number.isFinite(usage.prompt_tokens) || usage.prompt_tokens < 0
      || !Number.isFinite(usage.completion_tokens) || usage.completion_tokens < 0
      || !Number.isFinite(cacheReadTokens) || cacheReadTokens < 0
      || !Number.isFinite(cacheWriteTokens) || cacheWriteTokens < 0
      || cacheReadTokens + cacheWriteTokens > usage.prompt_tokens) {
    const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
    logger.error({
      code: persistenceError.code,
      category: input.category,
      model: input.response.model || input.requestedModel,
    }, 'OpenAI Batch output omitted valid usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  const model = input.response.model || input.requestedModel;
  const contextRates = openAIContextRateMultipliers(model, usage.prompt_tokens);
  const priced = computeModelUsageCostUsd(model, {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...contextRates,
  }, 'openai');
  if (!priced.pricingResolved) warnUnresolvedOpenAiPricing(model, input.category, input.userId);
  const costUsd = priced.costUsd * openAIServiceTierCostMultiplier('batch');
  const attribution = resolveApiUsageAttribution(input.category, input.userId);
  let apiUsageId: number | null = null;
  let inserted = false;
  try {
    const db = getDb();
    db.transaction(() => {
      const claim = db.prepare(`INSERT OR IGNORE INTO api_usage_provider_batch_dedupe
        (provider, provider_batch_id) VALUES ('openai', ?)`).run(input.providerBatchId);
      inserted = (claim as { changes?: number } | undefined)?.changes !== 0;
      if (!inserted) return;
      const result = db.prepare(`
        INSERT INTO api_usage (category, model, tenant_id, user_id, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
          duration_ms, provider, pricing_status, pricing_model_key,
          request_source, job_name, base_category, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).run(
        input.category,
        model,
        input.tenantId,
        input.userId,
        usage.prompt_tokens,
        usage.completion_tokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
        input.durationMs,
        priced.pricingResolved ? 'resolved' : 'unresolved',
        priced.pricingModelKey,
        attribution.requestSource,
        attribution.jobName,
        attribution.baseCategory,
        attribution.runId,
      );
      apiUsageId = Number(
        (result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0,
      );
      db.prepare(`UPDATE api_usage_provider_batch_dedupe
        SET api_usage_id = ? WHERE provider = 'openai' AND provider_batch_id = ?`)
        .run(apiUsageId, input.providerBatchId);
    }).immediate();
  } catch (error) {
    const persistenceError = tripApiUsagePersistenceFailure('openai', input.category);
    logger.error({
      errorName: error instanceof Error ? error.name : typeof error,
      code: persistenceError.code,
    }, 'Failed to persist exactly-once OpenAI Batch usage');
    throw persistenceError;
  }
  if (!inserted) return;
  try {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `OpenAI Batch API call metered [${input.category}]`,
      detail: `${input.durationMs}ms`,
    });
  } catch (eventError) {
    logger.warn({ errorName: eventError instanceof Error ? eventError.name : typeof eventError }, 'Failed to publish OpenAI Batch usage telemetry');
  }
  try {
    const { recordUsage } = require('./usage-metering') as typeof import('./usage-metering');
    recordUsage(input.userId, usage.prompt_tokens, usage.completion_tokens, costUsd, false);
  } catch (meterError) {
    logger.warn({ errorName: meterError instanceof Error ? meterError.name : typeof meterError }, 'Failed to record OpenAI Batch usage metering');
  }
  try {
    await settleNexusPointOverageForUser(input.userId, apiUsageId);
  } catch (settleError) {
    logger.warn({ errorName: settleError instanceof Error ? settleError.name : typeof settleError }, 'Nexus Points OpenAI Batch settlement failed');
  }
}

async function readOpenAIBatchOutput(
  client: OpenAI,
  outputFileId: string,
  customId: string,
  abortSignal?: AbortSignal,
): Promise<{ response?: OpenAI.ChatCompletion; errorCode?: string }> {
  const outputResponse = await client.files.content(outputFileId, {
    maxRetries: 0,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  const output = await outputResponse.text();
  if (Buffer.byteLength(output, 'utf8') > OPENAI_BATCH_OUTPUT_MAX_BYTES) {
    throw batchError('OPENAI_BATCH_OUTPUT_TOO_LARGE', 'OpenAI Batch output exceeded the bounded result size.');
  }
  const matching = output.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
    custom_id?: string;
    response?: { status_code?: number; body?: OpenAI.ChatCompletion };
    error?: { code?: string; message?: string } | null;
  }).filter((line) => line.custom_id === customId);
  if (matching.length !== 1) {
    throw batchError('OPENAI_BATCH_OUTPUT_IDENTITY_MISMATCH', 'OpenAI Batch output did not contain exactly one matching result.');
  }
  const line = matching[0];
  if (line.error || line.response?.status_code !== 200 || !line.response.body) {
    const outputErrorCode = contentFreeOpenAIBatchError(line.error).errorCode;
    return {
      errorCode: outputErrorCode
        ? `OPENAI_BATCH_${outputErrorCode.toUpperCase()}`
        : 'OPENAI_BATCH_REQUEST_FAILED',
    };
  }
  return { response: line.response.body };
}

async function waitForOpenAIBatchInputFileReady(
  client: OpenAI,
  inputFileId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const readinessClient = client.withOptions({
    maxRetries: 0,
    timeout: OPENAI_BATCH_FILE_READY_REQUEST_TIMEOUT_MS,
  });
  const deadline = Date.now() + OPENAI_BATCH_FILE_READY_MAX_WAIT_MS;
  while (true) {
    if (abortSignal?.aborted) throw openAiCancellationError(abortSignal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw batchError(
        'OPENAI_BATCH_INPUT_FILE_NOT_READY',
        'OpenAI Batch input file did not become provider-ready within the bounded wait.',
      );
    }
    let file: OpenAI.Files.FileObject;
    try {
      file = await readinessClient.files.retrieve(inputFileId, {
        maxRetries: 0,
        timeout: Math.min(OPENAI_BATCH_FILE_READY_REQUEST_TIMEOUT_MS, remainingMs),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
    } catch (error) {
      if (isProviderRequestCancellation(error) || abortSignal?.aborted) {
        if (abortSignal?.aborted) throw openAiCancellationError(abortSignal);
        throw error;
      }
      throw batchError(
        'OPENAI_BATCH_INPUT_FILE_NOT_READY',
        'OpenAI Batch input file readiness could not be proven by the provider.',
      );
    }
    if (file.id !== inputFileId || file.purpose !== 'batch') {
      throw batchError(
        'OPENAI_BATCH_INPUT_FILE_IDENTITY_MISMATCH',
        'OpenAI Batch input file identity or purpose did not match the durable request.',
      );
    }
    if (file.status === 'error' || String(file.status) === 'deleted') {
      throw batchError(
        'OPENAI_BATCH_INPUT_FILE_PROCESSING_FAILED',
        'OpenAI Batch input file failed provider processing.',
      );
    }
    if (file.status === 'processed') return;
    if (file.status !== 'uploaded') {
      throw batchError(
        'OPENAI_BATCH_INPUT_FILE_NOT_READY',
        'OpenAI Batch input file readiness was not proven by the provider.',
      );
    }
    const sleepMs = Math.min(
      OPENAI_BATCH_FILE_READY_POLL_INTERVAL_MS,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepMs <= 0) {
      throw batchError(
        'OPENAI_BATCH_INPUT_FILE_NOT_READY',
        'OpenAI Batch input file did not become provider-ready within the bounded wait.',
      );
    }
    await _sleep.fn(sleepMs, abortSignal);
  }
}

async function runOpenAIBatchStructuredGeneration(
  request: StructuredGenerationRequest,
  params: OpenAINonStreamingParams,
): Promise<StructuredGenerationResult> {
  const control = request.durableBatch;
  if (!control || !/^[0-9a-f]{64}$/u.test(control.stageKey)) {
    throw batchError('OPENAI_BATCH_DURABLE_STATE_REQUIRED', 'OpenAI Batch requires a durable stage binding.');
  }
  let body = { ...params } as Record<string, unknown>;
  delete body.service_tier;
  let requestDigest = crypto.createHash('sha256').update(stableBatchJson(body)).digest('hex');
  const customId = control.stageKey;
  let state = control.load();
  let allowLegacyGpt56ReasoningOmission = false;
  if (state && state.customId === customId && state.requestDigest !== requestDigest
      && isGpt56Model(body.model) && body.reasoning_effort === 'none') {
    const legacyBody = { ...body };
    delete legacyBody.reasoning_effort;
    const legacyRequestDigest = crypto.createHash('sha256')
      .update(stableBatchJson(legacyBody)).digest('hex');
    if (state.requestDigest === legacyRequestDigest) {
      // Preserve the immutable envelope and digest of a GPT-5.6 Batch stage
      // admitted before the visible-output pin. New stages still require the
      // pin; this compatibility path only resumes that exact durable identity.
      body = legacyBody;
      requestDigest = legacyRequestDigest;
      allowLegacyGpt56ReasoningOmission = true;
    }
  }
  const inputJsonl = openAIBatchInputJsonl(customId, body, {
    allowLegacyGpt56ReasoningOmission,
  });
  if (state && (state.requestDigest !== requestDigest || state.customId !== customId)) {
    throw batchError('OPENAI_BATCH_REQUEST_IDENTITY_MISMATCH', 'Persisted OpenAI Batch identity does not match this request.');
  }
  if (!state) {
    state = { requestDigest, customId, status: 'preparing' };
    control.persist(state);
  }
  const baseMaxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'openai',
    model: params.model,
    payload: params,
    maxOutputTokens: Number(params.max_completion_tokens ?? params.max_tokens ?? Number.POSITIVE_INFINITY),
  });
  assertAiBudgetReservationForProvider({
    userId: request.userId,
    category: request.category,
    provider: 'openai',
    model: params.model,
    maxCostUsd: baseMaxCostUsd * (isGpt56Model(params.model) ? 2 : 1),
  });
  const startedAt = Date.now();
  let client = getBatchClient();
  try {
    const availableBatchClients = getOpenAIBatchClients();
    if (availableBatchClients.length > 1 && state.providerBatchId) {
      client = (await resolveOpenAIBatchClientByBatchId(
        state.providerBatchId,
        availableBatchClients,
      )).client;
    } else if (availableBatchClients.length > 1
        && state.inputFileId
        && state.batchCreateIntent !== true) {
      client = await resolveOpenAIBatchClientByFileId(state.inputFileId, request.abortSignal);
    }
    if (!state.inputFileId) {
      const inputFileIntentFilename = `${control.stageKey}.jsonl`;
      const createdIntent = state.inputFileIntentFilename === undefined;
      let uploadMutationAuthorized = createdIntent;
      if (state.inputFileIntentFilename
          && state.inputFileIntentFilename !== inputFileIntentFilename) {
        throw batchError('OPENAI_BATCH_FILE_INTENT_IDENTITY_MISMATCH', 'Persisted OpenAI Batch file intent does not match this stage.');
      }
      if (createdIntent) {
        state = { ...state, inputFileIntentFilename };
        control.persist(state);
      }
      if (!createdIntent) {
        const recovery = await reconcileOpenAIBatchIntentAcrossProjects({
          stageKey: control.stageKey,
          requestDigest,
          customId,
          inputFileIntentFilename,
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        });
        client = recovery.client;
        const recovered = recovery.result;
        if (recovered.inputFileId) {
          state = { ...state, inputFileId: recovered.inputFileId };
          control.persist(state);
        } else if (control.observeIntentAbsence) {
          const observation = control.observeIntentAbsence('input_file');
          state = observation.state;
          uploadMutationAuthorized = observation.mutationAuthorized;
          if (state.requestDigest !== requestDigest || state.customId !== customId) {
            throw batchError(
              'OPENAI_BATCH_REQUEST_IDENTITY_MISMATCH',
              'Observed OpenAI Batch upload intent no longer matches this request.',
            );
          }
        }
        if (!state.inputFileId && !uploadMutationAuthorized) {
          throw batchError(
            'OPENAI_BATCH_FILE_INTENT_PENDING',
            'OpenAI Batch upload intent is pending provider reconciliation.',
          );
        }
      }
    }
    if (!state.inputFileId) {
      const file = await toFile(Buffer.from(inputJsonl, 'utf8'), state.inputFileIntentFilename!, {
        type: 'application/jsonl',
      });
      const uploaded = await client.files.create(
        { file, purpose: 'batch' },
        {
          maxRetries: 0,
          idempotencyKey: `nexus-file-${control.stageKey}`,
          ...(request.abortSignal ? { signal: request.abortSignal } : {}),
        },
      );
      state = { ...state, inputFileId: uploaded.id };
      control.persist(state);
    }
    if (!state.providerBatchId) {
      if (request.abortSignal?.aborted) {
        throw request.abortSignal.reason instanceof Error
          ? request.abortSignal.reason
          : Object.assign(new Error('OpenAI Batch request was cancelled.'), { name: 'AbortError' });
      }
      if (!state.inputFileId) {
        throw batchError('OPENAI_BATCH_INPUT_FILE_MISSING', 'OpenAI Batch input file identity was not persisted.');
      }
      const createdIntent = state.batchCreateIntent !== true;
      let createMutationAuthorized = createdIntent;
      if (!createdIntent) {
        const recovery = await reconcileOpenAIBatchIntentAcrossProjects({
          stageKey: control.stageKey,
          requestDigest,
          customId,
          inputFileIntentFilename: state.inputFileIntentFilename,
          batchCreateIntent: true,
          inputFileId: state.inputFileId,
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        });
        client = recovery.client;
        const recovered = recovery.result;
        if (recovered.providerBatchId) {
          state = { ...state, ...recovered };
          control.persist(state);
        } else if (control.observeIntentAbsence) {
          const observation = control.observeIntentAbsence('batch_create');
          state = observation.state;
          createMutationAuthorized = observation.mutationAuthorized;
          if (state.requestDigest !== requestDigest || state.customId !== customId) {
            throw batchError(
              'OPENAI_BATCH_REQUEST_IDENTITY_MISMATCH',
              'Observed OpenAI Batch create intent no longer matches this request.',
            );
          }
        }
        if (!state.providerBatchId && !createMutationAuthorized) {
          throw batchError(
            'OPENAI_BATCH_CREATE_INTENT_PENDING',
            'OpenAI Batch create intent is pending provider reconciliation.',
          );
        }
      }
      if (!state.providerBatchId) {
        if (!state.inputFileId) {
          throw batchError('OPENAI_BATCH_INPUT_FILE_MISSING', 'OpenAI Batch readiness lost its input file identity.');
        }
        await waitForOpenAIBatchInputFileReady(client, state.inputFileId, request.abortSignal);
        if (createdIntent) {
          state = { ...state, batchCreateIntent: true };
          control.persist(state);
        }
      }
    }
    if (!state.providerBatchId) {
      if (!state.inputFileId) {
        throw batchError('OPENAI_BATCH_INPUT_FILE_MISSING', 'OpenAI Batch create intent lost its input file identity.');
      }
      const batch = await client.batches.create({
        input_file_id: state.inputFileId,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        metadata: {
          nexus_stage_key: control.stageKey,
          nexus_request_digest: requestDigest,
        },
      }, {
        maxRetries: 0,
        idempotencyKey: `nexus-batch-${control.stageKey}`,
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      });
      state = replaceContentFreeOpenAIBatchError({
        ...state,
        providerBatchId: batch.id,
        status: batch.status,
        ...(batch.output_file_id ? { outputFileId: batch.output_file_id } : {}),
        ...(batch.error_file_id ? { errorFileId: batch.error_file_id } : {}),
      }, batch.errors?.data?.[0]);
      control.persist(state);
    }
    while (state.status !== 'completed') {
      if (state.status === 'cancelled' || state.status === 'failed' || state.status === 'expired') {
        throw batchError(`OPENAI_BATCH_${state.status.toUpperCase()}`, `OpenAI Batch ended with ${state.status}.`);
      }
      if (state.status === 'cancellation_requested' || state.status === 'cancelling') {
        const cancelled = await client.batches.cancel(state.providerBatchId!, { maxRetries: 0 });
        state = replaceContentFreeOpenAIBatchError({
          ...state,
          status: cancelled.status === 'cancelled' ? 'cancelled' : 'cancelling',
          ...(cancelled.output_file_id ? { outputFileId: cancelled.output_file_id } : {}),
          ...(cancelled.error_file_id ? { errorFileId: cancelled.error_file_id } : {}),
        }, cancelled.errors?.data?.[0]);
        control.persist(state);
        throw batchError('OPENAI_BATCH_CANCELLED', 'OpenAI Batch was cancelled.');
      }
      const batch = await client.batches.retrieve(state.providerBatchId!, {
        maxRetries: 0,
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      });
      state = replaceContentFreeOpenAIBatchError({
        ...state,
        status: batch.status,
        ...(batch.output_file_id ? { outputFileId: batch.output_file_id } : {}),
        ...(batch.error_file_id ? { errorFileId: batch.error_file_id } : {}),
      }, batch.errors?.data?.[0]);
      control.persist(state);
      if (state.status !== 'completed') {
        await _openAIBatchSleep.fn(OPENAI_BATCH_POLL_INTERVAL_MS, request.abortSignal);
      }
    }
    if (!state.outputFileId) {
      throw batchError('OPENAI_BATCH_OUTPUT_MISSING', 'Completed OpenAI Batch has no output file.');
    }
    const batchOutput = await readOpenAIBatchOutput(
      client,
      state.outputFileId,
      customId,
      request.abortSignal,
    );
    if (!batchOutput.response) {
      throw batchError(batchOutput.errorCode ?? 'OPENAI_BATCH_REQUEST_FAILED', 'OpenAI Batch request failed.');
    }
    await recordOpenAIBatchUsage({
      response: batchOutput.response,
      requestedModel: params.model,
      category: request.category,
      userId: request.userId,
      tenantId: request.tenantId,
      providerBatchId: state.providerBatchId!,
      durationMs: Date.now() - startedAt,
    });
    const text = batchOutput.response.choices[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      // A completed Batch output is immutable. Classifying this as the
      // generic INFERENCE_EMPTY_OUTPUT infrastructure failure would replay the
      // same poisoned result until the parent job exhausted its automatic
      // retries. Fail this generation attempt explicitly so a user retry gets
      // a new durable stage identity and therefore a new Batch request.
      throw batchError(
        'OPENAI_BATCH_EMPTY_OUTPUT',
        'Completed OpenAI Batch returned no generated text.',
      );
    }
    return {
      text,
      stopReason: batchOutput.response.choices[0]?.finish_reason ?? 'stop',
      serviceTier: 'batch',
    };
  } catch (error) {
    if ((request.abortSignal?.aborted || isProviderRequestCancellation(error)) && state.providerBatchId) {
      try {
        const providerBatchId = state.providerBatchId;
        state = { ...state, status: 'cancellation_requested' };
        control.persist(state);
        const cancelled = await client.batches.cancel(providerBatchId, { maxRetries: 0 });
        state = replaceContentFreeOpenAIBatchError({
          ...state,
          status: cancelled.status === 'cancelled' ? 'cancelled' : 'cancelling',
          ...(cancelled.output_file_id ? { outputFileId: cancelled.output_file_id } : {}),
          ...(cancelled.error_file_id ? { errorFileId: cancelled.error_file_id } : {}),
        }, cancelled.errors?.data?.[0]);
        control.persist(state);
      } catch (cancelError) {
        logger.warn({
          errorName: cancelError instanceof Error ? cancelError.name : typeof cancelError,
        }, 'OpenAI Batch cancellation remains durably pending');
      }
    }
    throw error;
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
    const serviceTier = request.serviceTier as OpenAIDirectServiceTier | undefined;
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
    if (request.serviceTier === 'batch') {
      return runOpenAIBatchStructuredGeneration(request, withTokenLimit({
        model: request.model,
        messages: [
          { role: openAIBatchInstructionRole(request.model), content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        // GPT-5.6 defaults to medium reasoning, whose hidden tokens share the
        // same max_completion_tokens budget as visible output. These durable
        // output-only stages need the full bounded budget for contract text;
        // the provider documents `none` for Chat Completions and this model.
        ...(isGpt56Model(request.model) ? { reasoning_effort: 'none' as const } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }, request.maxTokens));
    }
    const response = await withRetry(() => trackedCompletion(
      getClient(),
      withTokenLimit({
        model: request.model,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(serviceTier ? { service_tier: serviceTier } : {}),
      }, request.maxTokens),
      request.category,
      request.userId,
      request.tenantId,
      undefined,
      request.abortSignal,
    ), 3, request.abortSignal);
    const observedServiceTier = response.service_tier;
    if (serviceTier && observedServiceTier !== serviceTier) {
      throw new Error('OpenAI structured generation service tier mismatch');
    }
    const choice = response.choices[0];
    return {
      text: choice?.message?.content ?? '',
      stopReason: choice?.finish_reason ?? 'stop',
      ...(serviceTier ? { serviceTier } : {}),
    };
  }

  async cancelStructuredGenerationBatch(
    request: StructuredGenerationBatchCancellationRequest,
  ): Promise<{
    status: import('./ai-provider').StructuredGenerationBatchStatus;
    outputFileId?: string;
    errorFileId?: string;
    errorCode?: string;
    errorLine?: number;
    errorParam?: string;
  }> {
    const resolved = await resolveOpenAIBatchClientByBatchId(request.providerBatchId);
    const client = resolved.client;
    let batch = resolved.batch;
    if (!['completed', 'cancelled', 'failed', 'expired'].includes(batch.status)) {
      batch = await client.batches.cancel(request.providerBatchId, { maxRetries: 0 });
    }
    if (batch.output_file_id && ['completed', 'cancelled'].includes(batch.status)) {
      try {
        const output = await readOpenAIBatchOutput(client, batch.output_file_id, request.customId);
        if (output.response) {
          await recordOpenAIBatchUsage({
            response: output.response,
            requestedModel: batch.model || output.response.model,
            category: request.category,
            userId: request.userId,
            tenantId: request.tenantId,
            providerBatchId: request.providerBatchId,
            durationMs: 0,
          });
        }
      } catch (error) {
        if (batch.status === 'completed') throw error;
        logger.info({
          outcome: 'cancelled_without_completed_request',
        }, 'OpenAI Batch cancellation produced no billable output for this stage');
      }
    }
    return {
      status: batch.status,
      ...(batch.output_file_id ? { outputFileId: batch.output_file_id } : {}),
      ...(batch.error_file_id ? { errorFileId: batch.error_file_id } : {}),
      ...contentFreeOpenAIBatchError(batch.errors?.data?.[0]),
    };
  }

  async inspectStructuredGenerationBatch(
    request: import('./ai-provider').StructuredGenerationBatchInspectionRequest,
  ): Promise<Pick<import('./ai-provider').StructuredGenerationBatchState,
    'status' | 'errorCode' | 'errorLine' | 'errorParam'>> {
    const providerBatchId = request.providerBatchId;
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(providerBatchId)) {
      throw batchError(
        'OPENAI_BATCH_INSPECTION_IDENTITY_INVALID',
        'OpenAI Batch inspection identity is invalid.',
      );
    }
    const silentClients = getOpenAIBatchClients().map((client) => client.withOptions({
      logLevel: 'off', logger: SILENT_OPENAI_LOGGER,
    }));
    const batch = (await resolveOpenAIBatchClientByBatchId(providerBatchId, silentClients)).batch;
    return {
      status: batch.status,
      ...contentFreeOpenAIBatchError(batch.errors?.data?.[0]),
    };
  }

  async reconcileStructuredGenerationBatchIntent(
    request: StructuredGenerationBatchIntentReconciliationRequest,
  ): Promise<StructuredGenerationBatchIntentReconciliationResult> {
    assertOpenAIBatchReconciliationIdentity(request);
    if (request.inputFileId && !request.batchCreateIntent) {
      return { inputFileId: request.inputFileId };
    }
    return (await reconcileOpenAIBatchIntentAcrossProjects(request)).result;
  }

  async deleteStructuredGenerationBatchFiles(
    request: StructuredGenerationBatchFileCleanupRequest,
  ): Promise<void> {
    const clients = getOpenAIBatchClients();
    for (const fileId of [...new Set(request.fileIds.filter(Boolean))]) {
      for (const client of clients) {
        try {
          const result = await client.files.delete(fileId, { maxRetries: 0 });
          if (result.deleted !== true) {
            throw new Error('openai_batch_file_delete_not_confirmed');
          }
          break;
        } catch (error) {
          if (isOpenAINotFound(error)) continue;
          throw error;
        }
      }
    }
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
        }, 100), 'openai_classify', usageUserId, usageTenantId, options?.timeoutMs, options?.abortSignal),
        3,
        options?.abortSignal,
      );

      let text = response.choices[0]?.message?.content || '';
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(text);
      const domain = parsed.domain as DomainName;
      const confidence = parsed.confidence as number;

      // Manifest `clarify` / `none` labels are terminal decisions rather
      // than weak domain guesses. Flag-off behavior remains unchanged.
      const disposition = resolveManifestClassifierDisposition(domain);
      if (disposition) return { domain: disposition, confidence };

      if (confidence < 0.6) return { domain: 'secretary', confidence };
      return { domain, confidence };
    } catch (err) {
      if (isProviderRequestCancellation(err)) throw err;
      rethrowAiUsageFailClosedError(err);
      logger.error({
        errorName: err instanceof Error ? err.name : typeof err,
      }, 'OpenAI classification failed, defaulting to secretary');
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
    const currentTurnOnly = opts.currentTurnOnly === true;
    // v2: honor options.modelOverride (set by cloud-reasoning-gate so the
    // approved reasoning model is actually used).
    const baseRouting = resolveOpenAIModel(domain, opts.modelTier);
    const routing = opts.modelOverride
      ? { model: opts.modelOverride, maxTokens: baseRouting.maxTokens }
      : baseRouting;
    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage, {
      currentTurnOnly,
    });
    const useTools = !currentTurnOnly && (domain === 'secretary' || domain === 'triathlon');
    const allowLegacyFullTools = optionsOrMaxTokens == null || typeof optionsOrMaxTokens === 'number';
    const tools = useTools ? toOpenAITools(opts.filteredTools, 'OpenAI callDomain', allowLegacyFullTools) : [];
    const contextPrefix = currentTurnOnly ? '' : buildScopedStateContextPrefix(stateContext);
    const historyToSend = currentTurnOnly ? [] : history;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...historyToSend.map((m) => ({
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
      }, opts.maxTokensOverride || routing.maxTokens),
      `openai_domain_${domain}`,
      opts.userId ?? 0,
      opts.tenantId ?? opts.userId ?? 0,
      undefined,
      opts.abortSignal,
    ), 3, opts.abortSignal);

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
    const currentTurnOnly = opts.currentTurnOnly === true;
    // v2: honor options.modelOverride (set by cloud-reasoning-gate so the
    // approved reasoning model is actually used).
    const baseRouting = resolveOpenAIModel(domain, opts.modelTier);
    const routing = opts.modelOverride
      ? { model: opts.modelOverride, maxTokens: baseRouting.maxTokens }
      : baseRouting;
    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage, {
      currentTurnOnly,
    });
    const useTools = !currentTurnOnly && (domain === 'secretary' || domain === 'triathlon');
    const tools = useTools ? toOpenAITools(opts.filteredTools, 'OpenAI continueWithToolResults', options == null) : [];
    const contextPrefix = currentTurnOnly ? '' : buildScopedStateContextPrefix(stateContext);
    const historyToSend = currentTurnOnly ? [] : history;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...historyToSend.map((m) => ({
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

    const response = await withRetry(
      () => trackedCompletion(
        getClient(),
        withTokenLimit({
          model: routing.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }, opts.maxTokensOverride || routing.maxTokens),
        'openai_tool_continuation',
        opts.userId ?? 0,
        opts.tenantId ?? opts.userId ?? 0,
        undefined,
        opts.abortSignal,
      ),
      3,
      opts.abortSignal,
    );

    const choice = response.choices[0];
    return {
      text: choice?.message?.content || '',
      toolCalls: extractToolCalls(response.choices),
      stopReason: choice?.finish_reason || 'stop',
    };
  }

}
