/**
 * Gemini Provider — AIProvider implementation backed by Google Gemini models.
 *
 * Translates between the provider-agnostic AIProvider interface and the
 * Google Generative AI SDK. Uses the same tool definitions and system
 * prompts as the Anthropic provider for consistency.
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

// ─── Tool format conversion ─────────────────────────────────────────

/**
 * Convert JSON Schema type strings to Gemini's SchemaType enum.
 * Gemini requires SchemaType enum values rather than raw strings.
 */
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

/**
 * Convert JSON Schema properties to Gemini-compatible format.
 * Gemini requires SchemaType enum values and doesn't support 'const' or 'enum' on all types.
 */
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
 * Convert Anthropic-format tool definitions to Gemini function declarations.
 * Anthropic: { name, description, input_schema: { type: 'object', properties, required } }
 * Gemini:    { name, description, parameters: { type: SchemaType.OBJECT, properties, required } }
 */
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
    // text() throws if there are no text parts
    return '';
  }
}

function extractFunctionCalls(result: GenerateContentResult): AIToolCall[] {
  const calls = result.response.functionCalls();
  if (!calls || calls.length === 0) return [];

  return calls.map((fc, i) => ({
    type: 'tool_use' as const,
    id: `gemini_tc_${Date.now()}_${i}`,  // Gemini doesn't have tool call IDs
    name: fc.name,
    input: (fc.args || {}) as Record<string, unknown>,
  }));
}

// ─── Provider Implementation ────────────────────────────────────────

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

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

      const result = await model.generateContent(userContent);

      let text = extractText(result);
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(text);
      const domain = parsed.domain as DomainName;
      const confidence = parsed.confidence as number;

      if (confidence < 0.6) return { domain: 'secretary', confidence };
      return { domain, confidence };
    } catch (err) {
      logger.error({ err }, 'Gemini classification failed, defaulting to secretary');
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
    const routing = getModelRouting(config.gemini, domain);
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

    // Build Gemini conversation history
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

    const result = await model.generateContent({ contents });

    return {
      text: extractText(result),
      toolCalls: extractFunctionCalls(result),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
  ): Promise<AICallResult> {
    const routing = getModelRouting(config.gemini, domain);
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

    // Build base contents
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

    // Append tool conversation in Gemini format
    // Gemini uses: model (with functionCall parts) → user (with functionResponse parts)
    for (const msg of toolConversation) {
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
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        const parts: Part[] = [];
        for (const result of msg.content as any[]) {
          if (result.type === 'tool_result') {
            parts.push({
              functionResponse: {
                name: result.tool_use_id || 'unknown',
                response: safeParse(result.content),
              },
            } as Part);
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts });
        }
      }
    }

    const result = await model.generateContent({ contents });

    return {
      text: extractText(result),
      toolCalls: extractFunctionCalls(result),
      stopReason: result.response.candidates?.[0]?.finishReason || 'STOP',
    };
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return { result: json };
  }
}
