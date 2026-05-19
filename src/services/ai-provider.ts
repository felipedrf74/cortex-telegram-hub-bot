// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * AI Provider Interface
 *
 * Abstracts AI model interactions behind a common interface so different
 * backends (Anthropic, OpenAI, local models) can be swapped or chained
 * as fallbacks without changing the domain/router layer.
 */

import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import type { DomainModelRole } from './model-config';

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
  providerName?: string,
): ModelRouting {
  // Check for a domain-specific model override first
  if (providerName) {
    try {
      const { getDomainModelOverride } = require('./model-config');
      const domainOverride = getDomainModelOverride(providerName, domain as DomainModelRole);
      if (domainOverride) {
        // Use the overridden model with the domain's standard token limit
        const maxTokens = domain === 'secretary' ? cfg.secretaryMaxTokens
          : domain === 'triathlon' ? 2048
          : cfg.maxTokens;
        return { model: domainOverride, maxTokens };
      }
    } catch { /* model-config not loaded yet — use tier defaults */ }
  }

  // Fall through to existing tier-based routing
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

/**
 * Options bag for callDomain / continueWithToolResults.
 *
 * All fields are optional. When omitted, the provider falls back to its
 * own defaults — same as before TASK-17 Layer 3+4+5 existed. This keeps
 * the interface backwards-compatible: callers that don't know about the
 * optimization knobs (legacy code, tests, ad-hoc tools) keep working.
 *
 * When the routing layer (TaskRoutingProvider) computes a
 * SecretaryOptimization decision via `planSecretaryOptimization()`, it
 * passes the result here so EVERY provider applies the same optimization
 * regardless of which one ends up running. This is what makes Layers
 * 3/4/5 provider-agnostic — the decision is made once at dispatch time,
 * not duplicated inside each provider.
 *
 * Field semantics:
 *   - filteredTools: Layer 3. The pre-narrowed tool subset for this
 *     specific message. Providers that support tools should send only
 *     these. Providers that don't use tools (or that get an empty
 *     array) should call without tools.
 *   - modelTier: Layer 4. Abstract tier the provider should use:
 *     'heavy' = the full reasoning model (Sonnet/gemini-2.5-flash)
 *     'light' = the cheap model (Haiku/gemini-2.5-flash-lite)
 *     Providers map this to their own concrete model names.
 *   - maxTokensOverride: explicit max-tokens cap (existing field —
 *     promoted into the options bag for consistency).
 */
export interface CallDomainOptions {
  filteredTools?: unknown[]; // Anthropic.Tool[] — kept generic to avoid SDK import in this file
  modelTier?: 'heavy' | 'light';
  maxTokensOverride?: number;
  userId?: number;
  tenantId?: number;
}

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
   *
   * The optional `options` bag carries the TASK-17 Layer 3/4/5
   * optimization decisions (pre-filtered tools, model tier, max tokens).
   * Providers that don't recognize the bag should ignore it and use
   * their own defaults — backwards compatible.
   */
  callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult>;

  /**
   * Continue a conversation after executing tool calls.
   * The toolConversation contains the assistant's tool_use + user's tool_result messages.
   * Same options-bag semantics as callDomain.
   */
  continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
    options?: CallDomainOptions,
  ): Promise<AICallResult>;
}

/**
 * Helper: normalize the legacy `maxTokensOverride: number` argument or
 * the new `options: CallDomainOptions` argument into a uniform options
 * shape. Lets each provider's callDomain accept either form without
 * branching boilerplate at every call site.
 */
export function normalizeCallDomainOptions(
  arg?: number | CallDomainOptions,
): CallDomainOptions {
  if (arg == null) return {};
  if (typeof arg === 'number') return { maxTokensOverride: arg };
  return arg;
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
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    try {
      return await this.primary.callDomain(domain, history, currentMessage, stateContext, optionsOrMaxTokens);
    } catch (err) {
      this.onFallback?.(err as Error, 'callDomain');
      return this.fallback.callDomain(domain, history, currentMessage, stateContext, optionsOrMaxTokens);
    }
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
    options?: CallDomainOptions,
  ): Promise<AICallResult> {
    try {
      return await this.primary.continueWithToolResults(domain, history, currentMessage, stateContext, toolConversation, options);
    } catch (err) {
      this.onFallback?.(err as Error, 'continueWithToolResults');
      return this.fallback.continueWithToolResults(domain, history, currentMessage, stateContext, toolConversation, options);
    }
  }
}
