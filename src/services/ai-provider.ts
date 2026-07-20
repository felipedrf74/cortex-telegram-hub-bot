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
  /**
   * ADV-2: which concrete provider actually answered this call, stamped by
   * the TaskRoutingProvider dispatch layer (authoritative — it knows whether
   * the primary or the fallback ran). Tool-loop callers pass this back as
   * `CallDomainOptions.toolLoopProviderName` on continuation calls so open
   * tool_use ids never get handed to a provider that did not issue them.
   * Internal routing field — not serialized to clients.
   */
  routedProviderName?: string;
  /**
   * Optional per-call metadata surfaced for evaluation visibility (see
   * WO-ollama-local-llm). When LOCAL_LLM_SHOW_PROVIDER_METADATA=true,
   * iOS/portal responses expose this; otherwise it's stripped at the
   * serialization boundary (operator/admin surfaces still see it).
   *
   * Backwards compatible: existing cloud providers leave it undefined.
   */
  providerMetadata?: {
    providerUsed: string;
    modelUsed: string;
    modelDigest?: string;
    fallbackUsed: boolean;
    fallbackReason?: string;
    totalDurationNs?: number;
    loadDurationNs?: number;
    promptEvalCount?: number;
    promptEvalDurationNs?: number;
    evalCount?: number;
    evalDurationNs?: number;
    promptTokensPerSec?: number;
    generationTokensPerSec?: number;
    totalTokensPerSec?: number;
    isColdLoad?: boolean;
    warmGenerationMs?: number;
    warning?: string;
    recommendation?: string;
    validationStatus?: 'passed' | 'failed' | 'skipped';
    // v3.1 (Codex round-7 cleanup): narrowed from
    // `'sent_raw' | 'sent_redacted' | 'blocked_by_privacy_gate'` to just
    // `'sent_raw'`. The `'sent_redacted'` and `'blocked_by_privacy_gate'`
    // states are no longer reachable: the v3.1 gate either emits
    // `privacyAction='sent_raw'` (raw forward, only when escalation is
    // explicitly approved) or REJECTS via `CloudReasoningRejection` (in
    // which case the dispatch never populates `providerMetadata` from a
    // successful gate). Keeping the type as a single-member union forces
    // any future re-introduction of redaction to go through a public API
    // change with reviewer attention, rather than slipping in via
    // metadata leaking the removed state to downstream consumers.
    privacyAction?: 'sent_raw';
    // Phase K (2026-05-26): observability fields. Populated by
    // OllamaProvider.callDomain so audit_trail / iOS metadata surface
    // EXACTLY what went over the wire (no hardcoded literals — every
    // value reflects the actual request). Cloud providers may also
    // populate these in the future; current cloud providers leave them
    // undefined.
    domain?: string;
    temperature?: number;
    think?: boolean;
    numCtx?: number;
    numPredict?: number;
    // Phase K — quality-gate decision carry-through, set by
    // chat-message-routes.ts after applyChatResponseQualityGate runs.
    qualityGateSkipped?: boolean;
    qualityGateReason?: string;
  };
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
  /**
   * ADV-2: name of the provider that issued the tool_use ids in the open
   * tool loop (from the previous result's `routedProviderName`). When set,
   * continuation dispatch pins to that provider — no cross-provider fallback
   * mid-loop — and refuses with MidLoopProviderFallbackError if that
   * provider is no longer routable.
   */
  toolLoopProviderName?: string;
  /**
   * Explicit per-call model override. Used by `cloud-reasoning-gate.ts`
   * to ensure the selected approved reasoning model (e.g.,
   * gemini-2.5-pro) is actually used for the fallback call rather than
   * the provider's default chat/classify model. Cloud providers must
   * use this when set; the local Ollama provider also honors it for
   * symmetry. (Plan A2.)
   */
  modelOverride?: string;
  /** Request-level privacy metadata used by cloud-reasoning-gate. */
  containsPrivateData?: boolean;
  allowCloudEscalation?: boolean;
  redactionRequired?: boolean;
  /**
   * Phase K (2026-05-26) — request-level shape hints used by the
   * provider-fallback runtime hard-block to refuse routing certain
   * shapes to Ollama (which has no tool calling and no execute path
   * in v1). Both are optional and populated by `chat-message-routes.ts`
   * from the resolved `NexusAnswerContract` before dispatch.
   *
   * - `ownerSkill`: the contract.ownerSkill (e.g., 'training' even when
   *   domain is 'triathlon'). Lets the guard catch the
   *   domain↔ownerSkill mismatch case.
   * - `executeIntent`: true when contract.actionability === 'execute'.
   *   When true, Ollama is bypassed in favor of the cloud fallback
   *   regardless of domain.
   *
   * Kept as opaque optional strings/booleans to avoid importing
   * NexusAnswerContract from chat-answer-contract.ts here — that would
   * pull a domain-specific type into a foundational interface used by
   * every provider.
   */
  ownerSkill?: string;
  executeIntent?: boolean;
}

/**
 * Options bag for `classify()`. Mirrors `CallDomainOptions` for the
 * lightweight classify path. Added 2026-05-26 for Option 3 (small
 * dedicated classifier on Ollama with shadow-eval), but every field is
 * generic and applies to all providers:
 *
 *   - `userId`/`tenantId`: cost attribution on `api_usage` rows. Cloud
 *     providers already attribute via `trackedCreate`; this makes the
 *     attribution explicit for the local Ollama path (F-new-6).
 *   - `requestId`: chains `request-context` into shadow telemetry so a
 *     shadow row can be correlated with the live chat turn that
 *     spawned it.
 *   - `source`: defaults to 'live'. Set to 'shadow' by
 *     `classify-shadow.ts` so OllamaProvider can suppress side effects
 *     (api_usage write, rate-limit increment) for shadow runs (O3-A12
 *     OPTION 1, O3-A19).
 *   - `recordUsage`: explicit "do not write api_usage" flag for controlled
 *     offline evals or smoke runs only. Runtime shadow work sets this true
 *     and owns a separate budget reservation.
 *   - `timeoutMs`: per-call timeout. Providers should treat it as an
 *     advisory cap on their own AbortController setup.
 *   - `abortSignal`: external cancellation. Providers MUST forward this
 *     to `fetch()` (or equivalent) so a caller-side timeout actually
 *     terminates the underlying HTTP request (O3-A18). Without this,
 *     shadow timeouts would orphan in-flight model generations on the
 *     Ollama daemon, holding CPU + KV cache indefinitely.
 */
export interface ClassifyOptions {
  userId?: number;
  tenantId?: number;
  requestId?: string;
  source?: 'live' | 'shadow';
  recordUsage?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface AIProvider {
  /** Provider identifier (e.g., 'anthropic', 'openai') */
  readonly name: string;

  /**
   * Classify a message into a domain.
   * Returns the domain and a confidence score (0-1).
   *
   * `options` is the optional Option-3 ClassifyOptions bag. Existing
   * callers omit it; providers default to live behavior (write api_usage,
   * respect rate limits, no cancellation signal). Shadow callers in
   * `classify-shadow.ts` set `source: 'shadow'` and pass an
   * `abortSignal` for caller-side timeout cancellation.
   */
  classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
    options?: ClassifyOptions,
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

  // ─── Optional capabilities (provider-specific) ──────────────────
  //
  // These are NOT required by every implementation. The Ollama provider
  // implements all three; cloud providers implement getProviderHealth
  // when they expose richer health than the default circuit-breaker
  // reading. Callers check `if (provider.generateScript) ...` etc.

  /**
   * Two-step structured script generation (plan → artifacts → sandboxed
   * validation). Only the local provider supports this in v1; cloud
   * providers leave it undefined so `scriptGeneration` task type cannot
   * silently escalate.
   */
  generateScript?(task: unknown): Promise<unknown>;

  /**
   * Single-shot reasoning with optional structured-output schema. Used
   * by the `localReasoning` task type; the routing layer may escalate to
   * an approved cloud reasoning model via cloud-reasoning-gate when the
   * local model returns `requires_cloud_reasoning=true` AND policy
   * allows.
   */
  localReason?(task: unknown): Promise<unknown>;

  // NOTE: getProviderHealth is intentionally NOT on the interface.
  // TaskRoutingProvider already exposes its own getProviderHealth() with
  // a different signature (Record<string, {circuit, metrics}>) for the
  // /health/detailed route. The OllamaProvider exposes a richer per-call
  // health snapshot as a concrete-class method (not interface-required)
  // so it doesn't clash with the routing-layer's signature.
}

/** Provider-agnostic health snapshot surfaced at `/health/detailed`. */
export interface ProviderHealthSnapshot {
  name: string;
  healthy: boolean;
  /** Probe latency in ms (most recent reachability check). */
  latencyMs?: number;
  /** Loaded models, if applicable (e.g., Ollama daemon's /api/ps). */
  modelsLoaded?: string[];
  /** Current in-process queue depth, if the provider has one. */
  queueDepth?: number;
  /** Pre-OOM degraded signal — provider works but is under pressure (plan A7). */
  degraded?: boolean;
  /** Symbolic warning when `degraded=true`. */
  warning?: 'memory_pressure' | 'swap_thrash' | 'slow_generation' | string;
  /** Last observed error message, if the provider tracks it. */
  lastError?: string;
  /** Available KB from /proc/meminfo (Linux only; informational). */
  memAvailableKb?: number;
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

function isUsagePersistenceFailure(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | null;
  return candidate?.name === 'ApiUsagePersistenceError'
    || candidate?.code === 'AI_USAGE_PERSISTENCE_FAILED'
    || candidate?.name === 'AiBudgetError';
}

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
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    try {
      return await this.primary.classify(message, activeContext, options);
    } catch (err) {
      if (isUsagePersistenceFailure(err)) throw err;
      this.onFallback?.(err as Error, 'classify');
      return this.fallback.classify(message, activeContext, options);
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
      if (isUsagePersistenceFailure(err)) throw err;
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
      if (isUsagePersistenceFailure(err)) throw err;
      this.onFallback?.(err as Error, 'continueWithToolResults');
      return this.fallback.continueWithToolResults(domain, history, currentMessage, stateContext, toolConversation, options);
    }
  }
}
