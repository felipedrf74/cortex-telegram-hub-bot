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
