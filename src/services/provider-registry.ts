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

// ─── Provider Registry ─────────────────────────────────────────────

type ProviderName = 'anthropic' | 'openai' | 'gemini';

const providers = new Map<string, AIProvider>();

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
  let primary = getProvider(primaryName);
  if (!primary) {
    logger.warn(
      { requested: primaryName },
      'Configured primary provider unavailable — defaulting to anthropic',
    );
    primary = getProvider('anthropic')!;
  }

  let fallback: AIProvider | undefined;
  if (fallbackName && fallbackName !== primaryName) {
    fallback = getProvider(fallbackName) || undefined;
    if (!fallback) {
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
      error: event.error.message,
    },
    'AI provider fallback triggered',
  );
}

/** Clear cached provider instances (for testing). */
export function clearProviderCache(): void {
  providers.clear();
  _activeProvider = null;
}
