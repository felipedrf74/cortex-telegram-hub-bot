// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Gemini Provider — AIProvider implementation backed by Google Gemini models.
 *
 * Translates between the provider-agnostic AIProvider interface and the
 * Google Generative AI SDK. Uses the same tool definitions and system
 * prompts as the Anthropic provider for consistency.
 *
 * Features:
 * - Token usage tracking (persisted to api_usage table)
 * - Retry on 429/503/500/RESOURCE_EXHAUSTED/UNAVAILABLE/network resets
 *   (chat path via GeminiProvider.withRetry; one-shot PRIMARY stage via
 *   withOneShotPrimaryRetry, tunable with GEMINI_ONESHOT_MAX_RETRIES)
 * - Mapped errors with provider/status/retryable for FallbackProvider
 * - Deterministic tool call IDs (counter-based)
 * - Defensive tool conversation mapping
 */

import {
  GoogleGenerativeAI,
  Content,
  Part,
  FunctionDeclaration,
  FunctionCallingMode,
  SchemaType,
  type GenerateContentResult,
} from './gemini-adapter';
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
import type Anthropic from '@anthropic-ai/sdk';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDomainSystemPrompt, getClassifierSystemPrompt, TOOLS } from './anthropic';
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
import { withTimeout } from '../utils/timeout';
import { canUseAnthropicRuntimeFallback, getAICallTimeoutMs } from './runtime-flags';
import { buildScopedStateContextPrefix } from './provider-state-context';
import { getDomainModelOverride, type DomainModelRole } from './model-config';
import {
  computeModelUsageCostUsd,
  computeProviderCallCostUpperBoundUsd,
  getProviderToolFeeUsd,
  recordUnresolvedModelPricingAlert,
  resolveModelPricing,
} from './model-pricing';
import { settleNexusPointOverageForUser } from './nexus-points';
import {
  ApiUsagePersistenceError,
  insertApiUsageFallback,
  recordApiUsageTimeoutEstimate,
  tripApiUsagePersistenceFailure,
} from './api-usage-fallback';
import { resolveApiUsageAttribution } from './api-usage-attribution';
import { assertAiBudgetReservationForProvider } from './cost-guardrail';
import { resolveCoachSafetyLocale, type CoachSafetyLocale } from './coach-kernel/safety-guardrails';
import { getUserLanguageById } from './user-service';

// ─── Client (lazy init — only created if API key is set) ────────────

let _client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!_client) {
    if (!config.gemini.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    _client = new GoogleGenerativeAI(config.gemini.apiKey);
  }
  return _client;
}

/** Check if Gemini is configured (has API key) */
export function isGeminiProviderConfigured(): boolean {
  return !!config.gemini.apiKey;
}

// ─── Provider safety policy ─────────────────────────────────────────
//
// App Review guidelines 1.1 / 1.2: every generation call has to declare a
// deliberate content-safety posture instead of inheriting whatever the SDK
// happens to default to. Declared once here and applied at EVERY
// `getGenerativeModel` call site through `withGeminiSafetySettings`.
//
// Category values mirror @google/genai's `HarmCategory` / `HarmBlockThreshold`
// string enums. They are declared locally rather than imported from the SDK
// for the same reason `FunctionCallingMode` and `SchemaType` are declared in
// gemini-adapter.ts: this module talks to the adapter, not to the SDK.

export const GEMINI_HARM_CATEGORY = {
  HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
  HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
  SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
} as const;

export const GEMINI_HARM_BLOCK_THRESHOLD = {
  BLOCK_LOW_AND_ABOVE: 'BLOCK_LOW_AND_ABOVE',
  BLOCK_MEDIUM_AND_ABOVE: 'BLOCK_MEDIUM_AND_ABOVE',
  BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
  BLOCK_NONE: 'BLOCK_NONE',
} as const;

/**
 * The one safety posture every Gemini call runs under.
 *
 * `BLOCK_MEDIUM_AND_ABOVE` on all four categories. Harassment, hate speech
 * and sexually explicit content have no legitimate use in any Nexus surface.
 * Dangerous content stays at the same threshold rather than being relaxed:
 * the app's own deterministic guardrails
 * (`coach-kernel/safety-guardrails.ts`) own the legitimate
 * training/nutrition edge cases, so the provider filter does not need to be
 * loosened to keep coaching answers working.
 */
export const GEMINI_SAFETY_SETTINGS: ReadonlyArray<{ category: string; threshold: string }> = [
  { category: GEMINI_HARM_CATEGORY.HARASSMENT, threshold: GEMINI_HARM_BLOCK_THRESHOLD.BLOCK_MEDIUM_AND_ABOVE },
  { category: GEMINI_HARM_CATEGORY.HATE_SPEECH, threshold: GEMINI_HARM_BLOCK_THRESHOLD.BLOCK_MEDIUM_AND_ABOVE },
  { category: GEMINI_HARM_CATEGORY.SEXUALLY_EXPLICIT, threshold: GEMINI_HARM_BLOCK_THRESHOLD.BLOCK_MEDIUM_AND_ABOVE },
  { category: GEMINI_HARM_CATEGORY.DANGEROUS_CONTENT, threshold: GEMINI_HARM_BLOCK_THRESHOLD.BLOCK_MEDIUM_AND_ABOVE },
];

/**
 * Merge the safety policy into a `generationConfig` bag.
 *
 * The compat adapter spreads `generationConfig` straight into the
 * @google/genai `GenerateContentConfig`, where `safetySettings` is a
 * top-level field — so this is the supported way to declare the policy
 * without widening the adapter's option shape.
 */
export function withGeminiSafetySettings(
  generationConfig: Record<string, unknown>,
): Record<string, unknown> {
  return { ...generationConfig, safetySettings: GEMINI_SAFETY_SETTINGS };
}

// ─── Safety-blocked completions ─────────────────────────────────────

/**
 * `finishReason` values that mean "the provider refused to return this
 * completion". They produce an EMPTY candidate, so without this check the
 * caller silently ships a blank or truncated answer.
 */
const GEMINI_SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

/** Normalized stop reason handed back to callers for a provider safety block. */
export const GEMINI_SAFETY_BLOCK_STOP_REASON = 'SAFETY_BLOCKED';

/**
 * Machine code carried on the thrown error so the API edge can classify a
 * provider refusal. The one-shot helpers throw rather than return, so this
 * error never renders as product copy — the user-facing strings are the
 * `GEMINI_SAFETY_BLOCK_MESSAGE*` constants below.
 */
export const GEMINI_SAFETY_BLOCK_ERROR_CODE = 'AI_SAFETY_BLOCKED';

/**
 * User-facing refusal copy for a provider safety block on the CHAT path.
 *
 * This string is returned as the answer text, so it is product copy, not a
 * developer fallback: nothing downstream re-renders it. The app ships EN,
 * pt-PT and pt-BR, so it is resolved per user through
 * `renderGeminiSafetyBlockMessage` before it reaches the turn.
 */
export const GEMINI_SAFETY_BLOCK_MESSAGE =
  "I can't help with that request — the safety filter on the AI model blocked the response. " +
  'Try rephrasing it, and if this is about symptoms, pain, or anything urgent, please contact a ' +
  'qualified professional directly.';

/** Portuguese rendering of `GEMINI_SAFETY_BLOCK_MESSAGE` (pt-PT / pt-BR). */
export const GEMINI_SAFETY_BLOCK_MESSAGE_PT =
  'Não consigo ajudar com esse pedido — o filtro de segurança do modelo de IA bloqueou a resposta. ' +
  'Tente reformular e, se isto for sobre sintomas, dores, ou algo urgente, procure diretamente um ' +
  'profissional qualificado.';

/** Resolve the refusal copy for a locale, using the shared coach-safety locale map. */
export function renderGeminiSafetyBlockMessage(locale: CoachSafetyLocale): string {
  return locale === 'pt' ? GEMINI_SAFETY_BLOCK_MESSAGE_PT : GEMINI_SAFETY_BLOCK_MESSAGE;
}

/**
 * Best-effort language lookup for the safety-refusal copy. A lookup
 * failure falls back to English rather than failing the turn — the refusal
 * still has to reach the user.
 */
function resolveSafetyCopyLocale(userId: number | undefined): CoachSafetyLocale {
  if (typeof userId !== 'number' || !Number.isFinite(userId) || userId <= 0) return 'en';
  try {
    return resolveCoachSafetyLocale(getUserLanguageById(userId));
  } catch {
    return 'en';
  }
}

export function isGeminiSafetyFinishReason(finishReason: string | undefined | null): boolean {
  if (!finishReason) return false;
  return GEMINI_SAFETY_FINISH_REASONS.has(String(finishReason).trim().toUpperCase());
}

/**
 * Detect a provider-side safety block on a completed response. Checks both
 * the candidate `finishReason` and `promptFeedback.blockReason` — the second
 * one fires when the PROMPT was rejected and no candidate is returned at all.
 */
export function detectGeminiSafetyBlock(
  result: GenerateContentResult,
): { finishReason: string; categories: string[] } | null {
  type SafetyRating = { category?: string; blocked?: boolean };
  type PromptFeedback = { blockReason?: string; safetyRatings?: SafetyRating[] };
  const response = result.response as unknown as {
    candidates?: Array<{ finishReason?: string; safetyRatings?: SafetyRating[] }>;
    promptFeedback?: PromptFeedback;
  };
  const candidate = response?.candidates?.[0];
  // The compat adapter forwards only `candidates` + `usageMetadata` onto
  // `response`, so prompt-level feedback has to be read off the raw SDK
  // payload it also attaches. Both are checked so this keeps working if the
  // adapter ever starts forwarding the field.
  const promptFeedback: PromptFeedback | undefined = response?.promptFeedback
    ?? (result as unknown as { rawResponse?: { promptFeedback?: PromptFeedback } }).rawResponse?.promptFeedback;

  const candidateReason = String(candidate?.finishReason ?? '').trim().toUpperCase();
  if (isGeminiSafetyFinishReason(candidateReason)) {
    return {
      finishReason: candidateReason,
      categories: blockedSafetyCategories(candidate, promptFeedback),
    };
  }
  // `promptFeedback.blockReason` is only populated when the PROMPT itself was
  // rejected — in that case there is no candidate at all, so the finishReason
  // check above can't see it.
  const promptBlockReason = String(promptFeedback?.blockReason ?? '').trim().toUpperCase();
  if (promptBlockReason && promptBlockReason !== 'BLOCKED_REASON_UNSPECIFIED') {
    return {
      finishReason: promptBlockReason,
      categories: blockedSafetyCategories(candidate, promptFeedback),
    };
  }
  return null;
}

/**
 * Chat-path counterpart of `throwGeminiSafetyBlock`.
 *
 * `callDomain` / `continueWithToolResults` return a structured
 * `AICallResult`, so a block is expressed as a normal result carrying the
 * `SAFETY_BLOCKED` stop reason instead of an exception. Throwing here would
 * hand the turn to the Anthropic fallback and quietly undo the decision the
 * provider just made.
 *
 * The returned text IS what the user sees — no downstream renderer switches
 * on `GEMINI_SAFETY_BLOCK_STOP_REASON` — so the copy is localized here.
 */
function buildGeminiSafetyBlockedCallResult(
  block: { finishReason: string; categories: string[] },
  domain: DomainName,
  userId?: number,
): AICallResult {
  logger.warn(
    { domain, finishReason: block.finishReason, blockedCategories: block.categories },
    'Gemini domain response blocked by provider safety filter',
  );
  return {
    text: renderGeminiSafetyBlockMessage(resolveSafetyCopyLocale(userId)),
    toolCalls: [],
    stopReason: GEMINI_SAFETY_BLOCK_STOP_REASON,
  };
}

function blockedSafetyCategories(
  candidate: { safetyRatings?: Array<{ category?: string; blocked?: boolean }> } | undefined,
  promptFeedback: { safetyRatings?: Array<{ category?: string; blocked?: boolean }> } | undefined,
): string[] {
  const ratings = [...(candidate?.safetyRatings ?? []), ...(promptFeedback?.safetyRatings ?? [])];
  return [...new Set(
    ratings.filter((rating) => rating?.blocked && typeof rating.category === 'string')
      .map((rating) => String(rating.category)),
  )];
}

/**
 * Throw a mapped, NON-retryable safety error. Used by the one-shot helpers,
 * which return a bare string and therefore have no way to hand the caller a
 * structured "blocked" signal. Mirrors the shape the grounded-search path
 * already throws for incomplete responses.
 */
function throwGeminiSafetyBlock(
  block: { finishReason: string; categories: string[] },
  category: string,
): never {
  const err = new Error(`Gemini response blocked by provider safety filter: ${block.finishReason}`);
  (err as any).provider = 'gemini';
  (err as any).code = GEMINI_SAFETY_BLOCK_ERROR_CODE;
  (err as any).finishReason = block.finishReason;
  (err as any).safetyBlocked = true;
  (err as any).retryable = false;
  logger.warn(
    { category, finishReason: block.finishReason, blockedCategories: block.categories },
    'Gemini completion blocked by provider safety filter',
  );
  throw err;
}

// ─── Cost per million tokens ────────────────────────────────────────

export function resolveGeminiCostModelKey(model: string): string {
  return resolveModelPricing(model, 'gemini')?.model ?? 'pricing-unresolved';
}

const warnedUnresolvedModels = new Set<string>();

function warnUnresolvedGeminiPricing(model: string, category: string, userId: number): void {
  const key = `${model}:${category}`;
  if (warnedUnresolvedModels.has(key)) return;
  warnedUnresolvedModels.add(key);
  recordUnresolvedModelPricingAlert({ provider: 'gemini', model, category, userId });
}

type GeminiUsageForBilling = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

function getBillableGeminiTokenCounts(usage: GeminiUsageForBilling): {
  inputTokens: number;
  outputTokens: number;
} {
  const toolUseInput = usage.toolUsePromptTokenCount ?? 0;
  const thoughtsOutput = usage.thoughtsTokenCount ?? 0;
  const accounted = usage.promptTokenCount
    + usage.candidatesTokenCount
    + toolUseInput
    + thoughtsOutput;
  // Gemini documents totalTokenCount as prompt + candidates + tool-use input
  // + thoughts. If a future SDK omits a component but returns the total, book
  // the unexplained remainder at the more expensive output rate.
  const unexplained = Math.max(0, (usage.totalTokenCount ?? accounted) - accounted);
  return {
    inputTokens: usage.promptTokenCount + toolUseInput,
    outputTokens: usage.candidatesTokenCount + thoughtsOutput + unexplained,
  };
}

export function computeGeminiCost(model: string, usage: GeminiUsageForBilling): number {
  const billable = getBillableGeminiTokenCounts(usage);
  return computeModelUsageCostUsd(model, {
    inputTokens: billable.inputTokens,
    outputTokens: billable.outputTokens,
    cacheReadTokens: usage.cachedContentTokenCount ?? 0,
  }, 'gemini').costUsd;
}

async function logGeminiUsage(
  model: string,
  category: string,
  usage: GeminiUsageForBilling,
  durationMs: number,
  userId: number = 0,
  tenantId: number = userId,
  nonTokenCostUsd: number = 0,
  groundedSearchPrompts: number = 0,
): Promise<void> {
  const cacheReadTokens = usage.cachedContentTokenCount ?? 0;
  const billable = getBillableGeminiTokenCounts(usage);
  const priced = computeModelUsageCostUsd(model, {
    inputTokens: billable.inputTokens,
    outputTokens: billable.outputTokens,
    cacheReadTokens,
    nonTokenCostUsd,
  }, 'gemini');
  if (!priced.pricingResolved) {
    warnUnresolvedGeminiPricing(model, category, userId);
  }
  const cost = priced.costUsd;
  const pricingStatus = priced.pricingResolved ? 'resolved' : 'unresolved';
  const attribution = resolveApiUsageAttribution(category, userId);
  let apiUsageId: number | null = null;
  try {
    const db = getDb();
    // April 9 2026: persist `user_id` into the INSERT. Previously
    // omitted, so every Gemini row silently had user_id=0 via the
    // `NOT NULL DEFAULT 0` from migration 029 — see the matching
    // fix in `src/portal/anthropic-hook.ts` for the full story.
    // Per-user cost enforcement (cost-guardrail.isUserOverDailyCap)
    // was effectively disabled until both INSERT statements were
    // updated.
    const result = db.prepare(`
      INSERT INTO api_usage (category, model, tenant_id, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider, pricing_status, pricing_model_key, request_source, job_name, base_category, run_id, provider_tool_cost_usd, web_search_requests, grounded_search_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'gemini', ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(category, model, tenantId, userId, billable.inputTokens, billable.outputTokens, cacheReadTokens, cost, durationMs, pricingStatus, priced.pricingModelKey, attribution.requestSource, attribution.jobName, attribution.baseCategory, attribution.runId, nonTokenCostUsd, groundedSearchPrompts);
    apiUsageId = Number((result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0);
  } catch (err) {
    try {
      const db = getDb();
      apiUsageId = insertApiUsageFallback(db, {
        category,
        model,
        provider: 'gemini',
        tenantId,
        userId,
        inputTokens: billable.inputTokens,
        outputTokens: billable.outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        costUsd: cost,
        durationMs,
        pricingStatus: 'legacy',
        providerToolCostUsd: nonTokenCostUsd,
        webSearchRequests: 0,
        groundedSearchPrompts,
      });
    } catch (fallbackErr) {
      const persistenceError = tripApiUsagePersistenceFailure('gemini', category);
      logger.error({ err: fallbackErr, code: persistenceError.code }, 'Failed to log Gemini usage; AI usage persistence degraded');
      throw persistenceError;
    }
  }

  // Everything below is post-quota-truth analytics/settlement. Keep it out of
  // the INSERT fallback catch: a telemetry or Points failure after a successful
  // INSERT must never create a duplicate api_usage row for the same call.
  try {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Gemini ${model}: ${billable.inputTokens}+${billable.outputTokens} billable tokens ($${cost.toFixed(4)})`,
      durationMs,
    });
  } catch (eventErr) {
    logger.warn({ err: eventErr, userId, category }, 'Failed to publish Gemini usage telemetry');
  }
  // April 2026 follow-up: mirror anthropic-hook's per-user metering so
  // `usage_metering` aggregates reflect Gemini traffic (the dominant
  // provider). Without this, checkQuota silently sees an empty table.
  try {
    const { recordUsage } = require('./usage-metering') as typeof import('./usage-metering');
    recordUsage(userId, billable.inputTokens, billable.outputTokens, cost, false);
  } catch (meterErr) {
    logger.warn({ err: meterErr, userId }, 'Failed to record Gemini usage_metering');
  }
  try {
    await settleNexusPointOverageForUser(userId, apiUsageId);
  } catch (settleErr) {
    logger.warn({ err: settleErr, apiUsageId, userId }, 'nexus_points: Gemini usage settlement failed');
  }
}

async function logRequiredGeminiUsage(
  model: string,
  category: string,
  usage: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
    toolUsePromptTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
    totalTokenCount?: unknown;
  } | null | undefined,
  durationMs: number,
  userId = 0,
  tenantId = userId,
  nonTokenCostUsd = 0,
  groundedSearchPrompts = 0,
): Promise<void> {
  const promptTokenCount = Number(usage?.promptTokenCount);
  const candidatesTokenCount = Number(usage?.candidatesTokenCount);
  const rawCacheRead = usage?.cachedContentTokenCount == null ? 0 : Number(usage.cachedContentTokenCount);
  const toolUsePromptTokenCount = usage?.toolUsePromptTokenCount == null ? 0 : Number(usage.toolUsePromptTokenCount);
  const thoughtsTokenCount = usage?.thoughtsTokenCount == null ? 0 : Number(usage.thoughtsTokenCount);
  const totalTokenCount = usage?.totalTokenCount == null ? undefined : Number(usage.totalTokenCount);
  if (
    !usage
    || !Number.isFinite(promptTokenCount)
    || promptTokenCount < 0
    || !Number.isFinite(candidatesTokenCount)
    || candidatesTokenCount < 0
    || !Number.isFinite(rawCacheRead)
    || rawCacheRead < 0
    || !Number.isFinite(toolUsePromptTokenCount)
    || toolUsePromptTokenCount < 0
    || !Number.isFinite(thoughtsTokenCount)
    || thoughtsTokenCount < 0
    || (totalTokenCount != null && (!Number.isFinite(totalTokenCount) || totalTokenCount < 0))
  ) {
    const persistenceError = tripApiUsagePersistenceFailure('gemini', category);
    logger.error({ code: persistenceError.code, category, model }, 'Gemini response omitted valid usage metadata; AI usage persistence degraded');
    throw persistenceError;
  }
  await logGeminiUsage(model, category, {
    promptTokenCount,
    candidatesTokenCount,
    cachedContentTokenCount: rawCacheRead,
    toolUsePromptTokenCount,
    thoughtsTokenCount,
    totalTokenCount,
  }, durationMs, userId, tenantId, nonTokenCostUsd, groundedSearchPrompts);
}

function recordGeminiTimeoutEstimate(input: {
  category: string;
  model: string;
  userId: number;
  tenantId: number;
  maxCostUsd: number;
  timeoutMs: number;
  providerToolCostUsd?: number;
  groundedSearchPrompts?: number;
}): void {
  const apiUsageId = recordApiUsageTimeoutEstimate({
    ...input,
    provider: 'gemini',
  });
  void settleNexusPointOverageForUser(input.userId, apiUsageId).catch((settleErr) => {
    logger.warn(
      { err: settleErr, apiUsageId, category: input.category },
      'nexus_points: Gemini timeout estimate settlement failed',
    );
  });
}

function getGeminiGroundingMetadata(response: unknown): Record<string, unknown> | null {
  const metadata = (response as any)?.candidates?.[0]?.groundingMetadata;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null;
}

function didGeminiUseGrounding(response: unknown): boolean {
  const metadata = getGeminiGroundingMetadata(response);
  if (!metadata) return false;
  return (Array.isArray(metadata.groundingChunks) && metadata.groundingChunks.length > 0)
    || (Array.isArray(metadata.webSearchQueries) && metadata.webSearchQueries.length > 0)
    || (Array.isArray(metadata.groundingSupports) && metadata.groundingSupports.length > 0)
    || (metadata.searchEntryPoint != null && typeof metadata.searchEntryPoint === 'object');
}

function rethrowUsagePersistenceFailure(error: unknown): void {
  if (error instanceof ApiUsagePersistenceError
    || (error as { name?: string })?.name === 'ApiUsagePersistenceError'
    || (error as { name?: string })?.name === 'AiBudgetError') {
    throw error;
  }
}

/**
 * A provider-side safety block is a DECISION, not an outage.
 *
 * The one-shot helpers surface it as a mapped `safetyBlocked` error. Without
 * this guard the fallback wrappers would treat it like any other Gemini
 * failure and re-ask the same blocked prompt on the Gemini fallback model,
 * then OpenAI, then the Anthropic thunk — none of which can detect a peer
 * provider's refusal. The block would then prevent nothing while costing
 * three extra paid calls, so it is rethrown immediately, exactly like a
 * usage-persistence failure.
 */
function rethrowProviderSafetyBlock(error: unknown): void {
  const mapped = error as { safetyBlocked?: boolean; code?: string };
  if (mapped?.safetyBlocked === true || mapped?.code === GEMINI_SAFETY_BLOCK_ERROR_CODE) {
    throw error;
  }
}

// ─── One-shot completion (no tools, no domain) ──────────────────────

/**
 * Single-prompt chat completion via Gemini for non-domain calls like
 * coach analysis, knowledge synthesis, voice evolution, content workflows.
 * Bypasses the AIProvider interface because these calls don't fit the
 * domain-handler shape (no conversation history, no tools, just one
 * structured prompt → one structured response).
 *
 * Logs to api_usage with the supplied category for cost tracking.
 * Returns plain text. Throws on Gemini errors so the caller can fall
 * back to Anthropic if it wants to.
 *
 * Default model is `config.gemini.model` (gemini-2.5-flash). For high-stakes
 * analytical calls (e.g. coach_analysis with ~12K input tokens), this is
 * ~5.5× cheaper per call than Claude Sonnet 4.6 with comparable quality.
 */
type OneShotOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  userId?: number;
  tenantId?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
  /** Optional caller-specific retry cap; bounded by the global safety cap. */
  maxRetries?: number;
};

const SEARCH_PROMPT_PRIVACY_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]'],
  [/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '[redacted-phone]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted-ssn]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[redacted-card]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/gi, '[redacted-api-key]'],
  [/\b((?:access_token|refresh_token|id_token|client_secret|api_key|token|secret|password|authorization|cookie))=([^&\s]+)/gi, '$1=[redacted]'],
  [/(https?:\/\/[^\s?]+)\?[^ \n]+/gi, '$1?[redacted-query]'],
];

export function scrubSearchGroundingPromptForPrivacy(value: string): string {
  let scrubbed = value;
  for (const [pattern, replacement] of SEARCH_PROMPT_PRIVACY_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

export async function completeOneShot(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  options?: OneShotOptions,
): Promise<string> {
  if (!isGeminiProviderConfigured()) {
    throw new Error('Gemini provider not configured (GEMINI_API_KEY missing)');
  }
  const model = options?.model ?? config.gemini.model;
  const maxTokens = options?.maxTokens ?? 2500;
  const temperature = options?.temperature ?? 0.7;
  const client = getClient();
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: withGeminiSafetySettings({
      maxOutputTokens: maxTokens,
      temperature,
      ...(options?.jsonMode ? { responseMimeType: 'application/json' } : {}),
    }),
  });

  const maxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'gemini',
    model,
    payload: { systemPrompt, userPrompt, maxTokens, temperature, jsonMode: options?.jsonMode ?? false },
    maxOutputTokens: maxTokens,
  });
  assertAiBudgetReservationForProvider({
    userId: options?.userId ?? 0,
    category,
    provider: 'gemini',
    model,
    maxCostUsd,
  });
  const start = Date.now();
  const timeoutMs = options?.timeoutMs ?? config.aiSafety.callTimeoutMs;
  const result = await withTimeout(
    genModel.generateContent([{ text: userPrompt }]),
    timeoutMs,
    {
      onTimeout: () => recordGeminiTimeoutEstimate({
        category,
        model,
        userId: options?.userId ?? 0,
        tenantId: options?.tenantId ?? options?.userId ?? 0,
        maxCostUsd,
        timeoutMs,
      }),
    },
  );
  const durationMs = Date.now() - start;

  await logRequiredGeminiUsage(
    model,
    category,
    result.response.usageMetadata,
    durationMs,
    options?.userId ?? 0,
    options?.tenantId ?? options?.userId ?? 0,
  );

  // A safety-blocked candidate carries no text. Returning '' here used to
  // look like a successful empty answer; surface it as a mapped,
  // non-retryable error so the caller can fall back or explain instead of
  // shipping a blank message.
  const safetyBlock = detectGeminiSafetyBlock(result);
  if (safetyBlock) throwGeminiSafetyBlock(safetyBlock, category);

  return extractText(result);
}

function resolveGeminiOneShotFallbackModel(primaryModel: string): string | null {
  const candidates = [
    process.env.GEMINI_FALLBACK_MODEL,
    config.gemini.classifierModel,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => candidate !== primaryModel) ?? null;
}

// ─── Shared retryable-error classification ──────────────────────────

/** Node error codes that indicate a transient network failure worth retrying. */
const TRANSIENT_NETWORK_CODES: readonly string[] = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'];

type GeminiErrorInfo = { status?: number; code?: string; message: string };

/**
 * Extract HTTP status + short diagnostic code from an unknown Gemini/SDK
 * error. `code` is either the Node network error code or the gRPC-style
 * keyword embedded in the message (RESOURCE_EXHAUSTED / UNAVAILABLE), so
 * warn logs stay greppable during provider storms.
 */
function extractGeminiErrorInfo(err: unknown): GeminiErrorInfo {
  const e = err as { status?: number; code?: string | number; response?: { status?: number }; message?: string };
  const message = typeof e?.message === 'string' ? e.message : '';
  const status = typeof e?.status === 'number'
    ? e.status
    : (typeof e?.response?.status === 'number' ? e.response.status : undefined);
  let code = typeof e?.code === 'string' ? e.code : undefined;
  if (!code) {
    const match = message.match(/\b(RESOURCE_EXHAUSTED|UNAVAILABLE|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN)\b/);
    if (match) code = match[1];
  }
  return { status, code, message };
}

/** Provider logs keep only a bounded machine code, never SDK error objects or messages. */
function safeProviderFailureCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : undefined;
}

/**
 * Shared retryable-error predicate for Gemini calls — used by BOTH the
 * chat-path GeminiProvider.withRetry and the one-shot primary retry so
 * the two paths can't drift. Retryable: 429/503/500, RESOURCE_EXHAUSTED,
 * UNAVAILABLE, and transient network resets. Everything else (plain 4xx,
 * safety blocks, AITimeoutError) is non-retryable and falls through to
 * the caller (fallback cascade / mapped error) immediately.
 */
function isRetryableGeminiError(info: GeminiErrorInfo): boolean {
  if (info.status === 429 || info.status === 503 || info.status === 500) return true;
  if (info.message.includes('RESOURCE_EXHAUSTED') || info.message.includes('UNAVAILABLE')) return true;
  if (info.code && TRANSIENT_NETWORK_CODES.includes(info.code)) return true;
  if (/socket hang up|fetch failed/i.test(info.message)) return true;
  return false;
}

// ─── One-shot primary retry ─────────────────────────────────────────

const ONESHOT_RETRY_DEFAULT_MAX_RETRIES = 2;
// Safety cap so a fat-fingered env value can't unbound the worst case
// (worst case = (maxRetries + 1) per-call timeouts + backoff sleeps).
const ONESHOT_RETRY_MAX_RETRIES_CAP = 5;
const ONESHOT_RETRY_BASE_BACKOFF_MS = 1000;

/** Parse a non-negative integer env var, falling back to a default. */
function parseNonNegativeIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

/**
 * Extra attempts (beyond the first) for the one-shot PRIMARY Gemini call.
 * GEMINI_ONESHOT_MAX_RETRIES: default 2 (3 attempts total), 0 disables
 * retry (single attempt — the pre-2026-07 behavior). Read at call time so
 * operators can flip it without a redeploy-triggering config change.
 */
function resolveOneShotMaxRetries(override?: number): number {
  const requested = override == null
    ? parseNonNegativeIntEnv('GEMINI_ONESHOT_MAX_RETRIES', ONESHOT_RETRY_DEFAULT_MAX_RETRIES)
    : Number.isFinite(override) && override >= 0
      ? Math.floor(override)
      : ONESHOT_RETRY_DEFAULT_MAX_RETRIES;
  return Math.min(
    requested,
    ONESHOT_RETRY_MAX_RETRIES_CAP,
  );
}

/** Exponential backoff (1s, 2s, ...) with ±25% jitter to decorrelate top-of-hour cron bursts. */
function oneShotBackoffMs(retryIndex: number): number {
  const base = ONESHOT_RETRY_BASE_BACKOFF_MS * Math.pow(2, retryIndex);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Run the one-shot PRIMARY Gemini call with bounded retry on transient
 * errors. Production logs showed 372 one-shot failures in ~5 weeks — all
 * HTTP 503 "high demand" bursts clustered at top-of-hour crons — and each
 * one skipped the cheap primary model entirely because the old path
 * cascaded to fallbacks on the very first throw (while the chat path
 * already had withRetry and the OpenAI hop retries internally).
 *
 * Each attempt keeps its own per-call timeout (applied inside
 * completeOneShot / completeVisionOneShot via withTimeout), so the worst
 * case stays bounded at (maxRetries + 1) timeouts plus ~3s of backoff.
 * Non-retryable errors are re-thrown immediately so the fallback cascade
 * behaves exactly as before.
 *
 * Applies ONLY to the primary stage: the flash-lite fallback stage is
 * already the second chance, and the OpenAI stage retries internally.
 * The final error is annotated with `geminiOneShotAttempts` so the
 * fallback warn logs can report how many attempts were burned.
 */
async function withOneShotPrimaryRetry<T>(
  fn: () => Promise<T>,
  logContext: { category: string; model: string },
  maxRetriesOverride?: number,
): Promise<T> {
  const maxRetries = resolveOneShotMaxRetries(maxRetriesOverride);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const info = extractGeminiErrorInfo(err);
      try {
        (err as { geminiOneShotAttempts?: number }).geminiOneShotAttempts = attempt;
      } catch {
        /* frozen or primitive error — attempt count defaults to 1 in fallback logs */
      }
      if (!isRetryableGeminiError(info) || attempt > maxRetries) throw err;
      const backoffMs = oneShotBackoffMs(attempt - 1);
      logger.warn({
        category: logContext.category,
        model: logContext.model,
        attempt,
        maxAttempts: maxRetries + 1,
        status: info.status,
        code: safeProviderFailureCode(info.code),
        backoffMs,
      }, 'Gemini one-shot primary retrying after transient error');
      await _sleep.fn(backoffMs);
    }
  }
}

/**
 * Single-prompt completion with Google Search grounding enabled.
 *
 * Gemini 2.5 Flash exposes Google Search as a built-in tool — the model
 * decides when to search, fetches live results, and grounds its output
 * against them. This is the Gemini equivalent of Anthropic's web_search_*
 * tool, and the only Google-side way to get live-internet context into
 * a response.
 *
 * Important: Google Search grounding requires a model that supports it.
 * As of 2026-04, gemini-2.5-flash and gemini-2.5-pro both support it;
 * flash-lite does NOT. Default here is flash.
 *
 * Cost note: Gemini's project-wide free grounding allowance cannot be proven
 * from this process because other clients may share the API project. The
 * canonical fee helper therefore defaults to the billable per-prompt price;
 * operations may set an effective zero only after guaranteeing isolation.
 *
 * Throws on Gemini errors so the caller can fall back to Anthropic.
 */
export async function completeOneShotWithSearch(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  options?: { model?: string; maxTokens?: number; temperature?: number; userId?: number; tenantId?: number },
): Promise<{ text: string; sources: string[] }> {
  if (!isGeminiProviderConfigured()) {
    throw new Error('Gemini provider not configured (GEMINI_API_KEY missing)');
  }
  const model = options?.model ?? config.gemini.model;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0.7;
  const client = getClient();
  const safeSystemPrompt = scrubSearchGroundingPromptForPrivacy(systemPrompt);
  const safeUserPrompt = scrubSearchGroundingPromptForPrivacy(userPrompt);

  // The current @google/genai SDK exposes Google Search grounding through
  // `{ googleSearch: {} }`. Keep this centralized so legacy research routes
  // do not silently degrade when the SDK rejects an obsolete tool shape.
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: safeSystemPrompt,
    generationConfig: withGeminiSafetySettings({
      maxOutputTokens: maxTokens,
      temperature,
    }),
    tools: [{ googleSearch: {} }] as any,
  });

  const maxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'gemini',
    model,
    payload: { safeSystemPrompt, safeUserPrompt, maxTokens, temperature, googleSearch: true },
    maxOutputTokens: maxTokens,
    nonTokenCostUpperBoundUsd: getProviderToolFeeUsd('gemini_grounded_prompt'),
  });
  assertAiBudgetReservationForProvider({
    userId: options?.userId ?? 0,
    category,
    provider: 'gemini',
    model,
    hasUnboundedProviderInjectedContext: true,
    maxCostUsd,
  });
  const start = Date.now();
  const timeoutMs = config.aiSafety.callTimeoutMs;
  const result = await withTimeout(
    genModel.generateContent([{ text: safeUserPrompt }]),
    timeoutMs,
    {
      onTimeout: () => recordGeminiTimeoutEstimate({
        category,
        model,
        userId: options?.userId ?? 0,
        tenantId: options?.tenantId ?? options?.userId ?? 0,
        maxCostUsd,
        timeoutMs,
        providerToolCostUsd: getProviderToolFeeUsd('gemini_grounded_prompt'),
        groundedSearchPrompts: 1,
      }),
    },
  );
  const durationMs = Date.now() - start;
  const groundingUsed = didGeminiUseGrounding(result.response);

  await logRequiredGeminiUsage(
    model,
    category,
    result.response.usageMetadata,
    durationMs,
    options?.userId ?? 0,
    options?.tenantId ?? options?.userId ?? 0,
    groundingUsed ? getProviderToolFeeUsd('gemini_grounded_prompt') : 0,
    groundingUsed ? 1 : 0,
  );

  const finishReason = String((result.response as any).candidates?.[0]?.finishReason ?? '').trim();
  if (finishReason && !/^stop$/i.test(finishReason)) {
    const err = new Error(`Gemini search response incomplete: ${finishReason}`);
    (err as any).provider = 'gemini';
    (err as any).finishReason = finishReason;
    (err as any).retryable = /^max_tokens$|^recitation$|^other$/i.test(finishReason);
    throw err;
  }

  // Extract grounding sources (URLs) for transparency. When search was
  // actually used, Google attaches a `groundingMetadata` field with the
  // list of web chunks it pulled from. This lets the caller show citations
  // or log which URLs the model consulted.
  const sources: string[] = [];
  try {
    const metadata = getGeminiGroundingMetadata(result.response);
    const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
    for (const chunk of chunks) {
      const uri = chunk?.web?.uri;
      if (typeof uri === 'string') sources.push(uri);
    }
  } catch {
    /* grounding metadata is optional — not every prompt triggers search */
  }

  return { text: extractText(result), sources };
}

/**
 * Single-prompt chat completion with an image input (vision mode).
 *
 * Gemini accepts inline base64 images via `{ inlineData: { mimeType, data } }`
 * as part of the user prompt's Parts array. This wraps that plus the usual
 * logging and error handling so invoice-filer / future vision callers don't
 * have to repeat the boilerplate.
 *
 * Default model is `gemini-2.5-flash` because flash-lite doesn't support
 * vision inputs as of 2026-04 — verify in Google's model list before
 * downgrading. Cost is similar to Claude Haiku vision but ~6× cheaper
 * than Sonnet vision.
 *
 * Throws on Gemini errors so the caller can fall back to Anthropic
 * (see completeVisionOneShotWithFallback below).
 */
export async function completeVisionOneShot(
  systemPrompt: string,
  userPrompt: string,
  image: { base64: string; mimeType: string },
  category: string,
  options?: { model?: string; maxTokens?: number; temperature?: number; userId?: number; tenantId?: number },
): Promise<string> {
  if (!isGeminiProviderConfigured()) {
    throw new Error('Gemini provider not configured (GEMINI_API_KEY missing)');
  }
  // Default to flash — flash-lite doesn't support vision. If the caller
  // explicitly passed a model, respect it (they might have tested a
  // pro-vision tier for a higher-quality use case).
  const model = options?.model ?? config.gemini.model;
  const maxTokens = options?.maxTokens ?? 1024;
  const temperature = options?.temperature ?? 0.2; // low — we want structured JSON
  const client = getClient();
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: withGeminiSafetySettings({
      maxOutputTokens: maxTokens,
      temperature,
    }),
  });

  const maxCostUsd = computeProviderCallCostUpperBoundUsd({
    provider: 'gemini',
    model,
    payload: { systemPrompt, userPrompt, image, maxTokens, temperature },
    maxOutputTokens: maxTokens,
  });
  assertAiBudgetReservationForProvider({
    userId: options?.userId ?? 0,
    category,
    provider: 'gemini',
    model,
    maxCostUsd,
  });
  const start = Date.now();
  const timeoutMs = config.aiSafety.callTimeoutMs;
  const result = await withTimeout(
    genModel.generateContent([
      // Image MUST come before the text prompt — Gemini's own docs recommend
      // this order because vision models attend to the image first and then
      // the instruction. Flipping the order degrades accuracy noticeably.
      { inlineData: { mimeType: image.mimeType, data: image.base64 } },
      { text: userPrompt },
    ]),
    timeoutMs,
    {
      onTimeout: () => recordGeminiTimeoutEstimate({
        category,
        model,
        userId: options?.userId ?? 0,
        tenantId: options?.tenantId ?? options?.userId ?? 0,
        maxCostUsd,
        timeoutMs,
      }),
    },
  );
  const durationMs = Date.now() - start;

  await logRequiredGeminiUsage(
    model,
    category,
    result.response.usageMetadata,
    durationMs,
    options?.userId ?? 0,
    options?.tenantId ?? options?.userId ?? 0,
  );

  // A safety-blocked candidate carries no text. Returning '' here used to
  // look like a successful empty answer; surface it as a mapped,
  // non-retryable error so the caller can fall back or explain instead of
  // shipping a blank message.
  const safetyBlock = detectGeminiSafetyBlock(result);
  if (safetyBlock) throwGeminiSafetyBlock(safetyBlock, category);

  return extractText(result);
}

/**
 * Vision equivalent of completeOneShotWithFallback — tries Gemini vision
 * first, then tries OpenAI vision (GPT-4o), then the caller-supplied
 * Anthropic thunk as a last resort (gated on ANTHROPIC_ENABLED=true).
 *
 * April 9 2026: fallback order changed from `gemini → anthropic` to
 * `gemini → openai → anthropic (gated)`. The Anthropic thunk parameter
 * is preserved for backwards compatibility with every existing call
 * site, but it's now ONLY executed if the operator explicitly opts in
 * via the `ANTHROPIC_ENABLED=true` env var. Default is disabled, which
 * means in production this wrapper goes Gemini → OpenAI → throw.
 *
 * Return type still exposes `'anthropic'` as a possible provider for
 * the re-enabled path — callers don't need to change their type
 * handling if they were already switching on the provider field.
 */
export async function completeVisionOneShotWithFallback(
  systemPrompt: string,
  userPrompt: string,
  image: { base64: string; mimeType: string },
  category: string,
  anthropicFallback: () => Promise<string>,
  options?: { model?: string; maxTokens?: number; temperature?: number; userId?: number; tenantId?: number },
): Promise<{ text: string; provider: 'gemini' | 'openai' | 'anthropic' }> {
  // Stage 1: Gemini (primary) — bounded retry on transient errors so a
  // single 503 burst doesn't skip the cheap primary model entirely.
  if (isGeminiProviderConfigured()) {
    const primaryModel = options?.model ?? config.gemini.model;
    try {
      const text = await withOneShotPrimaryRetry(
        () => completeVisionOneShot(systemPrompt, userPrompt, image, category, options),
        { category, model: primaryModel },
      );
      return { text, provider: 'gemini' };
    } catch (err) {
      rethrowUsagePersistenceFailure(err);
      rethrowProviderSafetyBlock(err);
      const { status, code } = extractGeminiErrorInfo(err);
      const attempts = (err as { geminiOneShotAttempts?: number })?.geminiOneShotAttempts ?? 1;
      logger.warn({
        provider: 'gemini',
        category,
        model: primaryModel,
        status,
        code: safeProviderFailureCode(code),
        attempt: attempts,
        failureCategory: 'provider_call_failed',
      }, 'Gemini vision one-shot failed, trying OpenAI fallback');
    }
  }

  // Stage 2: OpenAI (new fallback — replaces Anthropic as of April 9 2026)
  // Dynamic require to avoid a circular import chain between the two
  // provider modules at load time.
  try {
    const openai = require('./openai-provider') as typeof import('./openai-provider');
    if (openai.isOpenAIConfigured()) {
      const text = await openai.completeVisionOneShot(
        systemPrompt,
        userPrompt,
        image,
        `${category}_openai_fallback`,
        options,
      );
      return { text, provider: 'openai' };
    }
  } catch (err) {
    rethrowUsagePersistenceFailure(err);
    const { status, code } = extractGeminiErrorInfo(err);
    logger.warn({
      provider: 'openai',
      category,
      status,
      code: safeProviderFailureCode(code),
      attempt: 1,
      failureCategory: 'provider_call_failed',
    }, 'OpenAI vision fallback also failed, trying Anthropic (if enabled)');
  }

  // Stage 3: Anthropic thunk — only if the operator has explicitly
  // re-enabled Anthropic via the env var. Default is disabled, so this
  // branch normally never runs. If the thunk's internal trackedCreate
  // call fires, the kill switch in anthropic-hook.ts will throw before
  // the SDK actually hits Anthropic.
  if (canUseAnthropicRuntimeFallback()) {
    const text = await anthropicFallback();
    return { text, provider: 'anthropic' };
  }

  throw new Error(
    `[completeVisionOneShotWithFallback] All providers failed for category='${category}'. ` +
    `Gemini: ${isGeminiProviderConfigured() ? 'failed' : 'not configured'}. ` +
    `OpenAI: ${config.openai.apiKey ? 'failed' : 'not configured'}. ` +
    `Anthropic: disabled (set ANTHROPIC_ENABLED=true to re-enable).`,
  );
}

/**
 * Convenience wrapper around `completeOneShot` that automatically falls back
 * from Gemini to OpenAI, then to a caller-supplied Anthropic path when that
 * final runtime fallback is enabled. Returns the result text plus which
 * provider produced it.
 *
 * Designed to be the standard pattern for migrating existing `trackedCreate`
 * call sites: instead of duplicating the try-catch-fallback boilerplate at
 * every site, callers pass their original Anthropic call as a thunk and
 * get a single-line migration.
 *
 * Example:
 *   const { text } = await completeOneShotWithFallback(
 *     systemPrompt,
 *     userPrompt,
 *     'knowledge_synthesis',
 *     async () => {
 *       const r = await trackedCreate(client, {...}, 'knowledge_synthesis');
 *       return r.content.filter(b => b.type === 'text').map(b => b.text).join('');
 *     },
 *     { maxTokens: 2048, temperature: 0.3 },
 *   );
 */
export async function completeOneShotWithFallback(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  anthropicFallback: () => Promise<string>,
  options?: OneShotOptions,
): Promise<{ text: string; provider: 'gemini' | 'openai' | 'anthropic' }> {
  // Stage 1: Gemini (primary) — bounded retry on transient errors so a
  // single 503 burst doesn't skip the cheap primary model entirely.
  if (isGeminiProviderConfigured()) {
    const primaryModel = options?.model ?? config.gemini.model;
    try {
      const text = await withOneShotPrimaryRetry(
        () => completeOneShot(systemPrompt, userPrompt, category, options),
        { category, model: primaryModel },
        options?.maxRetries,
      );
      return { text, provider: 'gemini' };
    } catch (err) {
      rethrowUsagePersistenceFailure(err);
      rethrowProviderSafetyBlock(err);
      const { status, code } = extractGeminiErrorInfo(err);
      const attempts = (err as { geminiOneShotAttempts?: number })?.geminiOneShotAttempts ?? 1;
      const fallbackModel = resolveGeminiOneShotFallbackModel(primaryModel);
      if (fallbackModel) {
        try {
          logger.warn({ err, category, primaryModel, fallbackModel, status, code, attempts }, 'Gemini one-shot failed, trying Gemini fallback model');
          // NOTE: no retry here — this stage IS the second chance.
          const text = await completeOneShot(
            systemPrompt,
            userPrompt,
            `${category}_gemini_model_fallback`,
            { ...options, model: fallbackModel },
          );
          return { text, provider: 'gemini' };
        } catch (fallbackErr) {
          rethrowUsagePersistenceFailure(fallbackErr);
          rethrowProviderSafetyBlock(fallbackErr);
          const fallbackInfo = extractGeminiErrorInfo(fallbackErr);
          logger.warn({ err: fallbackErr, category, primaryModel, fallbackModel, status: fallbackInfo.status, code: fallbackInfo.code, attempts }, 'Gemini fallback model also failed, trying OpenAI fallback');
        }
      } else {
        logger.warn({ err, category, primaryModel, status, code, attempts }, 'Gemini one-shot failed, trying OpenAI fallback');
      }
    }
  }

  // Stage 2: OpenAI (new fallback — April 9 2026).
  // See `completeVisionOneShotWithFallback` above for the full rationale.
  // Dynamic require to avoid circular import between provider modules.
  try {
    const openai = require('./openai-provider') as typeof import('./openai-provider');
    if (openai.isOpenAIConfigured()) {
      const text = await openai.completeOneShot(
        systemPrompt,
        userPrompt,
        `${category}_openai_fallback`,
        options,
      );
      return { text, provider: 'openai' };
    }
  } catch (err) {
    rethrowUsagePersistenceFailure(err);
    logger.warn({ err, category }, 'OpenAI fallback also failed, trying Anthropic (if enabled)');
  }

  // Stage 3: Anthropic thunk — only if explicitly re-enabled
  if (canUseAnthropicRuntimeFallback()) {
    const text = await anthropicFallback();
    return { text, provider: 'anthropic' };
  }

  throw new Error(
    `[completeOneShotWithFallback] All providers failed for category='${category}'. ` +
    `Gemini: ${isGeminiProviderConfigured() ? 'failed' : 'not configured'}. ` +
    `OpenAI: ${config.openai.apiKey ? 'failed' : 'not configured'}. ` +
    `Anthropic: disabled (set ANTHROPIC_ENABLED=true to re-enable).`,
  );
}

// ─── Tool format conversion ─────────────────────────────────────────

function toSchemaType(type: string): SchemaType {
  const map: Record<string, SchemaType> = {
    string: SchemaType.STRING,
    number: SchemaType.NUMBER,
    integer: SchemaType.INTEGER,
    boolean: SchemaType.BOOLEAN,
    array: SchemaType.ARRAY,
    object: SchemaType.OBJECT,
  };
  return map[type] || SchemaType.STRING;
}

function resolveFilteredTools(value: unknown, context: string, allowLegacyFullTools: boolean): Anthropic.Tool[] {
  if (Array.isArray(value)) return value as Anthropic.Tool[];
  if (allowLegacyFullTools) return TOOLS;
  if (!Array.isArray(value)) {
    throw new Error(`${context} requires explicit filteredTools; pass [] for no tools or TOOLS for the full set`);
  }
  return value as Anthropic.Tool[];
}

function convertProperties(properties: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const converted: any = { type: toSchemaType(prop.type || 'string') };
    if (prop.description) converted.description = prop.description;
    if (prop.enum) converted.enum = prop.enum;
    if (prop.items) {
      converted.items = { type: toSchemaType(prop.items.type || 'string') };
    }
    result[key] = converted;
  }
  return result;
}

/**
 * Convert Anthropic-format tools to Gemini FunctionDeclarations.
 * Accepts an explicit tool array so the caller can pass a pre-filtered
 * subset (TASK-17 Layer 3) instead of always sending all 25+ tools.
 */
function toGeminiFunctionDeclarations(tools: Anthropic.Tool[]): FunctionDeclaration[] {
  return tools.map((t) => {
    const schema = t.input_schema as any;
    return {
      name: t.name,
      description: t.description || '',
      parameters: {
        type: SchemaType.OBJECT,
        properties: convertProperties(schema.properties || {}),
        required: schema.required || [],
      },
    };
  });
}

/**
 * Map an abstract model tier to a concrete Gemini model name.
 * Mirrors anthropic.ts's getModelForDomain logic — but for Gemini's
 * model names. The TaskRoutingProvider passes us a tier string; we
 * resolve it to the actual SDK model identifier here.
 *
 * Tier mapping:
 *   - heavy → config.gemini.model            (gemini-2.5-flash)
 *   - light → config.gemini.classifierModel  (gemini-2.5-flash-lite)
 *
 * When tier is omitted, falls back to getModelRouting() which returns
 * the per-domain default. This keeps backwards compatibility for any
 * caller that hasn't been updated to pass options yet.
 */
function resolveGeminiModel(
  domain: DomainName,
  tier?: 'heavy' | 'light',
): { model: string; maxTokens: number } {
  const domainOverride = getDomainModelOverride('gemini', domain as DomainModelRole);
  if (domainOverride) {
    return {
      model: domainOverride,
      maxTokens: domain === 'secretary' ? config.gemini.secretaryMaxTokens : config.gemini.maxTokens,
    };
  }

  if (tier === 'light') {
    return {
      model: config.gemini.classifierModel,
      maxTokens: config.gemini.maxTokens,
    };
  }
  if (tier === 'heavy') {
    return {
      model: config.gemini.model,
      maxTokens: domain === 'secretary' ? config.gemini.secretaryMaxTokens : config.gemini.maxTokens,
    };
  }
  // No tier specified — fall back to the legacy per-domain defaults
  return getModelRouting(config.gemini, domain, 'gemini');
}

// ─── Response parsing helpers ───────────────────────────────────────

function extractText(result: GenerateContentResult): string {
  try {
    return result.response.text() || '';
  } catch {
    return '';
  }
}

function extractFunctionCalls(result: GenerateContentResult, nextId: () => string): AIToolCall[] {
  const calls = result.response.functionCalls();
  if (!calls || calls.length === 0) return [];

  return calls.map((fc) => ({
    type: 'tool_use' as const,
    id: nextId(),
    name: fc.name,
    input: (fc.args || {}) as Record<string, unknown>,
  }));
}

/** Injectable sleep — override `.fn` in tests to avoid real setTimeout waits. */
export const _sleep = { fn: (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)) };

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return { result: json };
  }
}

// ─── Provider Implementation ────────────────────────────────────────

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  private _toolCallCounter = 0;

  /** Generate a deterministic, sequential tool call ID. */
  private nextToolCallId = (): string => `gemini_tc_${++this._toolCallCounter}`;

  // ─── Retry with exponential backoff ───────────────────────────────

  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    onTimeout?: () => void,
  ): Promise<T> {
    const AI_CALL_TIMEOUT_MS = getAICallTimeoutMs();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await withTimeout(fn(), AI_CALL_TIMEOUT_MS, { onTimeout });
      } catch (err: unknown) {
        // Budget and durable-metering denials are terminal policy errors, not
        // provider availability failures. Preserve their identity so callers
        // emit the stable 403/429 contract and the breaker/fallback layers do
        // not count or spend past them.
        rethrowUsagePersistenceFailure(err);
        // Classification shared with the one-shot primary retry path —
        // see extractGeminiErrorInfo / isRetryableGeminiError above.
        const info = extractGeminiErrorInfo(err);
        const isRetryable = isRetryableGeminiError(info);

        if (!isRetryable || attempt === maxRetries) {
          const mapped = new Error(`Gemini API error: ${info.message}`);
          (mapped as any).provider = 'gemini';
          (mapped as any).status = info.status;
          (mapped as any).retryable = isRetryable;
          throw mapped;
        }

        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn({
          attempt,
          status: info.status,
          code: safeProviderFailureCode(info.code),
          backoffMs,
        }, 'Gemini retrying after error');
        await _sleep.fn(backoffMs);
      }
    }
    throw new Error('withRetry: unreachable');
  }

  private buildModel(
    modelName: string,
    systemPrompt: string,
    maxOutputTokens: number,
    useTools: boolean,
    filteredTools: Anthropic.Tool[],
    structuredJson = false,
    structuredJsonSchema?: unknown,
  ) {
    return getClient().getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig: withGeminiSafetySettings({
        maxOutputTokens,
        ...(structuredJson ? { responseMimeType: 'application/json' } : {}),
        ...(structuredJsonSchema !== undefined ? { responseJsonSchema: structuredJsonSchema } : {}),
      }),
      ...(useTools && filteredTools.length > 0 ? {
        tools: [{ functionDeclarations: toGeminiFunctionDeclarations(filteredTools) }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
      } : {}),
    });
  }

  private async generateWithRouting(
    request: { contents: Content[] },
    systemPrompt: string,
    filteredTools: Anthropic.Tool[],
    useTools: boolean,
    routing: { model: string; maxTokens: number },
    usageCategory: string,
    maxTokensOverride?: number,
    usageContext?: { userId?: number; tenantId?: number },
    maxRetries = 3,
    structuredJson = false,
    structuredJsonSchema?: unknown,
  ): Promise<GenerateContentResult> {
    const maxOutputTokens = maxTokensOverride || routing.maxTokens;
    const model = this.buildModel(
      routing.model,
      systemPrompt,
      maxOutputTokens,
      useTools,
      filteredTools,
      structuredJson,
      structuredJsonSchema,
    );

    const maxCostUsd = computeProviderCallCostUpperBoundUsd({
      provider: 'gemini',
      model: routing.model,
      payload: { request, systemPrompt, filteredTools: useTools ? filteredTools : [] },
      maxOutputTokens,
    });
    const start = Date.now();
    const result = await this.withRetry(() => {
      // Revalidate live lock ownership for every concrete SDK attempt, not
      // only once before the provider's retry loop begins.
      assertAiBudgetReservationForProvider({
        userId: usageContext?.userId ?? 0,
        category: usageCategory,
        provider: 'gemini',
        model: routing.model,
        maxCostUsd,
      });
      return model.generateContent(request);
    }, maxRetries, () => recordGeminiTimeoutEstimate({
      category: usageCategory,
      model: routing.model,
      userId: usageContext?.userId ?? 0,
      tenantId: usageContext?.tenantId ?? usageContext?.userId ?? 0,
      maxCostUsd,
      timeoutMs: getAICallTimeoutMs(),
    }));
    const durationMs = Date.now() - start;

    await logRequiredGeminiUsage(
      routing.model,
      usageCategory,
      result.response.usageMetadata,
      durationMs,
      usageContext?.userId ?? 0,
      usageContext?.tenantId ?? usageContext?.userId ?? 0,
    );

    return result;
  }

  // ─── classify ─────────────────────────────────────────────────────

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    // O3-A11/F-new-6: ClassifyOptions must carry user attribution for
    // routed classify calls. Without this, Gemini-primary classify rows
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

      const classifierMaxOutputTokens = 256;
      const classifierSystemPrompt = getClassifierSystemPrompt();
      const model = getClient().getGenerativeModel({
        model: config.gemini.classifierModel,
        systemInstruction: classifierSystemPrompt,
        generationConfig: withGeminiSafetySettings({ maxOutputTokens: classifierMaxOutputTokens }),
      });

      const maxCostUsd = computeProviderCallCostUpperBoundUsd({
        provider: 'gemini',
        model: config.gemini.classifierModel,
        payload: { classifierSystemPrompt, userContent },
        maxOutputTokens: classifierMaxOutputTokens,
      });
      const start = Date.now();
      const result = await this.withRetry(() => {
        assertAiBudgetReservationForProvider({
          userId: usageUserId,
          category: 'gemini_classify',
          provider: 'gemini',
          model: config.gemini.classifierModel,
          maxCostUsd,
        });
        return model.generateContent(userContent);
      }, 3, () => recordGeminiTimeoutEstimate({
        category: 'gemini_classify',
        model: config.gemini.classifierModel,
        userId: usageUserId,
        tenantId: usageTenantId,
        maxCostUsd,
        timeoutMs: getAICallTimeoutMs(),
      }));
      const durationMs = Date.now() - start;

      await logRequiredGeminiUsage(
        config.gemini.classifierModel,
        'gemini_classify',
        result.response.usageMetadata,
        durationMs,
        usageUserId,
        usageTenantId,
      );

      let text = extractText(result);
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(text);
      const domain = parsed.domain as DomainName;
      const confidence = parsed.confidence as number;
      // M15: tolerate BOTH output shapes — {domain, confidence} (legacy
      // prompt) and {domain, skill, confidence} (manifest prompt, flag
      // AI_CLASSIFY_MANIFEST_PROMPT). Raw passthrough; classifyWithClaude
      // validates the skill against the manifest.
      const skill = typeof parsed.skill === 'string' && parsed.skill.trim().length > 0
        ? parsed.skill.trim()
        : undefined;

      // Low-confidence secretary fallback deliberately drops the proposed
      // skill: it belonged to the rejected domain.
      if (confidence < 0.6) return { domain: 'secretary', confidence };
      return skill !== undefined ? { domain, confidence, skill } : { domain, confidence };
    } catch (err: unknown) {
      rethrowUsagePersistenceFailure(err);
      const e = err as { provider?: string; status?: number; retryable?: boolean };
      logger.error({
        err,
        provider: e?.provider,
        status: e?.status,
        retryable: e?.retryable,
      }, 'Gemini classification failed, defaulting to secretary');
      return { domain: 'secretary', confidence: 0 };
    }
  }

  // ─── callDomain ───────────────────────────────────────────────────

  async callStructuredGeneration(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    if (!/^gemini(?:[-.:]|$)/i.test(request.model)) {
      throw new Error('Gemini structured generation requires a Gemini model');
    }
    const result = await this.generateWithRouting(
      {
        contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      },
      request.systemPrompt,
      [],
      false,
      { model: request.model, maxTokens: request.maxTokens },
      request.category,
      request.maxTokens,
      { userId: request.userId, tenantId: request.tenantId },
      3,
      request.responseFormat === 'json',
      request.jsonSchema,
    );
    return {
      text: extractText(result),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    // TASK-17 Layer 3+4+5: normalize the options bag, then apply each
    // optimization. The decisions were made by TaskRoutingProvider via
    // planSecretaryOptimization() so they're consistent with what the
    // Anthropic provider would have done for the same message.
    const opts = normalizeCallDomainOptions(optionsOrMaxTokens);
    const currentTurnOnly = opts.currentTurnOnly === true;

    // Layer 4: tier-aware model selection
    // v2: honor options.modelOverride (set by cloud-reasoning-gate so the
    // approved reasoning model is actually used). When undefined, fall
    // through to the existing tier-aware routing.
    const baseRouting = resolveGeminiModel(domain, opts.modelTier);
    const routing = opts.modelOverride
      ? { model: opts.modelOverride, maxTokens: baseRouting.maxTokens }
      : baseRouting;

    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage, {
      currentTurnOnly,
    });
    const useTools = !currentTurnOnly && (domain === 'secretary' || domain === 'triathlon');
    const contextPrefix = currentTurnOnly ? '' : buildScopedStateContextPrefix(stateContext);

    const allowLegacyFullTools = optionsOrMaxTokens == null || typeof optionsOrMaxTokens === 'number';
    const filteredTools = currentTurnOnly
      ? []
      : resolveFilteredTools(opts.filteredTools, 'Gemini callDomain', allowLegacyFullTools);
    const historyToSend = currentTurnOnly ? [] : history;

    // Layer 5: history is sliced upstream by planSecretaryOptimization
    // when modelTier === 'light'. We just consume whatever the caller
    // passes — no double-slicing here.
    const contents: Content[] = [
      ...historyToSend.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }] as Part[],
      })),
      {
        role: 'user',
        parts: [{ text: `${contextPrefix}${currentMessage}` }],
      },
    ];

    const result = await this.generateWithRouting(
      { contents },
      systemPrompt,
      filteredTools,
      useTools,
      routing,
      `gemini_domain_${domain}`,
      opts.maxTokensOverride,
      { userId: opts.userId, tenantId: opts.tenantId },
    );

    const safetyBlock = detectGeminiSafetyBlock(result);
    if (safetyBlock) return buildGeminiSafetyBlockedCallResult(safetyBlock, domain, opts.userId);

    return {
      text: extractText(result),
      toolCalls: extractFunctionCalls(result, this.nextToolCallId),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }

  // ─── continueWithToolResults ──────────────────────────────────────

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
    options?: CallDomainOptions,
  ): Promise<AICallResult> {
    // CRITICAL: must apply the same options as the initial callDomain.
    // The Gemini chat session keeps function declarations stable across
    // turns, and Gemini will reject a tool_response that references a
    // function it doesn't see in the current declarations. Using the
    // same filtered tool list + same model tier across the whole loop
    // is what makes multi-step tool conversations work.
    const opts = normalizeCallDomainOptions(options);
    const currentTurnOnly = opts.currentTurnOnly === true;

    // v2: honor options.modelOverride (set by cloud-reasoning-gate so the
    // approved reasoning model is actually used). When undefined, fall
    // through to the existing tier-aware routing.
    const baseRouting = resolveGeminiModel(domain, opts.modelTier);
    const routing = opts.modelOverride
      ? { model: opts.modelOverride, maxTokens: baseRouting.maxTokens }
      : baseRouting;
    // Phase 2 Slice A: same persona routing as callDomain — continuation
    // uses the same currentMessage so the classifier resolves to the
    // same coach file. Mid-turn persona swaps would break tool chains.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage, {
      currentTurnOnly,
    });
    const useTools = !currentTurnOnly && (domain === 'secretary' || domain === 'triathlon');
    const contextPrefix = currentTurnOnly ? '' : buildScopedStateContextPrefix(stateContext);

    const filteredTools = currentTurnOnly
      ? []
      : resolveFilteredTools(opts.filteredTools, 'Gemini continueWithToolResults', options == null);
    const historyToSend = currentTurnOnly ? [] : history;

    const contents: Content[] = [
      ...historyToSend.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }] as Part[],
      })),
      {
        role: 'user',
        parts: [{ text: `${contextPrefix}${currentMessage}` }],
      },
    ];

    // Build a map of tool_use_id → function_name from assistant messages
    const toolNameMap = new Map<string, string>();
    for (const msg of toolConversation) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolNameMap.set(block.id, block.name);
          }
        }
      }
    }

    // Append tool conversation in Gemini format
    for (const msg of toolConversation) {
      try {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const parts: Part[] = [];
          for (const block of msg.content as any[]) {
            if (block.type === 'text' && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({
                functionCall: { name: block.name, args: block.input || {} },
              } as Part);
            }
          }
          if (parts.length > 0) {
            contents.push({ role: 'model', parts });
          }
        } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
          // Plain text assistant message
          contents.push({ role: 'model', parts: [{ text: msg.content }] });
        } else if (msg.role === 'user' && Array.isArray(msg.content)) {
          const parts: Part[] = [];
          for (const result of msg.content as any[]) {
            if (result.type === 'tool_result') {
              const functionName = toolNameMap.get(result.tool_use_id) || result.tool_use_id || 'unknown';
              parts.push({
                functionResponse: {
                  name: functionName,
                  response: safeParse(result.content),
                },
              } as Part);
            }
          }
          if (parts.length > 0) {
            contents.push({ role: 'user', parts });
          }
        }
      } catch (err) {
        logger.warn({ err, msgRole: msg.role }, 'Skipping malformed Gemini tool conversation message');
      }
    }

    const result = await this.generateWithRouting(
      { contents },
      systemPrompt,
      filteredTools,
      useTools,
      routing,
      'gemini_tool_continuation',
      opts.maxTokensOverride,
      { userId: opts.userId, tenantId: opts.tenantId },
    );

    const safetyBlock = detectGeminiSafetyBlock(result);
    if (safetyBlock) return buildGeminiSafetyBlockedCallResult(safetyBlock, domain, opts.userId);

    return {
      text: extractText(result),
      toolCalls: extractFunctionCalls(result, this.nextToolCallId),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }
}
