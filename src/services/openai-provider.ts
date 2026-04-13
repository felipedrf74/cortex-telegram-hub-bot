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
 * - Optional streaming via streamDomain() async generator
 */

import OpenAI from 'openai';
import { AIProvider, AICallResult, AIToolCall, AIToolResultMessage, getModelRouting } from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDomainSystemPrompt, getClassifierSystemPrompt, TOOLS } from './anthropic';
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
import { withTimeout } from '../utils/timeout';

// ─── Client (lazy init — only created if API key is set) ────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    _client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return _client;
}

/** Check if OpenAI is configured (has API key) */
export function isOpenAIConfigured(): boolean {
  return !!config.openai.apiKey;
}

// ─── Cost per million tokens (update when OpenAI changes rates) ─────

const OPENAI_COST_PER_MTK: Record<string, { in: number; out: number }> = {
  'gpt-5.4-nano': { in: 0.20, out: 1.25 },
  'gpt-5.4-mini': { in: 0.40, out: 1.60 },
  'gpt-5-nano':   { in: 0.20, out: 1.25 },
  'gpt-5-mini':   { in: 0.40, out: 1.60 },
  'gpt-4o':       { in: 2.50, out: 10.00 },
  'gpt-4o-mini':  { in: 0.15, out: 0.60 },
};

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
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
  category: string,
  userId: number = 0,
): Promise<OpenAI.ChatCompletion> {
  const AI_CALL_TIMEOUT_MS = parseInt(process.env.AI_CALL_TIMEOUT_MS || '30000', 10);

  const start = Date.now();
  const response = await withTimeout(client.chat.completions.create(params), AI_CALL_TIMEOUT_MS);
  const durationMs = Date.now() - start;

  const usage = response.usage;
  if (usage) {
    const model = response.model || params.model;
    // Prefix match (longest key first): OpenAI returns versioned models (e.g. 'gpt-4o-2024-08-06')
    const rateKey = Object.keys(OPENAI_COST_PER_MTK).sort((a, b) => b.length - a.length).find(k => model.startsWith(k));
    const rates = rateKey ? OPENAI_COST_PER_MTK[rateKey] : OPENAI_COST_PER_MTK['gpt-4o'];
    const costUsd =
      (usage.prompt_tokens / 1_000_000) * rates.in +
      (usage.completion_tokens / 1_000_000) * rates.out;

    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO api_usage (category, model, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'openai')
      `).run(category, model, userId, usage.prompt_tokens, usage.completion_tokens, costUsd, durationMs);
    } catch (e) {
      logger.warn({ err: e }, 'Failed to log OpenAI usage to database');
    }

    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `OpenAI ${model} [${category}] — ${usage.prompt_tokens}+${usage.completion_tokens} tokens`,
      detail: `$${costUsd.toFixed(4)} in ${durationMs}ms`,
    });
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
  options?: { model?: string; maxTokens?: number; temperature?: number; userId?: number },
): Promise<string> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');
  }
  const model = options?.model ?? 'gpt-4o-mini';
  const maxTokens = options?.maxTokens ?? 2500;
  const temperature = options?.temperature ?? 0.7;

  const response = await withRetry(() =>
    trackedCompletion(
      getClient(),
      {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      category,
      options?.userId ?? 0,
    ),
  );

  return response.choices[0]?.message?.content ?? '';
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
  options?: { model?: string; maxTokens?: number; temperature?: number; userId?: number },
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
      {
        model,
        max_tokens: maxTokens,
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
      },
      category,
      options?.userId ?? 0,
    ),
  );

  return response.choices[0]?.message?.content ?? '';
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

// ─── Tool format conversion ─────────────────────────────────────────

/**
 * Convert Anthropic-format tool definitions to OpenAI function-calling format.
 */
function toOpenAITools(): OpenAI.ChatCompletionTool[] {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
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

      const response = await withRetry(() =>
        trackedCompletion(getClient(), {
          model: config.openai.classifierModel,
          max_tokens: 100,
          messages: [
            { role: 'system', content: getClassifierSystemPrompt() },
            { role: 'user', content: userContent },
          ],
        }, 'openai_classify')
      );

      let text = response.choices[0]?.message?.content || '';
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(text);
      const domain = parsed.domain as DomainName;
      const confidence = parsed.confidence as number;

      if (confidence < 0.6) return { domain: 'secretary', confidence };
      return { domain, confidence };
    } catch (err) {
      logger.error({ err }, 'OpenAI classification failed, defaulting to secretary');
      return { domain: 'secretary', confidence: 0 };
    }
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    maxTokensOverride?: number,
  ): Promise<AICallResult> {
    const routing = getModelRouting(config.openai, domain, 'openai');
    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ];

    const response = await withRetry(() =>
      trackedCompletion(getClient(), {
        model: routing.model,
        max_tokens: maxTokensOverride || routing.maxTokens,
        messages,
        ...(useTools ? { tools: toOpenAITools() } : {}),
      }, `openai_domain_${domain}`)
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
  ): Promise<AICallResult> {
    const routing = getModelRouting(config.openai, domain, 'openai');
    // Phase 2 Slice A: pass currentMessage so triathlon sub-skill
    // routing picks the sport-specific coach persona prompt.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

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
      trackedCompletion(getClient(), {
        model: routing.model,
        max_tokens: routing.maxTokens,
        messages,
        ...(useTools ? { tools: toOpenAITools() } : {}),
      }, 'openai_tool_continuation')
    );

    const choice = response.choices[0];
    return {
      text: choice?.message?.content || '',
      toolCalls: extractToolCalls(response.choices),
      stopReason: choice?.finish_reason || 'stop',
    };
  }

  /**
   * Stream a domain response. Returns an async generator of text chunks.
   * Token usage is tracked after the stream completes.
   *
   * Note: This is a WhatsApp-specific extension, NOT part of the AIProvider interface.
   */
  async *streamDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
  ): AsyncGenerator<string, AICallResult, undefined> {
    const routing = getModelRouting(config.openai, domain, 'openai');
    // Phase 2 Slice A: same persona routing for the streaming path.
    const systemPrompt = getDomainSystemPrompt(domain, currentMessage);
    const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ];

    const start = Date.now();
    const stream = await withRetry(() =>
      getClient().chat.completions.create({
        model: routing.model,
        max_tokens: routing.maxTokens,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      })
    );

    let fullText = '';
    let finishReason = 'stop';
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        yield delta;
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
        };
      }
    }

    const durationMs = Date.now() - start;

    if (usage) {
      const model = routing.model;
      // Prefix match (longest key first): OpenAI returns versioned models (e.g. 'gpt-4o-2024-08-06')
    const rateKey = Object.keys(OPENAI_COST_PER_MTK).sort((a, b) => b.length - a.length).find(k => model.startsWith(k));
    const rates = rateKey ? OPENAI_COST_PER_MTK[rateKey] : OPENAI_COST_PER_MTK['gpt-4o'];
      const costUsd =
        (usage.prompt_tokens / 1_000_000) * rates.in +
        (usage.completion_tokens / 1_000_000) * rates.out;

      try {
        const db = getDb();
        // April 9 2026: persist user_id (same fix as the non-streaming
        // trackedCompletion above). Streaming callers don't currently
        // pass userId through — the AIProvider interface's streamDomain
        // method predates per-user cost attribution. Fallback to 0
        // until the interface is extended.
        db.prepare(`
          INSERT INTO api_usage (category, model, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, provider)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'openai')
        `).run(`openai_stream_${domain}`, model, 0, usage.prompt_tokens, usage.completion_tokens, costUsd, durationMs);
      } catch (e) {
        logger.warn({ err: e }, 'Failed to log OpenAI streaming usage');
      }

      pushEvent({
        ts: new Date().toISOString(),
        type: 'api_call',
        summary: `OpenAI stream ${model} [${domain}] — ${usage.prompt_tokens}+${usage.completion_tokens} tokens`,
        detail: `$${costUsd.toFixed(4)} in ${durationMs}ms`,
      });
    }

    return {
      text: fullText,
      toolCalls: [],
      stopReason: finishReason,
    };
  }
}
