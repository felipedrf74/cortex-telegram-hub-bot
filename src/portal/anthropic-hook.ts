// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Transparent wrapper for Anthropic API calls that records usage metrics.
 *
 * Writes each call to the `api_usage` SQLite table and pushes an activity
 * event to the telemetry ring buffer. The wrapper is transparent — callers
 * see the identical Anthropic.Message return type.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../services/database';
import { pushEvent } from './telemetry';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import { getAICallTimeoutMs, isAnthropicRuntimeEnabled } from '../services/runtime-flags';
import {
  computeModelUsageCostUsd,
  computeProviderCallCostUpperBoundUsd,
  getProviderToolFeeUsd,
  recordUnresolvedModelPricingAlert,
  type ModelCostResult,
} from '../services/model-pricing';
import { settleNexusPointOverageForUser } from '../services/nexus-points';
import {
  insertApiUsageFallback,
  recordApiUsageTimeoutEstimate,
  tripApiUsagePersistenceFailure,
} from '../services/api-usage-fallback';
import { resolveApiUsageAttribution } from '../services/api-usage-attribution';
import { assertAiBudgetReservationForProvider } from '../services/cost-guardrail';

// ─── Per-million-token pricing (update when Anthropic changes rates) ─

const warnedModels = new Set<string>();

const DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES = 5;

function safeProviderErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isAnthropicWebSearchTool(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object') return false;
  const value = tool as { type?: unknown; name?: unknown };
  return String(value.name ?? '') === 'web_search'
    || String(value.type ?? '').startsWith('web_search_');
}

function withAnthropicWebSearchCaps(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Anthropic.MessageCreateParamsNonStreaming {
  if (!Array.isArray(params.tools)) return params;
  let changed = false;
  const tools = params.tools.map((tool) => {
    if (!isAnthropicWebSearchTool(tool)) return tool;
    const configured = Number((tool as { max_uses?: unknown }).max_uses);
    if (Number.isInteger(configured) && configured >= 1) return tool;
    changed = true;
    return { ...tool, max_uses: DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES } as typeof tool;
  });
  return changed ? { ...params, tools } : params;
}

function getAnthropicWebSearchMaxRequests(
  params: Anthropic.MessageCreateParamsNonStreaming,
): number {
  if (!Array.isArray(params.tools)) return 0;
  return params.tools.reduce((sum, tool) => {
    if (!isAnthropicWebSearchTool(tool)) return sum;
    const maxUses = Number((tool as { max_uses?: unknown }).max_uses);
    return sum + (Number.isInteger(maxUses) && maxUses >= 1 ? maxUses : 0);
  }, 0);
}

function getAnthropicWebSearchRequestCount(usage: Anthropic.Usage): number | null {
  const raw = usage.server_tool_use?.web_search_requests;
  if (raw == null) return 0;
  const count = Number(raw);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function computeCost(
  model: string,
  usage: Anthropic.Usage,
  webSearchRequests: number,
  category?: string,
  userId?: number,
): ModelCostResult {
  const priced = computeModelUsageCostUsd(model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    nonTokenCostUsd: webSearchRequests * getProviderToolFeeUsd('anthropic_web_search'),
  }, 'anthropic');
  if (!priced.pricingResolved) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      recordUnresolvedModelPricingAlert({ provider: 'anthropic', model, category, userId });
    }
  }
  return priced;
}

/**
 * Call `client.messages.create()` with usage tracking.
 *
 * ── ANTHROPIC KILL SWITCH (April 9 2026) ──────────────────────────
 *
 * `trackedCreate` is the single chokepoint through which every
 * Anthropic API call in the codebase flows. To guarantee zero Claude
 * expenses, this function now HARD-THROWS unless the caller explicitly
 * sets `ANTHROPIC_ENABLED=true` in the environment. Default is disabled.
 *
 * Why: the cost dashboard on April 9 2026 showed $0.20/day of Claude
 * spend from fallback call sites (garmin-coach `coach_analysis`,
 * content-workflow `content_workflow_youtube`, anthropic.ts
 * `classify_message` fallback) even though commit 339c43e had flipped
 * the domain router to Gemini-first. The router flip only affected the
 * primary path; every `completeOneShotWithFallback` call site still
 * had an Anthropic thunk as its fallback, which fired whenever Gemini
 * had any transient issue.
 *
 * Changing the thunks one-by-one is error-prone (easy to miss one).
 * Throwing at the choke point guarantees coverage — any caller that
 * still hits this function gets a loud, clear error instead of
 * silently spending tokens.
 *
 * To re-enable Anthropic temporarily (e.g. for a specific test or a
 * one-off migration), set `ANTHROPIC_ENABLED=true` in the process env.
 * The production `.env` on the server should leave it unset.
 *
 * @param client   The Anthropic SDK instance
 * @param params   Standard create-message params
 * @param category Identifies the call site: 'classify_message', 'classify_image',
 *                 'domain_secretary', 'domain_triathlon', 'domain_content',
 *                 'tool_continuation', 'invoice_filing', 'coach_analysis'
 * @param options  Optional metering context: userId and whether this is a user-initiated message
 */
export async function trackedCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  category: string,
  options?: {
    userId?: number;
    tenantId?: number;
    isUserMessage?: boolean;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  },
): Promise<Anthropic.Message> {
  const throwIfCancelled = (): void => {
    if (!options?.abortSignal?.aborted) return;
    if (options.abortSignal.reason instanceof Error) throw options.abortSignal.reason;
    throw Object.assign(new Error('anthropic_request_cancelled'), {
      name: 'AbortError',
      code: 'CHAT_REQUEST_CANCELLED',
    });
  };
  throwIfCancelled();
  // ── Kill switch — see the doc block above ──
  if (!isAnthropicRuntimeEnabled()) {
    const msg =
      `[anthropic-hook] Anthropic API is disabled. ` +
      `Set ANTHROPIC_ENABLED=true to re-enable. Blocked call: category=${category}, ` +
      `model=${params.model}, userId=${options?.userId ?? 0}. ` +
      `If you're seeing this in a fallback path, the caller should be migrated to ` +
      `the OpenAI fallback — see completeOneShotWithFallback in gemini-provider.ts.`;
    logger.warn(
      { category, model: params.model, userId: options?.userId ?? 0 },
      'Anthropic call blocked by kill switch',
    );
    throw new Error(msg);
  }

  // Make the provider's paid-search maximum explicit before calculating the
  // bound. Future callers that omit max_uses cannot silently create an
  // unbounded fee surface.
  const requestParams = withAnthropicWebSearchCaps(params);
  const maxWebSearchRequests = getAnthropicWebSearchMaxRequests(requestParams);
  const maxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'anthropic',
    model: requestParams.model,
    payload: requestParams,
    maxOutputTokens: requestParams.max_tokens,
    nonTokenCostUpperBoundUsd:
      maxWebSearchRequests * getProviderToolFeeUsd('anthropic_web_search'),
  });
  assertAiBudgetReservationForProvider({
    userId: options?.userId ?? 0,
    category,
    provider: 'anthropic',
    model: requestParams.model,
    hasUnboundedProviderInjectedContext: maxWebSearchRequests > 0,
    maxCostUsd,
  });
  const start = Date.now();

  // Use streaming for long operations: high max_tokens or Sonnet model
  // The Anthropic SDK requires stream:true for operations that may take 10+ minutes
  const isSonnet = requestParams.model.includes('sonnet');
  const isLargeRequest = requestParams.max_tokens >= 4096;
  const useStreaming = isSonnet || isLargeRequest;

  // Timeout: use caller override, or auto-scale for streaming/large requests (90s), default 30s
  const defaultTimeout = getAICallTimeoutMs();
  const AI_CALL_TIMEOUT_MS = options?.timeoutMs ?? (useStreaming ? Math.max(defaultTimeout, 90_000) : defaultTimeout);
  const recordTimeoutEstimate = () => {
    const apiUsageId = recordApiUsageTimeoutEstimate({
      category,
      model: requestParams.model,
      provider: 'anthropic',
      tenantId: options?.tenantId ?? options?.userId ?? 0,
      userId: options?.userId ?? 0,
      maxCostUsd,
      timeoutMs: AI_CALL_TIMEOUT_MS,
      providerToolCostUsd:
        maxWebSearchRequests * getProviderToolFeeUsd('anthropic_web_search'),
      webSearchRequests: maxWebSearchRequests,
    });
    void settleNexusPointOverageForUser(options?.userId ?? 0, apiUsageId).catch((settleErr) => {
      logger.warn(
        { errorName: safeProviderErrorName(settleErr), apiUsageId, category },
        'nexus_points: Anthropic timeout estimate settlement failed',
      );
    });
  };

  let response: Anthropic.Message;
  if (useStreaming) {
    const streamPromise = (async () => {
      // Budget ownership is checked immediately above. Disable opaque SDK
      // retries so a second HTTP attempt cannot occur without another live
      // headroom decision. Callers retain their explicit provider fallback.
      const stream = await client.messages.stream(
        { ...requestParams, stream: true },
        { maxRetries: 0, ...(options?.abortSignal ? { signal: options.abortSignal } : {}) },
      );
      return stream.finalMessage();
    })();
    response = await withTimeout(streamPromise, AI_CALL_TIMEOUT_MS, { onTimeout: recordTimeoutEstimate });
  } else {
    response = await withTimeout(
      client.messages.create(requestParams, {
        maxRetries: 0,
        ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
      }),
      AI_CALL_TIMEOUT_MS,
      { onTimeout: recordTimeoutEstimate },
    );
  }

  const durationMs = Date.now() - start;
  const usage = response.usage;
  const webSearchRequests = usage ? getAnthropicWebSearchRequestCount(usage) : null;
  if (
    !usage
    || !Number.isFinite(usage.input_tokens)
    || usage.input_tokens < 0
    || !Number.isFinite(usage.output_tokens)
    || usage.output_tokens < 0
    || webSearchRequests == null
  ) {
    const persistenceError = tripApiUsagePersistenceFailure('anthropic', category);
    logger.error({ code: persistenceError.code, category, model: params.model }, 'Anthropic response omitted valid usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  const priced = computeCost(
    requestParams.model,
    usage,
    webSearchRequests,
    category,
    options?.userId ?? 0,
  );
  const cost = priced.costUsd;
  const providerToolCostUsd =
    webSearchRequests * getProviderToolFeeUsd('anthropic_web_search');
  const pricingStatus = priced.pricingResolved ? 'resolved' : 'unresolved';
  const userId = options?.userId ?? 0;
  const attribution = resolveApiUsageAttribution(category, userId);
  let apiUsageId: number | null = null;

  // Persist to SQLite. This is quota truth, so both INSERT paths failing is
  // fatal and trips the process-wide metering-degraded latch.
  //
  // April 9 2026: fixed a long-standing latent bug where the INSERT
  // omitted `user_id` entirely. Migration 029 added the `user_id`
  // column to `api_usage` with `NOT NULL DEFAULT 0` so every existing
  // row silently got user_id=0. That meant:
  //
  //   • `cost-guardrail.isUserOverDailyCap(userId)` queries
  //     `WHERE user_id = ?` and found zero rows for any real user
  //     (they all had user_id=0), so the per-user cost cap was
  //     effectively disabled for everyone
  //   • Per-domain cost attribution per user was impossible
  //   • The admin portal's per-user cost breakdown would show
  //     every call under user_id=0
  //
  // Fix: persist `options?.userId ?? 0` into the INSERT. Calls that
  // legitimately don't have a user attached (classifier passes, scheduled
  // briefings, etc.) still fall back to 0 — same as before — so no
  // behaviour changes for those paths. Calls that DO have a userId now
  // write it, enabling per-user enforcement for the first time.
  try {
    const result = getDb().prepare(`
      INSERT INTO api_usage
        (category, model, tenant_id, user_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, duration_ms,
         provider, pricing_status, pricing_model_key,
         request_source, job_name, base_category, run_id,
         provider_tool_cost_usd, web_search_requests, grounded_search_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'anthropic', ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      category,
      params.model,
      options?.tenantId ?? options?.userId ?? 0,
      options?.userId ?? 0,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      cost,
      durationMs,
      pricingStatus,
      priced.pricingModelKey,
      attribution.requestSource,
      attribution.jobName,
      attribution.baseCategory,
      attribution.runId,
      providerToolCostUsd,
      webSearchRequests,
    );
    apiUsageId = Number((result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0);
  } catch (err) {
    try {
      apiUsageId = insertApiUsageFallback(getDb(), {
        category,
        model: params.model,
        provider: 'anthropic',
        tenantId: options?.tenantId ?? options?.userId ?? 0,
        userId: options?.userId ?? 0,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        costUsd: cost,
        durationMs,
        pricingStatus: 'legacy',
        providerToolCostUsd,
        webSearchRequests,
        groundedSearchPrompts: 0,
      });
    } catch (fallbackErr) {
      const persistenceError = tripApiUsagePersistenceFailure('anthropic', category);
      logger.error(
        { errorName: safeProviderErrorName(fallbackErr), code: persistenceError.code },
        'Failed to record Anthropic api_usage; AI usage persistence degraded',
      );
      throw persistenceError;
    }
  }

  // Record per-user usage metering (non-critical — swallow errors)
  try {
    const { recordUsage } = require('../services/usage-metering');
    recordUsage(
      options?.userId ?? 0,
      usage.input_tokens,
      usage.output_tokens,
      cost,
      options?.isUserMessage ?? false,
    );
  } catch (err) {
    logger.warn({ errorName: safeProviderErrorName(err) }, 'Failed to record usage metering');
  }

  // Push activity event
  try {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Anthropic API call metered [${category}]`,
      durationMs,
    });
  } catch (eventErr) {
    logger.warn(
      { errorName: safeProviderErrorName(eventErr), userId, category },
      'Failed to publish Anthropic usage telemetry',
    );
  }
  try {
    await settleNexusPointOverageForUser(options?.userId ?? 0, apiUsageId);
  } catch (settleErr) {
    logger.warn(
      { errorName: safeProviderErrorName(settleErr), apiUsageId, userId },
      'nexus_points: Anthropic usage settlement failed',
    );
  }

  throwIfCancelled();
  return response;
}
