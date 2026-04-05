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
} from '@google/generative-ai';
import { AIProvider, AICallResult, AIToolCall, AIToolResultMessage, getModelRouting } from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDomainSystemPrompt, getClassifierSystemPrompt, TOOLS } from './anthropic';
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
import { withTimeout } from '../utils/timeout';

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
  'gemini-3-flash':         { in: 0.50, out: 3.00 },
  'gemini-2.5-flash':       { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite':  { in: 0.10, out: 0.40 },
  'gemini-2.0-flash':       { in: 0.10, out: 0.40 },  // legacy, deprecated June 2026
  'gemini-1.5-pro':         { in: 1.25, out: 5.00 },  // legacy
};

function computeGeminiCost(model: string, usage: { promptTokenCount: number; candidatesTokenCount: number }): number {
  const key = Object.keys(GEMINI_COST_PER_MTK).find(k => model.startsWith(k)) ?? 'gemini-3-flash';
  const rates = GEMINI_COST_PER_MTK[key];
  return (usage.promptTokenCount / 1_000_000) * rates.in +
         (usage.candidatesTokenCount / 1_000_000) * rates.out;
}

function logGeminiUsage(
  model: string,
  category: string,
  usage: { promptTokenCount: number; candidatesTokenCount: number },
  durationMs: number,
): void {
  try {
    const cost = computeGeminiCost(model, usage);
    const db = getDb();
    db.prepare(`
      INSERT INTO api_usage (category, model, input_tokens, output_tokens, cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(category, model, usage.promptTokenCount, usage.candidatesTokenCount, cost, durationMs);

    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Gemini ${model}: ${usage.promptTokenCount}+${usage.candidatesTokenCount} tokens ($${cost.toFixed(4)})`,
      durationMs,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log Gemini usage');
  }
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

function toGeminiFunctionDeclarations(): FunctionDeclaration[] {
  return TOOLS.map((t) => {
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
    const AI_CALL_TIMEOUT_MS = parseInt(process.env.AI_CALL_TIMEOUT_MS || '30000', 10);

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
    maxTokensOverride?: number,
  ): Promise<AICallResult> {
    const routing = getModelRouting(config.gemini, domain, 'gemini');
    const systemPrompt = getDomainSystemPrompt(domain);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

    const model = getClient().getGenerativeModel({
      model: routing.model,
      systemInstruction: systemPrompt,
      generationConfig: {
        maxOutputTokens: maxTokensOverride || routing.maxTokens,
      },
      ...(useTools ? {
        tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
      } : {}),
    });

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

    const start = Date.now();
    const result = await this.withRetry(() => model.generateContent({ contents }));
    const durationMs = Date.now() - start;

    const usage = result.response.usageMetadata;
    if (usage) {
      logGeminiUsage(routing.model, `gemini_domain_${domain}`, {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      }, durationMs);
    }

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
  ): Promise<AICallResult> {
    const routing = getModelRouting(config.gemini, domain, 'gemini');
    const systemPrompt = getDomainSystemPrompt(domain);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

    const model = getClient().getGenerativeModel({
      model: routing.model,
      systemInstruction: systemPrompt,
      generationConfig: {
        maxOutputTokens: routing.maxTokens,
      },
      ...(useTools ? {
        tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
      } : {}),
    });

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

    const start = Date.now();
    const result = await this.withRetry(() => model.generateContent({ contents }));
    const durationMs = Date.now() - start;

    const usage = result.response.usageMetadata;
    if (usage) {
      logGeminiUsage(routing.model, 'gemini_tool_continuation', {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      }, durationMs);
    }

    return {
      text: extractText(result),
      toolCalls: extractFunctionCalls(result, this.nextToolCallId),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }
}
