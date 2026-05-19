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
 * - Retry on 429/503/500/RESOURCE_EXHAUSTED/UNAVAILABLE
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
import { getAICallTimeoutMs, isAnthropicRuntimeEnabled } from './runtime-flags';
import { buildScopedStateContextPrefix } from './provider-state-context';
import { getDomainModelOverride, type DomainModelRole } from './model-config';

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

// ─── Cost per million tokens ────────────────────────────────────────

const GEMINI_COST_PER_MTK: Record<string, { in: number; out: number }> = {
  'gemini-3.1-pro':         { in: 2.00, out: 12.00 },
  'gemini-3-flash':         { in: 0.50, out: 3.00 },  // historical rows only; not a selectable API model
  'gemini-2.5-flash':       { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite':  { in: 0.10, out: 0.40 },
  'gemini-2.0-flash':       { in: 0.10, out: 0.40 },  // legacy, deprecated June 2026
  'gemini-1.5-pro':         { in: 1.25, out: 5.00 },  // legacy
};

export function resolveGeminiCostModelKey(model: string): string {
  return Object.keys(GEMINI_COST_PER_MTK)
    .sort((a, b) => b.length - a.length)
    .find(k => model.startsWith(k))
    ?? 'gemini-2.5-flash';
}

export function computeGeminiCost(model: string, usage: { promptTokenCount: number; candidatesTokenCount: number }): number {
  const key = resolveGeminiCostModelKey(model);
  const rates = GEMINI_COST_PER_MTK[key];
  return (usage.promptTokenCount / 1_000_000) * rates.in +
         (usage.candidatesTokenCount / 1_000_000) * rates.out;
}

function logGeminiUsage(
  model: string,
  category: string,
  usage: { promptTokenCount: number; candidatesTokenCount: number },
  durationMs: number,
  userId: number = 0,
  tenantId: number = userId,
): void {
  try {
    const cost = computeGeminiCost(model, usage);
    const db = getDb();
    // April 9 2026: persist `user_id` into the INSERT. Previously
    // omitted, so every Gemini row silently had user_id=0 via the
    // `NOT NULL DEFAULT 0` from migration 029 — see the matching
    // fix in `src/portal/anthropic-hook.ts` for the full story.
    // Per-user cost enforcement (cost-guardrail.isUserOverDailyCap)
    // was effectively disabled until both INSERT statements were
    // updated.
    db.prepare(`
      INSERT INTO api_usage (category, model, tenant_id, user_id, input_tokens, output_tokens, cost_usd, duration_ms, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gemini')
    `).run(category, model, tenantId, userId, usage.promptTokenCount, usage.candidatesTokenCount, cost, durationMs);

    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Gemini ${model}: ${usage.promptTokenCount}+${usage.candidatesTokenCount} tokens ($${cost.toFixed(4)})`,
      durationMs,
    });
  } catch (err) {
    try {
      const cost = computeGeminiCost(model, usage);
      const db = getDb();
      db.prepare(`
        INSERT INTO api_usage (category, model, user_id, input_tokens, output_tokens, cost_usd, duration_ms, provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'gemini')
      `).run(category, model, userId, usage.promptTokenCount, usage.candidatesTokenCount, cost, durationMs);
    } catch (fallbackErr) {
      logger.warn({ err: fallbackErr }, 'Failed to log Gemini usage');
    }
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
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      ...(options?.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  });

  const start = Date.now();
  const result = await withTimeout(
    genModel.generateContent([{ text: userPrompt }]),
    options?.timeoutMs ?? config.aiSafety.callTimeoutMs,
  );
  const durationMs = Date.now() - start;

  const usage = result.response.usageMetadata;
  if (usage) {
    logGeminiUsage(
      model,
      category,
      {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      },
      durationMs,
      options?.userId ?? 0,
      options?.tenantId ?? options?.userId ?? 0,
    );
  }

  return extractText(result);
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
 * Cost note: grounded calls have a small surcharge (Google's published
 * list is ~$0.035/1K grounded queries). Still cheaper than Anthropic
 * web_search by a wide margin because the base Gemini tokens are so
 * much cheaper to begin with.
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

  // The Google Search tool is declared via the `tools` array with a single
  // item shaped `{ googleSearchRetrieval: {} }`. The SDK's type defs don't
  // include this in the public Tool union yet, so we cast. An empty config
  // object means "use default search retrieval behavior" — Google's
  // recommendation for most use cases.
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: safeSystemPrompt,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
    tools: [{ googleSearchRetrieval: {} }] as any,
  });

  const start = Date.now();
  const result = await withTimeout(
    genModel.generateContent([{ text: safeUserPrompt }]),
    config.aiSafety.callTimeoutMs,
  );
  const durationMs = Date.now() - start;

  const usage = result.response.usageMetadata;
  if (usage) {
    logGeminiUsage(
      model,
      category,
      {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      },
      durationMs,
      options?.userId ?? 0,
      options?.tenantId ?? options?.userId ?? 0,
    );
  }

  // Extract grounding sources (URLs) for transparency. When search was
  // actually used, Google attaches a `groundingMetadata` field with the
  // list of web chunks it pulled from. This lets the caller show citations
  // or log which URLs the model consulted.
  const sources: string[] = [];
  try {
    const candidates = (result.response as any).candidates;
    const metadata = candidates?.[0]?.groundingMetadata;
    const chunks = metadata?.groundingChunks || [];
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
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  });

  const start = Date.now();
  const result = await withTimeout(
    genModel.generateContent([
      // Image MUST come before the text prompt — Gemini's own docs recommend
      // this order because vision models attend to the image first and then
      // the instruction. Flipping the order degrades accuracy noticeably.
      { inlineData: { mimeType: image.mimeType, data: image.base64 } },
      { text: userPrompt },
    ]),
    config.aiSafety.callTimeoutMs,
  );
  const durationMs = Date.now() - start;

  const usage = result.response.usageMetadata;
  if (usage) {
    logGeminiUsage(
      model,
      category,
      {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      },
      durationMs,
      options?.userId ?? 0,
      options?.tenantId ?? options?.userId ?? 0,
    );
  }

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
  // Stage 1: Gemini (primary)
  if (isGeminiProviderConfigured()) {
    try {
      const text = await completeVisionOneShot(systemPrompt, userPrompt, image, category, options);
      return { text, provider: 'gemini' };
    } catch (err) {
      logger.warn({ err, category }, 'Gemini vision one-shot failed, trying OpenAI fallback');
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
    logger.warn({ err, category }, 'OpenAI vision fallback also failed, trying Anthropic (if enabled)');
  }

  // Stage 3: Anthropic thunk — only if the operator has explicitly
  // re-enabled Anthropic via the env var. Default is disabled, so this
  // branch normally never runs. If the thunk's internal trackedCreate
  // call fires, the kill switch in anthropic-hook.ts will throw before
  // the SDK actually hits Anthropic.
  if (isAnthropicRuntimeEnabled()) {
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
 * to a caller-supplied Anthropic path on Gemini failure (or when Gemini is
 * not configured). Returns the result text plus which provider produced it.
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
  // Stage 1: Gemini (primary)
  if (isGeminiProviderConfigured()) {
    try {
      const text = await completeOneShot(systemPrompt, userPrompt, category, options);
      return { text, provider: 'gemini' };
    } catch (err) {
      logger.warn({ err, category }, 'Gemini one-shot failed, trying OpenAI fallback');
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
    logger.warn({ err, category }, 'OpenAI fallback also failed, trying Anthropic (if enabled)');
  }

  // Stage 3: Anthropic thunk — only if explicitly re-enabled
  if (isAnthropicRuntimeEnabled()) {
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

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    const AI_CALL_TIMEOUT_MS = getAICallTimeoutMs();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await withTimeout(fn(), AI_CALL_TIMEOUT_MS);
      } catch (err: unknown) {
        const e = err as { status?: number; response?: { status?: number }; message?: string };
        const status = e?.status ?? e?.response?.status;
        const message = e?.message ?? '';

        const isRetryable =
          status === 429 ||
          status === 503 ||
          status === 500 ||
          message.includes('RESOURCE_EXHAUSTED') ||
          message.includes('UNAVAILABLE');

        if (!isRetryable || attempt === maxRetries) {
          const mapped = new Error(`Gemini API error: ${message}`);
          (mapped as any).provider = 'gemini';
          (mapped as any).status = status;
          (mapped as any).retryable = isRetryable;
          throw mapped;
        }

        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn({ attempt, status, backoffMs, message: message.slice(0, 100) }, 'Gemini retrying after error');
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
  ) {
    return getClient().getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig: {
        maxOutputTokens,
      },
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
  ): Promise<GenerateContentResult> {
    const model = this.buildModel(
      routing.model,
      systemPrompt,
      maxTokensOverride || routing.maxTokens,
      useTools,
      filteredTools,
    );

    const start = Date.now();
    const result = await this.withRetry(() => model.generateContent(request), maxRetries);
    const durationMs = Date.now() - start;

    const usage = result.response.usageMetadata;
    if (usage) {
      logGeminiUsage(routing.model, usageCategory, {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      }, durationMs, usageContext?.userId ?? 0, usageContext?.tenantId ?? usageContext?.userId ?? 0);
    }

    return result;
  }

  // ─── classify ─────────────────────────────────────────────────────

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
  ): Promise<ClassificationResult> {
    try {
      let userContent = message;
      if (activeContext) {
        userContent = `[ACTIVE CONVERSATION — domain: "${activeContext.domain}"]
Last assistant message: "${activeContext.lastAssistantMessage.substring(0, 300)}"

[NEW USER MESSAGE]
${message}`;
      }

      const model = getClient().getGenerativeModel({
        model: config.gemini.classifierModel,
        systemInstruction: getClassifierSystemPrompt(),
      });

      const start = Date.now();
      const result = await this.withRetry(() => model.generateContent(userContent));
      const durationMs = Date.now() - start;

      const usage = result.response.usageMetadata;
      if (usage) {
        logGeminiUsage(config.gemini.classifierModel, 'gemini_classify', {
          promptTokenCount: usage.promptTokenCount ?? 0,
          candidatesTokenCount: usage.candidatesTokenCount ?? 0,
        }, durationMs);
      }

      let text = extractText(result);
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(text);
      const domain = parsed.domain as DomainName;
      const confidence = parsed.confidence as number;

      if (confidence < 0.6) return { domain: 'secretary', confidence };
      return { domain, confidence };
    } catch (err: unknown) {
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

    // Layer 4: tier-aware model selection
    const routing = resolveGeminiModel(domain, opts.modelTier);

    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = buildScopedStateContextPrefix(stateContext);

    const allowLegacyFullTools = optionsOrMaxTokens == null || typeof optionsOrMaxTokens === 'number';
    const filteredTools = resolveFilteredTools(opts.filteredTools, 'Gemini callDomain', allowLegacyFullTools);

    // Layer 5: history is sliced upstream by planSecretaryOptimization
    // when modelTier === 'light'. We just consume whatever the caller
    // passes — no double-slicing here.
    const contents: Content[] = [
      ...history.map((m) => ({
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

    const routing = resolveGeminiModel(domain, opts.modelTier);
    // Phase 2 Slice A: same persona routing as callDomain — continuation
    // uses the same currentMessage so the classifier resolves to the
    // same coach file. Mid-turn persona swaps would break tool chains.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = buildScopedStateContextPrefix(stateContext);

    const filteredTools = resolveFilteredTools(opts.filteredTools, 'Gemini continueWithToolResults', options == null);

    const contents: Content[] = [
      ...history.map((m) => ({
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

    return {
      text: extractText(result),
      toolCalls: extractFunctionCalls(result, this.nextToolCallId),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }
}
