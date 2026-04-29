// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Provider Fallback — Per-task-type routing with circuit breaker auto-switch.
 *
 * Replaces the simple FallbackProvider with intelligent routing:
 * - Different primary/fallback providers per task type (classify, chat, tool-use)
 * - Circuit breaker per provider: after N consecutive failures, auto-switch to
 *   fallback without even trying the broken provider (saves latency)
 * - Half-open recovery: after cooldown, probe the primary once to check recovery
 */

import { AIProvider, AICallResult, AIToolResultMessage, CallDomainOptions } from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { logger } from '../utils/logger';
import { getCurrentContext } from '../utils/request-context';

// ─── Error Classification ─────────────────────────────────────────
// Only retryable errors should trigger circuit-breaker failures and fallback.
// Non-retryable errors (auth failures, bad requests) should throw immediately
// without polluting the circuit breaker state.

function isRetryableError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.error_code;
  // 429 = rate limited (retryable after backoff)
  if (status === 429) return true;
  // 5xx = server error (retryable)
  if (typeof status === 'number' && status >= 500) return true;
  // Network errors (retryable)
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND') return true;
  if (err?.code === 'UND_ERR_CONNECT_TIMEOUT' || err?.code === 'UND_ERR_SOCKET') return true;
  // Anthropic overloaded (retryable)
  if (err?.error?.type === 'overloaded_error') return true;
  // 4xx (except 429) = client error, not retryable
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  // Default: assume retryable (preserve existing behavior for unknown errors)
  return true;
}
import { planSecretaryOptimization, type SecretaryOptimization } from './secretary-tools';
import { TOOLS } from './anthropic';
import type Anthropic from '@anthropic-ai/sdk';

// ─── Tenant-safe routing metadata ─────────────────────────────────

export type RoutingCallKind = 'classify' | 'domain' | 'tool-continuation';
export type ProviderPairSource = 'task_default' | 'domain_override' | 'domain_cache';
export type FallbackReason =
  | 'rate_limited'
  | 'provider_server_error'
  | 'network_timeout'
  | 'network_unavailable'
  | 'provider_overloaded'
  | 'circuit_open'
  | 'unknown_retryable';

export interface SafeProviderErrorSummary {
  name: string;
  status?: number | string;
  code?: string;
  retryable: boolean;
  reason: FallbackReason | 'non_retryable';
}

export interface RoutingCallMetadata {
  callKind: RoutingCallKind;
  category: string;
  domain?: DomainName;
  userId?: number;
  tenantId?: number;
  modelTier?: CallDomainOptions['modelTier'];
  pairSource?: ProviderPairSource;
  operatorOverrideApplied?: boolean;
  historyCount?: number;
  promptChars?: number;
  stateContextChars?: number;
  toolConversationTurns?: number;
}

export interface SafeRoutingLogMetadata extends RoutingCallMetadata {
  taskType: TaskType;
  provider: string;
  requestId?: string;
  requestSource?: string;
  fallbackUsed: boolean;
  fallbackReason?: FallbackReason;
  primaryProvider?: string;
  fallbackProvider?: string;
  circuitOpen?: boolean;
  tenantScope: 'present' | 'missing';
  userScope: 'present' | 'missing';
  providerAttemptCount?: number;
  runawayThreshold?: number;
}

interface RequestProviderCallCounter {
  count: number;
  warned: boolean;
  lastSeen: number;
}

const requestProviderCallCounts = new Map<string, RequestProviderCallCounter>();

function fallbackReasonForError(err: any): FallbackReason {
  const status = err?.status ?? err?.statusCode ?? err?.error_code;
  const code = err?.code;
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 500) return 'provider_server_error';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET') return 'network_timeout';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'network_unavailable';
  if (err?.error?.type === 'overloaded_error') return 'provider_overloaded';
  return 'unknown_retryable';
}

function summarizeProviderError(err: any, retryable = isRetryableError(err)): SafeProviderErrorSummary {
  const status = err?.status ?? err?.statusCode ?? err?.error_code;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const name = typeof err?.name === 'string' && err.name.trim() ? err.name : 'ProviderError';
  return {
    name,
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    retryable,
    reason: retryable ? fallbackReasonForError(err) : 'non_retryable',
  };
}

function runawayThreshold(): number {
  const raw = Number.parseInt(process.env.AI_PROVIDER_RUNAWAY_CALL_THRESHOLD || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

function safeRoutingMetadata(
  taskType: TaskType,
  provider: string,
  metadata: RoutingCallMetadata | undefined,
  opts?: {
    fallbackUsed?: boolean;
    fallbackReason?: FallbackReason;
    primaryProvider?: string;
    fallbackProvider?: string;
    circuitOpen?: boolean;
  },
): SafeRoutingLogMetadata {
  const ctx = getCurrentContext();
  const tenantScope = typeof metadata?.tenantId === 'number' && Number.isFinite(metadata.tenantId) && metadata.tenantId > 0
    ? 'present'
    : 'missing';
  const userScope = typeof metadata?.userId === 'number' && Number.isFinite(metadata.userId) && metadata.userId > 0
    ? 'present'
    : 'missing';
  return {
    callKind: metadata?.callKind ?? (taskType === 'classify' ? 'classify' : 'domain'),
    category: metadata?.category ?? taskType,
    taskType,
    provider,
    ...(metadata?.domain ? { domain: metadata.domain } : {}),
    ...(metadata?.userId !== undefined ? { userId: metadata.userId } : {}),
    ...(metadata?.tenantId !== undefined ? { tenantId: metadata.tenantId } : {}),
    ...(metadata?.modelTier ? { modelTier: metadata.modelTier } : {}),
    ...(metadata?.pairSource ? { pairSource: metadata.pairSource } : {}),
    ...(metadata?.operatorOverrideApplied !== undefined ? { operatorOverrideApplied: metadata.operatorOverrideApplied } : {}),
    ...(metadata?.historyCount !== undefined ? { historyCount: metadata.historyCount } : {}),
    ...(metadata?.promptChars !== undefined ? { promptChars: metadata.promptChars } : {}),
    ...(metadata?.stateContextChars !== undefined ? { stateContextChars: metadata.stateContextChars } : {}),
    ...(metadata?.toolConversationTurns !== undefined ? { toolConversationTurns: metadata.toolConversationTurns } : {}),
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.source ? { requestSource: ctx.source } : {}),
    fallbackUsed: Boolean(opts?.fallbackUsed),
    ...(opts?.fallbackReason ? { fallbackReason: opts.fallbackReason } : {}),
    ...(opts?.primaryProvider ? { primaryProvider: opts.primaryProvider } : {}),
    ...(opts?.fallbackProvider ? { fallbackProvider: opts.fallbackProvider } : {}),
    ...(opts?.circuitOpen !== undefined ? { circuitOpen: opts.circuitOpen } : {}),
    tenantScope,
    userScope,
  };
}

function trackRunawayProviderCalls(meta: SafeRoutingLogMetadata): SafeRoutingLogMetadata {
  if (!meta.requestId) return meta;
  const threshold = runawayThreshold();
  const now = Date.now();
  const existing = requestProviderCallCounts.get(meta.requestId) ?? { count: 0, warned: false, lastSeen: now };
  existing.count++;
  existing.lastSeen = now;
  requestProviderCallCounts.set(meta.requestId, existing);

  if (requestProviderCallCounts.size > 1000) {
    for (const [key, value] of requestProviderCallCounts.entries()) {
      if (now - value.lastSeen > 15 * 60 * 1000) requestProviderCallCounts.delete(key);
    }
  }

  const enriched = {
    ...meta,
    providerAttemptCount: existing.count,
    runawayThreshold: threshold,
  };

  if (existing.count > threshold && !existing.warned) {
    existing.warned = true;
    logger.warn(
      enriched,
      'Potential runaway AI provider call loop detected',
    );
  }

  return enriched;
}

function sanitizedFallbackError(reason: FallbackReason | 'non_retryable'): Error {
  return new Error(`provider_failure:${reason}`);
}

// ─── Task Types ────────────────────────────────────────────────────

/** The three categories of AI work, each independently routable. */
export type TaskType = 'classify' | 'chat' | 'tool-use';

/**
 * Determine the task type for a callDomain/continueWithToolResults call.
 * Secretary and triathlon use tools; content is pure chat.
 */
export function resolveTaskType(domain: DomainName): TaskType {
  if (domain === 'secretary' || domain === 'triathlon') return 'tool-use';
  return 'chat';
}

// ─── Circuit Breaker ───────────────────────────────────────────────

export enum CircuitState {
  CLOSED = 'CLOSED',       // Healthy — requests flow normally
  OPEN = 'OPEN',           // Down — skip provider, use fallback directly
  HALF_OPEN = 'HALF_OPEN', // Probing — allow one request to test recovery
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit (default: 3) */
  failureThreshold: number;
  /** Milliseconds to wait before probing (half-open) after opening (default: 60000) */
  cooldownMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(
    readonly providerName: string,
    private options: CircuitBreakerOptions,
  ) {}

  /** Whether the circuit allows a request through. */
  canAttempt(): boolean {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN: {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.options.cooldownMs) {
          this.state = CircuitState.HALF_OPEN;
          logger.info(
            { provider: this.providerName, elapsed },
            'Circuit breaker half-open — probing provider',
          );
          return true;
        }
        return false;
      }

      case CircuitState.HALF_OPEN:
        // Already probing — allow the single request
        return true;
    }
  }

  /** Record a successful call — resets failures and closes circuit. */
  recordSuccess(): void {
    if (this.state !== CircuitState.CLOSED) {
      logger.info(
        { provider: this.providerName, previousState: this.state },
        'Circuit breaker closed — provider recovered',
      );
    }
    this.consecutiveFailures = 0;
    this.state = CircuitState.CLOSED;
  }

  /** Record a failed call — may open the circuit. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Probe failed — go back to open
      this.state = CircuitState.OPEN;
      logger.warn(
        { provider: this.providerName },
        'Circuit breaker re-opened — probe failed',
      );
      return;
    }

    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
      logger.warn(
        { provider: this.providerName, failures: this.consecutiveFailures },
        'Circuit breaker opened — provider marked as down',
      );
    }
  }

  /** Current circuit state (for monitoring/telemetry). */
  getState(): CircuitState {
    return this.state;
  }

  /** Current consecutive failure count. */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /** Reset the breaker to closed state (e.g., for manual recovery). */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.state = CircuitState.CLOSED;
  }
}

// ─── Task Routing Provider ─────────────────────────────────────────

export interface TaskProviderPair {
  primary: AIProvider;
  fallback?: AIProvider;
}

export interface TaskRoutingConfig {
  classify: TaskProviderPair;
  chat: TaskProviderPair;
  'tool-use': TaskProviderPair;
  circuitBreaker: CircuitBreakerOptions;
}

/** Per-provider usage metrics (in-memory, resets on restart). */
export interface ProviderMetrics {
  /** Total API calls attempted */
  usageCount: number;
  /** Total failed calls */
  failureCount: number;
  /** Number of times this provider was used as a fallback */
  fallbackTriggerCount: number;
  /** Number of times this provider's circuit opened */
  circuitOpenCount: number;
  /** Timestamp of last successful call */
  lastSuccessAt: string | null;
  /** Timestamp of last failure */
  lastFailureAt: string | null;
}

/**
 * Callback when a fallback is used.
 * Includes the task type and error that triggered the fallback.
 */
export interface FallbackEvent {
  taskType: TaskType;
  error: Error;
  errorSummary: SafeProviderErrorSummary;
  fallbackReason: FallbackReason;
  primaryProvider: string;
  fallbackProvider: string;
  circuitOpen: boolean;
  callKind: RoutingCallKind;
  category: string;
  domain?: DomainName;
  modelTier?: CallDomainOptions['modelTier'];
  userId?: number;
  tenantId?: number;
  requestId?: string;
  requestSource?: string;
  pairSource?: ProviderPairSource;
  operatorOverrideApplied?: boolean;
  tenantScope: 'present' | 'missing';
  userScope: 'present' | 'missing';
}

/**
 * AIProvider that routes each task type to its configured primary provider,
 * falling back automatically when the primary fails or its circuit is open.
 */
export class TaskRoutingProvider implements AIProvider {
  readonly name: string;
  private breakers = new Map<string, CircuitBreaker>();
  private metrics = new Map<string, ProviderMetrics>();
  private onFallback?: (event: FallbackEvent) => void;

  constructor(
    private routing: TaskRoutingConfig,
    onFallback?: (event: FallbackEvent) => void,
  ) {
    this.onFallback = onFallback;

    // Build display name from unique providers
    const providers = new Set<string>();
    for (const pair of [routing.classify, routing.chat, routing['tool-use']]) {
      providers.add(pair.primary.name);
      if (pair.fallback) providers.add(pair.fallback.name);
    }
    this.name = `routing(${[...providers].join(',')})`;
  }

  private getBreaker(providerName: string): CircuitBreaker {
    let breaker = this.breakers.get(providerName);
    if (!breaker) {
      breaker = new CircuitBreaker(providerName, this.routing.circuitBreaker);
      this.breakers.set(providerName, breaker);
    }
    return breaker;
  }

  private getMetrics(providerName: string): ProviderMetrics {
    let m = this.metrics.get(providerName);
    if (!m) {
      m = {
        usageCount: 0,
        failureCount: 0,
        fallbackTriggerCount: 0,
        circuitOpenCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
      };
      this.metrics.set(providerName, m);
    }
    return m;
  }

  /**
   * Execute a task with fallback logic:
   * 1. Check primary's circuit breaker — if open, go straight to fallback
   * 2. Try primary — record success/failure on its circuit breaker
   * 3. On failure, try fallback (if available)
   * 4. If no fallback or fallback also fails, throw
   */
  private async executeWithFallback<T>(
    taskType: TaskType,
    fn: (provider: AIProvider) => Promise<T>,
    pairOverride?: TaskProviderPair,
    metadata?: RoutingCallMetadata,
  ): Promise<T> {
    const pair = pairOverride ?? this.routing[taskType];
    const primaryBreaker = this.getBreaker(pair.primary.name);

    // Try primary if circuit allows
    if (primaryBreaker.canAttempt()) {
      try {
        const attemptMeta = trackRunawayProviderCalls(safeRoutingMetadata(taskType, pair.primary.name, metadata));
        if (attemptMeta.userScope === 'present' && attemptMeta.tenantScope === 'missing') {
          logger.warn(
            attemptMeta,
            'AI provider call has user scope but no tenant scope',
          );
        }
        logger.debug(attemptMeta, 'AI provider routing attempt');
        const result = await fn(pair.primary);
        primaryBreaker.recordSuccess();
        const pm = this.getMetrics(pair.primary.name);
        pm.usageCount++;
        pm.lastSuccessAt = new Date().toISOString();
        logger.debug(attemptMeta, 'AI provider routing attempt succeeded');
        return result;
      } catch (err) {
        const retryable = isRetryableError(err);
        const errorSummary = summarizeProviderError(err, retryable);
        if (retryable) {
          primaryBreaker.recordFailure();
        }
        // Always track metrics regardless of retryability
        const pm = this.getMetrics(pair.primary.name);
        pm.usageCount++;
        pm.failureCount++;
        pm.lastFailureAt = new Date().toISOString();

        // Non-retryable errors (auth, bad request) should not trigger fallback
        if (!retryable) {
          logger.warn(
            {
              ...safeRoutingMetadata(taskType, pair.primary.name, metadata),
              error: errorSummary,
            },
            'Non-retryable error — not falling back (would fail too)',
          );
          throw err;
        }

        if (pair.fallback) {
          const fm = this.getMetrics(pair.fallback.name);
          fm.fallbackTriggerCount++;

          const fallbackReason = errorSummary.reason as FallbackReason;
          this.emitFallbackEvent({
            ...safeRoutingMetadata(taskType, pair.fallback.name, metadata, {
              fallbackUsed: true,
              fallbackReason,
              primaryProvider: pair.primary.name,
              fallbackProvider: pair.fallback.name,
              circuitOpen: false,
            }),
            error: sanitizedFallbackError(fallbackReason),
            errorSummary,
            fallbackReason,
            primaryProvider: pair.primary.name,
            fallbackProvider: pair.fallback.name,
            circuitOpen: false,
          });
          logger.warn(
            {
              ...safeRoutingMetadata(taskType, pair.primary.name, metadata, {
                fallbackReason,
                primaryProvider: pair.primary.name,
                fallbackProvider: pair.fallback.name,
                circuitOpen: false,
              }),
              error: errorSummary,
            },
            'Primary provider failed — trying fallback',
          );
        } else {
          // No fallback available — rethrow
          throw err;
        }
      }
    } else {
      // Circuit is open — go straight to fallback
      if (!pair.fallback) {
        throw new Error(
          `Provider ${pair.primary.name} circuit is open and no fallback configured for task type "${taskType}"`,
        );
      }
      const pm = this.getMetrics(pair.primary.name);
      pm.circuitOpenCount++;
      const fm = this.getMetrics(pair.fallback.name);
      fm.fallbackTriggerCount++;

      const fallbackReason: FallbackReason = 'circuit_open';
      const errorSummary: SafeProviderErrorSummary = {
        name: 'CircuitOpen',
        retryable: true,
        reason: fallbackReason,
      };
      this.emitFallbackEvent({
        ...safeRoutingMetadata(taskType, pair.fallback.name, metadata, {
          fallbackUsed: true,
          fallbackReason,
          primaryProvider: pair.primary.name,
          fallbackProvider: pair.fallback.name,
          circuitOpen: true,
        }),
        error: sanitizedFallbackError(fallbackReason),
        errorSummary,
        fallbackReason,
        primaryProvider: pair.primary.name,
        fallbackProvider: pair.fallback.name,
        circuitOpen: true,
      });
      logger.info(
        safeRoutingMetadata(taskType, pair.primary.name, metadata, {
          fallbackReason,
          primaryProvider: pair.primary.name,
          fallbackProvider: pair.fallback.name,
          circuitOpen: true,
        }),
        'Circuit open — routing directly to fallback',
      );
    }

    // Try fallback (track its own success/failure)
    try {
      const fallbackMeta = trackRunawayProviderCalls(safeRoutingMetadata(taskType, pair.fallback!.name, metadata, {
        fallbackUsed: true,
        primaryProvider: pair.primary.name,
        fallbackProvider: pair.fallback!.name,
      }));
      logger.debug(fallbackMeta, 'AI provider fallback attempt');
      const result = await fn(pair.fallback!);
      const fm = this.getMetrics(pair.fallback!.name);
      fm.usageCount++;
      fm.lastSuccessAt = new Date().toISOString();
      logger.info(fallbackMeta, 'AI provider fallback succeeded');
      return result;
    } catch (fallbackErr) {
      const retryable = isRetryableError(fallbackErr);
      const errorSummary = summarizeProviderError(fallbackErr, retryable);
      const fm = this.getMetrics(pair.fallback!.name);
      fm.usageCount++;
      fm.failureCount++;
      fm.lastFailureAt = new Date().toISOString();
      logger.warn(
        {
          ...safeRoutingMetadata(taskType, pair.fallback!.name, metadata, {
            fallbackUsed: true,
            fallbackReason: errorSummary.reason === 'non_retryable' ? undefined : errorSummary.reason,
            primaryProvider: pair.primary.name,
            fallbackProvider: pair.fallback!.name,
          }),
          error: errorSummary,
        },
        'Fallback provider failed',
      );
      throw fallbackErr;
    }
  }

  private emitFallbackEvent(event: FallbackEvent): void {
    if (!this.onFallback) return;
    try {
      this.onFallback(event);
    } catch (err) {
      logger.warn(
        {
          err: summarizeProviderError(err, false),
          taskType: event.taskType,
          primaryProvider: event.primaryProvider,
          fallbackProvider: event.fallbackProvider,
          fallbackReason: event.fallbackReason,
          requestId: event.requestId,
        },
        'AI provider fallback observer failed; continuing with fallback',
      );
    }
  }

  // ─── AIProvider interface ─────────────────────────────────────────

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
  ): Promise<ClassificationResult> {
    return this.executeWithFallback('classify', (p) =>
      p.classify(message, activeContext),
      undefined,
      {
        callKind: 'classify',
        category: 'classify_message',
        promptChars: message.length,
        historyCount: activeContext ? 1 : 0,
        pairSource: 'task_default',
        operatorOverrideApplied: false,
      },
    );
  }

  // Cache domain-specific provider pairs to avoid re-construction on every call.
  // Key: domain name, Value: resolved pair. Invalidated when routing config changes.
  private domainPairCache = new Map<string, TaskProviderPair>();

  /**
   * Resolve provider pair for a domain. Checks domain-provider-router first
   * for domain-specific routing (e.g., secretary→Claude, cooking→Gemini),
   * then falls back to task-type routing.
   */
  private resolveProviderPairForDomain(domain: DomainName): {
    taskType: TaskType;
    pair: TaskProviderPair;
    pairSource: ProviderPairSource;
    operatorOverrideApplied: boolean;
  } {
    const taskType = resolveTaskType(domain);
    const defaultPair = this.routing[taskType];

    // Check cache first
    const cached = this.domainPairCache.get(domain);
    if (cached) {
      return { taskType, pair: cached, pairSource: 'domain_cache', operatorOverrideApplied: true };
    }

    // Check domain-specific provider routing (e.g., cooking→Gemini)
    try {
      const { getProviderForDomain, getFallbackForDomain } = require('./domain-provider-router');
      const domainProvider = getProviderForDomain(domain);
      const domainFallback = getFallbackForDomain(domain);

      // If the domain-specific provider differs from the task-type primary,
      // build and cache a dedicated pair for this domain
      if (domainProvider !== defaultPair.primary.name) {
        const { getProvider } = require('./provider-registry');
        const primary = getProvider(domainProvider);
        const fallback = getProvider(domainFallback);
        if (primary) {
          const pair: TaskProviderPair = { primary, fallback: fallback || defaultPair.fallback };
          this.domainPairCache.set(domain, pair);
          logger.info({ domain, provider: domainProvider, fallback: domainFallback }, 'Domain-specific provider pair cached');
          return { taskType, pair, pairSource: 'domain_override', operatorOverrideApplied: true };
        }
      }
    } catch {
      // domain-provider-router not available — use task-type routing
    }

    return { taskType, pair: defaultPair, pairSource: 'task_default', operatorOverrideApplied: false };
  }

  /** Clear cached domain pairs (call when routing config changes at runtime). */
  clearDomainPairCache(): void {
    this.domainPairCache.clear();
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    const { taskType, pair, pairSource, operatorOverrideApplied } = this.resolveProviderPairForDomain(domain);

    // ── TASK-17 Layer 3+4+5: provider-agnostic optimization ──────
    //
    // Compute the optimization decision ONCE at dispatch time, then
    // pass it to whichever concrete provider runs (Anthropic OR Gemini
    // OR a future OpenAI provider). This is what makes the optimization
    // work uniformly across providers — the decision is made before the
    // provider is selected, not duplicated inside each provider.
    //
    // The caller may also have passed maxTokensOverride or its own
    // CallDomainOptions; we merge those with the optimization result so
    // explicit overrides win over the auto-computed values.
    const callerOpts = typeof optionsOrMaxTokens === 'number'
      ? { maxTokensOverride: optionsOrMaxTokens }
      : (optionsOrMaxTokens || {});
    const opts = this.buildOptimizedOptions(domain, history, currentMessage, callerOpts);

    return this.executeWithFallback(taskType, (p) =>
      p.callDomain(domain, opts.slicedHistory, currentMessage, stateContext, opts.callOptions),
    pair, {
      callKind: 'domain',
      category: `domain_${domain}`,
      domain,
      userId: opts.callOptions.userId,
      tenantId: opts.callOptions.tenantId,
      modelTier: opts.callOptions.modelTier,
      pairSource,
      operatorOverrideApplied,
      historyCount: opts.slicedHistory.length,
      promptChars: currentMessage.length,
      stateContextChars: stateContext.length,
    });
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
    options?: CallDomainOptions,
  ): Promise<AICallResult> {
    const { taskType, pair, pairSource, operatorOverrideApplied } = this.resolveProviderPairForDomain(domain);

    // Same optimization logic as callDomain. Critical: must compute the
    // SAME decision (same currentMessage → same tier/tools/history) so
    // the tool loop sees a stable shape across iterations. Otherwise
    // both Anthropic and Gemini will reject the second call because
    // tool_use_id references a tool that's no longer in scope.
    const callerOpts = options || {};
    const opts = this.buildOptimizedOptions(domain, history, currentMessage, callerOpts);

    return this.executeWithFallback(taskType, (p) =>
      p.continueWithToolResults(domain, opts.slicedHistory, currentMessage, stateContext, toolConversation, opts.callOptions),
    pair, {
      callKind: 'tool-continuation',
      category: 'tool_continuation',
      domain,
      userId: opts.callOptions.userId,
      tenantId: opts.callOptions.tenantId,
      modelTier: opts.callOptions.modelTier,
      pairSource,
      operatorOverrideApplied,
      historyCount: opts.slicedHistory.length,
      promptChars: currentMessage.length,
      stateContextChars: stateContext.length,
      toolConversationTurns: toolConversation.length,
    });
  }

  /**
   * Build the per-call optimization options for a given message. Centralizes
   * the call to planSecretaryOptimization() and the per-domain tool
   * lookup so callDomain and continueWithToolResults stay DRY.
   *
   * Returns:
   *   - slicedHistory: the (possibly trimmed) history to send
   *   - callOptions: the CallDomainOptions to forward to the provider
   */
  private buildOptimizedOptions(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    callerOpts: CallDomainOptions,
  ): { slicedHistory: DomainMessage[]; callOptions: CallDomainOptions } {
    // Domain-filtered tool list (sub-skill aware) — same input both
    // providers would have used. We narrow it further in planSecretaryOptimization.
    let domainTools: Anthropic.Tool[];
    try {
      // Lazy require to avoid a circular import at module load time.
      // anthropic.ts → secretary-tools.ts (Layer 3 helper) →
      // secretary-tools.ts itself doesn't import anthropic, but anthropic
      // imports secretary-tools, and provider-fallback.ts is also pulled
      // in by tests that mock anthropic.ts — keeping this lazy avoids
      // a fragile import order.
      const { getToolsForDomainCached } = require('./anthropic');
      domainTools = getToolsForDomainCached(domain) as Anthropic.Tool[];
    } catch {
      domainTools = TOOLS;
    }

    const optimization: SecretaryOptimization = planSecretaryOptimization(
      domain,
      currentMessage,
      history,
      domainTools,
    );

    // Caller-supplied options win over the auto-computed values.
    // For example, if the caller passes filteredTools explicitly, that
    // overrides the auto-filter — useful for testing and for special
    // ops paths (like a "send all tools" debug flag).
    const callOptions: CallDomainOptions = {
      filteredTools: callerOpts.filteredTools ?? optimization.filteredTools,
      modelTier: callerOpts.modelTier ?? optimization.modelTier,
      maxTokensOverride: callerOpts.maxTokensOverride,
      userId: callerOpts.userId,
      tenantId: callerOpts.tenantId,
    };

    return {
      slicedHistory: optimization.slicedHistory,
      callOptions,
    };
  }

  // ─── Monitoring / diagnostics ─────────────────────────────────────

  /** Get the circuit breaker state for a specific provider. */
  getCircuitState(providerName: string): CircuitState | undefined {
    return this.breakers.get(providerName)?.getState();
  }

  /** Get all circuit breaker states (for telemetry dashboards). */
  getAllCircuitStates(): Record<string, { state: CircuitState; failures: number }> {
    const result: Record<string, { state: CircuitState; failures: number }> = {};
    for (const [name, breaker] of this.breakers) {
      result[name] = { state: breaker.getState(), failures: breaker.getFailureCount() };
    }
    return result;
  }

  /** Manually reset a provider's circuit breaker. */
  resetCircuit(providerName: string): void {
    this.breakers.get(providerName)?.reset();
  }

  /** Get all provider metrics (for /health/detailed). */
  getAllMetrics(): Record<string, ProviderMetrics> {
    const result: Record<string, ProviderMetrics> = {};
    for (const [name, m] of this.metrics) {
      result[name] = { ...m };
    }
    return result;
  }

  /** Combined circuit states + metrics for dashboards. */
  getProviderHealth(): Record<string, {
    circuit: { state: CircuitState; failures: number };
    metrics: ProviderMetrics;
  }> {
    const result: Record<string, {
      circuit: { state: CircuitState; failures: number };
      metrics: ProviderMetrics;
    }> = {};
    const allNames = new Set([...this.breakers.keys(), ...this.metrics.keys()]);
    for (const name of allNames) {
      const breaker = this.breakers.get(name);
      const metrics = this.metrics.get(name);
      result[name] = {
        circuit: breaker
          ? { state: breaker.getState(), failures: breaker.getFailureCount() }
          : { state: CircuitState.CLOSED, failures: 0 },
        metrics: metrics ?? {
          usageCount: 0, failureCount: 0, fallbackTriggerCount: 0,
          circuitOpenCount: 0, lastSuccessAt: null, lastFailureAt: null,
        },
      };
    }
    return result;
  }
}
