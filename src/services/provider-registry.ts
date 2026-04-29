// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Provider Registry — Manages available AI providers and creates the
 * TaskRoutingProvider based on configuration.
 *
 * Usage:
 *   const provider = createRoutingProvider();
 *   // provider.classify(), provider.callDomain(), etc.
 *
 * The registry lazily instantiates providers only when referenced in config.
 * If a configured fallback provider isn't available (no API key), it's
 * silently skipped — the system degrades to no-fallback for that task type.
 */

import { AIProvider } from './ai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAIProvider, isOpenAIConfigured } from './openai-provider';
import { GeminiProvider, isGeminiProviderConfigured } from './gemini-provider';
import { TaskRoutingProvider, TaskRoutingConfig, TaskProviderPair, FallbackEvent } from './provider-fallback';
import { config } from '../config';
import { logger } from '../utils/logger';
import { captureError } from './error-monitor';
import { isAnthropicRuntimeEnabled } from './runtime-flags';

// ─── Provider Registry ─────────────────────────────────────────────

type ProviderName = 'anthropic' | 'openai' | 'gemini';

const providers = new Map<string, AIProvider>();

function getUsableProvider(name: string): AIProvider | null {
  if (name === 'anthropic' && !isAnthropicRuntimeEnabled()) {
    logger.debug('Anthropic provider requested while ANTHROPIC_ENABLED is false — skipping');
    return null;
  }
  return getProvider(name);
}

function resolveAvailableProvider(candidates: string[]): AIProvider | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const provider = getUsableProvider(candidate);
    if (provider) return provider;
  }
  return null;
}

/** Get or create a provider instance by name. Returns null if not configured. */
export function getProvider(name: string): AIProvider | null {
  if (providers.has(name)) return providers.get(name)!;

  switch (name as ProviderName) {
    case 'anthropic': {
      const p = new AnthropicProvider();
      providers.set(name, p);
      return p;
    }
    case 'openai': {
      if (!isOpenAIConfigured()) {
        logger.debug('OpenAI provider requested but OPENAI_API_KEY not set — skipping');
        return null;
      }
      const p = new OpenAIProvider();
      providers.set(name, p);
      return p;
    }
    case 'gemini': {
      if (!isGeminiProviderConfigured()) {
        logger.debug('Gemini provider requested but GEMINI_API_KEY not set — skipping');
        return null;
      }
      const p = new GeminiProvider();
      providers.set(name, p);
      return p;
    }
    default:
      logger.warn({ name }, 'Unknown provider name in config — skipping');
      return null;
  }
}

/**
 * Build a TaskProviderPair from config strings.
 * If the primary isn't available, falls back to anthropic (always available).
 * If the fallback isn't available, runs without fallback.
 */
function buildPair(primaryName: string, fallbackName: string): TaskProviderPair {
  let primary = resolveAvailableProvider([
    primaryName,
    fallbackName,
    'gemini',
    'openai',
    'anthropic',
  ]);
  if (!primary) {
    throw new Error(
      `No AI providers available for primary='${primaryName}' fallback='${fallbackName}'. ` +
      'Set GEMINI_API_KEY or OPENAI_API_KEY, or explicitly re-enable Anthropic.',
    );
  }

  if (primary.name !== primaryName) {
    logger.warn(
      { requested: primaryName, selected: primary.name },
      'Configured primary provider unavailable — using first available provider instead',
    );
  }

  let fallback: AIProvider | undefined;
  const fallbackCandidates = [
    fallbackName,
    primaryName,
    'gemini',
    'openai',
    'anthropic',
  ].filter((name) => !!name && name !== primary.name);
  if (fallbackCandidates.length > 0) {
    fallback = resolveAvailableProvider(fallbackCandidates) || undefined;
    if (!fallback && fallbackName) {
      logger.info(
        { requested: fallbackName },
        'Configured fallback provider unavailable — running without fallback',
      );
    }
  }

  return { primary, fallback };
}

// ─── Active provider singleton ─────────────────────────────────

let _activeProvider: TaskRoutingProvider | null = null;

/** Get the active routing provider instance (set by createRoutingProvider). */
export function getActiveProvider(): TaskRoutingProvider | null {
  return _activeProvider;
}

export function ensureActiveProvider(
  onFallback?: (event: FallbackEvent) => void,
): TaskRoutingProvider | null {
  if (_activeProvider) return _activeProvider;
  try {
    return createRoutingProvider(onFallback);
  } catch (err) {
    logger.error({ err }, 'Failed to lazily initialize AI provider routing');
    return null;
  }
}

// ─── Factory ───────────────────────────────────────────────────────

/**
 * Create the production TaskRoutingProvider from config.
 * This is the main entry point — call once at startup.
 */
export function createRoutingProvider(
  onFallback?: (event: FallbackEvent) => void,
): TaskRoutingProvider {
  const rc = config.providerRouting;

  const routingConfig: TaskRoutingConfig = {
    classify: buildPair(rc.classify.primary, rc.classify.fallback),
    chat: buildPair(rc.chat.primary, rc.chat.fallback),
    'tool-use': buildPair(rc.toolUse.primary, rc.toolUse.fallback),
    circuitBreaker: {
      failureThreshold: rc.circuitBreaker.failureThreshold,
      cooldownMs: rc.circuitBreaker.cooldownMs,
    },
  };

  const provider = new TaskRoutingProvider(routingConfig, onFallback || defaultFallbackHandler);
  _activeProvider = provider;

  logger.info(
    {
      classify: `${routingConfig.classify.primary.name}→${routingConfig.classify.fallback?.name || 'none'}`,
      chat: `${routingConfig.chat.primary.name}→${routingConfig.chat.fallback?.name || 'none'}`,
      'tool-use': `${routingConfig['tool-use'].primary.name}→${routingConfig['tool-use'].fallback?.name || 'none'}`,
      circuitBreaker: routingConfig.circuitBreaker,
    },
    'Provider routing initialized',
  );

  return provider;
}

function defaultFallbackHandler(event: FallbackEvent): void {
  logger.warn(
    {
      taskType: event.taskType,
      from: event.primaryProvider,
      to: event.fallbackProvider,
      circuitOpen: event.circuitOpen,
      fallbackReason: event.fallbackReason,
      error: event.errorSummary,
      category: event.category,
      domain: event.domain,
      modelTier: event.modelTier,
      requestId: event.requestId,
      requestSource: event.requestSource,
      tenantId: event.tenantId,
      userId: event.userId,
      tenantScope: event.tenantScope,
      operatorOverrideApplied: event.operatorOverrideApplied,
      pairSource: event.pairSource,
    },
    'AI provider fallback triggered',
  );

  // Emit a Sentry-visible warning so provider degradation (primary down,
  // circuit opened, sustained fallback traffic) surfaces as an alert
  // instead of burying itself in log noise. Level is `warning` so the
  // Telegram alerter stays quiet — fallback is working-as-designed
  // degradation, not an outage. Sentry tagging by taskType + from/to
  // makes it easy to see "Gemini is down, we've been on OpenAI for 1h".
  try {
    captureError(
      {
        level: 'warning',
        source: 'job',
        message: `AI provider fallback: ${event.primaryProvider} → ${event.fallbackProvider} for ${event.taskType}`,
        context: {
          taskType: event.taskType,
          primaryProvider: event.primaryProvider,
          fallbackProvider: event.fallbackProvider,
          circuitOpen: event.circuitOpen,
          fallbackReason: event.fallbackReason,
          error: event.errorSummary,
          category: event.category,
          domain: event.domain,
          modelTier: event.modelTier,
          requestId: event.requestId,
          requestSource: event.requestSource,
          tenantId: event.tenantId,
          userId: event.userId,
          tenantScope: event.tenantScope,
          operatorOverrideApplied: event.operatorOverrideApplied,
          pairSource: event.pairSource,
        },
      },
      false, // never alert — fallback is noisy, Sentry already aggregates
    );
  } catch {
    // Never let observability wiring break the hot AI path.
  }
}

/** Clear cached provider instances (for testing). */
export function clearProviderCache(): void {
  providers.clear();
  _activeProvider = null;
}
