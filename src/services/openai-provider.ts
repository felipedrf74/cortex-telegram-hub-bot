/**
 * OpenAI Provider — AIProvider implementation backed by GPT models.
 *
 * Translates between the provider-agnostic AIProvider interface and the
 * OpenAI Chat Completions API. Uses the same tool definitions and system
 * prompts as the Anthropic provider for consistency.
 */

import OpenAI from 'openai';
import { AIProvider, AICallResult, AIToolCall, AIToolResultMessage, getModelRouting } from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDomainSystemPrompt, getClassifierSystemPrompt, TOOLS } from './anthropic';

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

// ─── Tool format conversion ─────────────────────────────────────────

/**
 * Convert Anthropic-format tool definitions to OpenAI function-calling format.
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type: 'function', function: { name, description, parameters } }
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

      const response = await getClient().chat.completions.create({
        model: config.openai.classifierModel,
        max_tokens: 100,
        messages: [
          { role: 'system', content: getClassifierSystemPrompt() },
          { role: 'user', content: userContent },
        ],
      });

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
    const routing = getModelRouting(config.openai, domain);
    const systemPrompt = getDomainSystemPrompt(domain);
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

    const response = await getClient().chat.completions.create({
      model: routing.model,
      max_tokens: maxTokensOverride || routing.maxTokens,
      messages,
      ...(useTools ? { tools: toOpenAITools() } : {}),
    });

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
    const routing = getModelRouting(config.openai, domain);
    const systemPrompt = getDomainSystemPrompt(domain);
    const useTools = domain === 'secretary' || domain === 'triathlon';
    const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

    // Build the base messages
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ];

    // Append tool conversation in OpenAI format
    // AIToolResultMessage pairs: [assistant with tool_calls, user with tool_results]
    for (const msg of toolConversation) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Assistant message with tool use blocks
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
        // Tool result messages
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

    const response = await getClient().chat.completions.create({
      model: routing.model,
      max_tokens: routing.maxTokens,
      messages,
      ...(useTools ? { tools: toOpenAITools() } : {}),
    });

    const choice = response.choices[0];
    return {
      text: choice?.message?.content || '',
      toolCalls: extractToolCalls(response.choices),
      stopReason: choice?.finish_reason || 'stop',
    };
  }
}
