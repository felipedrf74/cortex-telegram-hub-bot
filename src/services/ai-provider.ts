/**
 * AI Provider Interface
 *
 * Abstracts AI model interactions behind a common interface so different
 * backends (Anthropic, OpenAI, local models) can be swapped or chained
 * as fallbacks without changing the domain/router layer.
 */

import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';

// ─── Core Types ─────────────────────────────────────────────────────

export interface AICallResult {
  text: string;
  toolCalls: AIToolCall[];
  stopReason: string;
}

export interface AIToolCall {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AIToolResultMessage {
  role: 'user' | 'assistant';
  content: string | AIToolResultContent[];
}

export interface AIToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

// ─── Model Routing (shared across all providers) ──────────────────

/**
 * Result of model routing: which model and token limit to use for a task.
 */
export interface ModelRouting {
  model: string;
  maxTokens: number;
}

/**
 * Provider-agnostic model configuration. Each provider (Anthropic, OpenAI,
 * Gemini, future) defines these four values in config.ts.
 *
 * To add a new provider, create a config block with these keys and call
 * getModelRouting(config.yourProvider, domain) in your adapter.
 */
export interface ProviderModelConfig {
  /** Expensive/capable model for complex tasks (secretary with multi-step tools) */
  model: string;
  /** Cheap/fast model for simple tasks (classification, triathlon, content) */
  classifierModel: string;
  /** Default max tokens for simple domains (content: ~1024) */
  maxTokens: number;
  /** Higher token limit for secretary (needs headroom for parallel tool calls) */
  secretaryMaxTokens: number;
}

/**
 * Determine which model and token limit to use for a given domain.
 *
 * Routing rules:
 * - secretary: expensive model + high token limit (multi-step tool use)
 * - triathlon: cheap model + medium token limit (tool calls + calendar ops)
 * - content:   cheap model + default token limit (conversational)
 */
export function getModelRouting(
  cfg: ProviderModelConfig,
  domain: DomainName,
): ModelRouting {
  switch (domain) {
    case 'secretary':
      return { model: cfg.model, maxTokens: cfg.secretaryMaxTokens };
    case 'triathlon':
      return { model: cfg.classifierModel, maxTokens: 2048 };
    case 'content':
    default:
      return { model: cfg.classifierModel, maxTokens: cfg.maxTokens };
  }
}

// ─── Provider Interface ─────────────────────────────────────────────

export interface AIProvider {
  /** Provider identifier (e.g., 'anthropic', 'openai') */
  readonly name: string;

  /**
   * Classify a message into a domain.
   * Returns the domain and a confidence score (0-1).
   */
  classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
  ): Promise<ClassificationResult>;

  /**
   * Send a message to a domain handler and get a response.
   * May include tool calls that the caller must execute.
   */
  callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    maxTokensOverride?: number,
  ): Promise<AICallResult>;

  /**
   * Continue a conversation after executing tool calls.
   * The toolConversation contains the assistant's tool_use + user's tool_result messages.
   */
  continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
  ): Promise<AICallResult>;
}

// ─── Fallback Provider ──────────────────────────────────────────────

/**
 * Wraps a primary and fallback provider. If the primary throws, the
 * fallback is used transparently. Useful for high-availability setups.
 */
export class FallbackProvider implements AIProvider {
  readonly name: string;

  constructor(
    private primary: AIProvider,
    private fallback: AIProvider,
    private onFallback?: (error: Error, method: string) => void,
  ) {
    this.name = `${primary.name}→${fallback.name}`;
  }

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
  ): Promise<ClassificationResult> {
    try {
      return await this.primary.classify(message, activeContext);
    } catch (err) {
      this.onFallback?.(err as Error, 'classify');
      return this.fallback.classify(message, activeContext);
    }
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    maxTokensOverride?: number,
  ): Promise<AICallResult> {
    try {
      return await this.primary.callDomain(domain, history, currentMessage, stateContext, maxTokensOverride);
    } catch (err) {
      this.onFallback?.(err as Error, 'callDomain');
      return this.fallback.callDomain(domain, history, currentMessage, stateContext, maxTokensOverride);
    }
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
  ): Promise<AICallResult> {
    try {
      return await this.primary.continueWithToolResults(domain, history, currentMessage, stateContext, toolConversation);
    } catch (err) {
      this.onFallback?.(err as Error, 'continueWithToolResults');
      return this.fallback.continueWithToolResults(domain, history, currentMessage, stateContext, toolConversation);
    }
  }
}
