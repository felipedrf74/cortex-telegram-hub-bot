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

import { AIProvider, AICallResult, AIToolResultMessage } from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { logger } from '../utils/logger';

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
  primaryProvider: string;
  fallbackProvider: string;
  circuitOpen: boolean;
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
  ): Promise<T> {
    const pair = this.routing[taskType];
    const primaryBreaker = this.getBreaker(pair.primary.name);

    // Try primary if circuit allows
    if (primaryBreaker.canAttempt()) {
      try {
        const result = await fn(pair.primary);
        primaryBreaker.recordSuccess();
        const pm = this.getMetrics(pair.primary.name);
        pm.usageCount++;
        pm.lastSuccessAt = new Date().toISOString();
        return result;
      } catch (err) {
        primaryBreaker.recordFailure();
        const pm = this.getMetrics(pair.primary.name);
        pm.usageCount++;
        pm.failureCount++;
        pm.lastFailureAt = new Date().toISOString();

        if (pair.fallback) {
          const fm = this.getMetrics(pair.fallback.name);
          fm.fallbackTriggerCount++;

          this.onFallback?.({
            taskType,
            error: err as Error,
            primaryProvider: pair.primary.name,
            fallbackProvider: pair.fallback.name,
            circuitOpen: false,
          });
          logger.warn(
            { taskType, provider: pair.primary.name, err },
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

      this.onFallback?.({
        taskType,
        error: new Error(`Circuit open for ${pair.primary.name}`),
        primaryProvider: pair.primary.name,
        fallbackProvider: pair.fallback.name,
        circuitOpen: true,
      });
      logger.info(
        { taskType, provider: pair.primary.name },
        'Circuit open — routing directly to fallback',
      );
    }

    // Try fallback (track its own success/failure)
    try {
      const result = await fn(pair.fallback!);
      const fm = this.getMetrics(pair.fallback!.name);
      fm.usageCount++;
      fm.lastSuccessAt = new Date().toISOString();
      return result;
    } catch (fallbackErr) {
      const fm = this.getMetrics(pair.fallback!.name);
      fm.usageCount++;
      fm.failureCount++;
      fm.lastFailureAt = new Date().toISOString();
      throw fallbackErr;
    }
  }

  // ─── AIProvider interface ─────────────────────────────────────────

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
  ): Promise<ClassificationResult> {
    return this.executeWithFallback('classify', (p) =>
      p.classify(message, activeContext),
    );
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    maxTokensOverride?: number,
  ): Promise<AICallResult> {
    const taskType = resolveTaskType(domain);
    return this.executeWithFallback(taskType, (p) =>
      p.callDomain(domain, history, currentMessage, stateContext, maxTokensOverride),
    );
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
  ): Promise<AICallResult> {
    const taskType = resolveTaskType(domain);
    return this.executeWithFallback(taskType, (p) =>
      p.continueWithToolResults(domain, history, currentMessage, stateContext, toolConversation),
    );
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
