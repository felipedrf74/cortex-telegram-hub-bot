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

import { AIProvider, AICallResult, AIToolResultMessage, CallDomainOptions } from './ai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAIProvider, isOpenAIConfigured } from './openai-provider';
import { GeminiProvider, isGeminiProviderConfigured } from './gemini-provider';
import { OllamaProvider, isOllamaConfigured } from './ollama-provider';
import { TaskRoutingProvider, TaskRoutingConfig, TaskProviderPair, FallbackEvent } from './provider-fallback';
import { config } from '../config';
import { logger } from '../utils/logger';
import { captureError } from './error-monitor';
import { areModelProviderCallsDisabled, isAnthropicRuntimeEnabled } from './runtime-flags';
import type { ClassificationResult, DomainMessage, DomainName } from '../domains/types';

// ─── Provider Registry ─────────────────────────────────────────────

type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';

const providers = new Map<string, AIProvider>();

class LocalFixtureProvider implements AIProvider {
  readonly name = 'fixture';

  async classify(message: string): Promise<ClassificationResult> {
    const normalized = message.toLowerCase();
    if (/\b(script|content|post|caption|hook|youtube|linkedin|tiktok|reel)\b/.test(normalized)) {
      return { domain: 'content', confidence: 0.8 };
    }
    if (/\b(workout|training|run|bike|swim|recovery|gym)\b/.test(normalized)) {
      return { domain: 'triathlon', confidence: 0.8 };
    }
    if (/\b(invoice|budget|expense|finance|subscription|bill)\b/.test(normalized)) {
      return { domain: 'finance', confidence: 0.8 };
    }
    if (/\b(meal|cook|recipe|grocery|fueling|prep)\b/.test(normalized)) {
      return { domain: 'cooking', confidence: 0.8 };
    }
    return { domain: 'secretary', confidence: 0.6 };
  }

  async callDomain(
    domain: DomainName,
    _history: DomainMessage[],
    _currentMessage: string,
    _stateContext: string,
    _optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    return {
      text: `Local model fixture response for ${domain}. Real provider calls are disabled for this local run.`,
      toolCalls: [],
      stopReason: 'fixture',
    };
  }

  async continueWithToolResults(
    domain: DomainName,
    _history: DomainMessage[],
    _currentMessage: string,
    _stateContext: string,
    _toolConversation: AIToolResultMessage[],
    _options?: CallDomainOptions,
  ): Promise<AICallResult> {
    return {
      text: `Local model fixture continuation for ${domain}. Real provider calls are disabled for this local run.`,
      toolCalls: [],
      stopReason: 'fixture',
    };
  }
}

let _fixtureProvider: AIProvider | null = null;

function getFixtureProvider(): AIProvider {
  if (!_fixtureProvider) _fixtureProvider = new LocalFixtureProvider();
  return _fixtureProvider;
}

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
    case 'ollama': {
      // Config-only check (plan amendment R3-5). Reachability happens in
      // getProviderHealth(); the provider stays registered even if the
      // daemon is temporarily down so /health/detailed shows it as
      // unhealthy instead of silently dropping it.
      if (!isOllamaConfigured()) {
        logger.debug('Ollama provider requested but OLLAMA_ENABLED=false — skipping');
        return null;
      }
      const p = new OllamaProvider();
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
  if (areModelProviderCallsDisabled()) {
    return { primary: getFixtureProvider() };
  }

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
    // v2.6 (angry-QA-found): silent fallback to cloud when the configured
    // local primary is unavailable is dangerous — operators who intentionally
    // flipped AI_CLASSIFY_PRIMARY=ollama for cost/privacy reasons would
    // never notice their flip didn't take effect. For the local primary
    // specifically, fail loud (operator alert + structured log) unless
    // the explicit escape hatch is set.
    const isLocalPrimary = primaryName === 'ollama';
    const allowSilentCloudFallback = (process.env.AI_ALLOW_CLOUD_FALLBACK_WHEN_LOCAL_DISABLED || 'false') === 'true';
    const severity: 'warn' | 'error' = isLocalPrimary && !allowSilentCloudFallback ? 'error' : 'warn';
    const context = {
      requested: primaryName,
      selected: primary.name,
      isLocalPrimary,
      allowSilentCloudFallback,
    };
    if (severity === 'error') {
      logger.error(
        context,
        'CONFIG ERROR: AI_*_PRIMARY=ollama but Ollama provider is unavailable (OLLAMA_ENABLED=false or not configured). Configured fallback engaged silently — set AI_ALLOW_CLOUD_FALLBACK_WHEN_LOCAL_DISABLED=true to acknowledge, or fix OLLAMA_ENABLED.',
      );
      try {
        // Best-effort operator alert (recorder may not be available during
        // very-early startup; swallow to avoid blocking init).
        const { recordOperatorAlert } = require('./operator-alerts') as typeof import('./operator-alerts');
        recordOperatorAlert({
          severity: 'critical',
          source: 'provider_routing',
          dedupeKey: `ollama-primary-unavailable:${primaryName}`,
          title: `AI primary=${primaryName} but Ollama is unavailable`,
          detail: `Configured primary provider '${primaryName}' is not available at startup; routing silently fell back to '${primary.name}'. Set OLLAMA_ENABLED=true to use local, or set AI_ALLOW_CLOUD_FALLBACK_WHEN_LOCAL_DISABLED=true to acknowledge.`,
          owner: 'ops',
          suspectedArea: 'ai_routing',
          userImpact: 'Local-first cost/privacy guarantee silently violated until reconfigured.',
          runbookUrl: 'docs/runbooks/ollama-local-llm.md#provider-availability',
          metadata: context,
        });
      } catch { /* alert recorder not available at startup */ }
    } else {
      logger.warn(
        context,
        'Configured primary provider unavailable — using first available provider instead',
      );
    }
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

function reportDisabledAnthropicConfiguration(
  taskType: 'classify' | 'chat' | 'tool-use',
  position: 'primary' | 'fallback',
  providerName: string,
): void {
  if (providerName !== 'anthropic') return;
  if (areModelProviderCallsDisabled()) return;
  if (isAnthropicRuntimeEnabled()) return;

  const context = {
    taskType,
    position,
    configuredProvider: providerName,
    anthropicEnabled: false,
  };
  logger.warn(
    context,
    'Anthropic provider configured while ANTHROPIC_ENABLED is false; provider will be skipped',
  );
  try {
    captureError(
      {
        level: 'warning',
        source: 'job',
        message: `Anthropic provider configured while disabled for ${taskType} ${position}`,
        context,
      },
      false,
    );
  } catch {
    // Observability must never break provider initialization.
  }
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

  reportDisabledAnthropicConfiguration('classify', 'primary', rc.classify.primary);
  reportDisabledAnthropicConfiguration('classify', 'fallback', rc.classify.fallback);
  reportDisabledAnthropicConfiguration('chat', 'primary', rc.chat.primary);
  reportDisabledAnthropicConfiguration('chat', 'fallback', rc.chat.fallback);
  reportDisabledAnthropicConfiguration('tool-use', 'primary', rc.toolUse.primary);
  reportDisabledAnthropicConfiguration('tool-use', 'fallback', rc.toolUse.fallback);

  const routingConfig: TaskRoutingConfig = {
    classify: buildPair(rc.classify.primary, rc.classify.fallback),
    chat: buildPair(rc.chat.primary, rc.chat.fallback),
    'tool-use': buildPair(rc.toolUse.primary, rc.toolUse.fallback),
    // v2: new task types added by WO-ollama-local-llm. The fallback can
    // be a real provider name OR a sentinel ('none' / 'approved_cloud_reasoning').
    // buildSentinelFallbackPair handles both. Pairs are only built when
    // the primary provider is actually available (e.g., Ollama enabled);
    // otherwise the task type is left undefined and the dispatch method
    // throws a clear configuration error.
    scriptGeneration: rc.scriptGeneration
      ? buildSentinelFallbackPair(rc.scriptGeneration.primary, rc.scriptGeneration.fallback)
      : undefined,
    localReasoning: rc.localReasoning
      ? buildSentinelFallbackPair(rc.localReasoning.primary, rc.localReasoning.fallback)
      : undefined,
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
      scriptGeneration: routingConfig.scriptGeneration
        ? `${routingConfig.scriptGeneration.primary.name}→${describeSentinelFallback(routingConfig.scriptGeneration.fallback)}`
        : 'unconfigured',
      localReasoning: routingConfig.localReasoning
        ? `${routingConfig.localReasoning.primary.name}→${describeSentinelFallback(routingConfig.localReasoning.fallback)}`
        : 'unconfigured',
      circuitBreaker: routingConfig.circuitBreaker,
      fixtureMode: areModelProviderCallsDisabled(),
    },
    'Provider routing initialized',
  );

  return provider;
}

/**
 * Build a SentinelFallbackPair for the new task types (scriptGeneration,
 * localReasoning). The fallback can be either a real provider name OR a
 * sentinel string ('none' / 'approved_cloud_reasoning') — preserve the
 * sentinel verbatim; only resolve real provider names.
 *
 * If the configured primary provider isn't available (e.g., OLLAMA_ENABLED=false),
 * return null so the registry skips building the pair and the dispatch
 * method throws a clean configuration error rather than a cryptic null
 * dereference.
 */
function buildSentinelFallbackPair(
  primaryName: string,
  fallbackName: string,
): { primary: AIProvider; fallback: AIProvider | 'none' | 'approved_cloud_reasoning' } | undefined {
  if (areModelProviderCallsDisabled()) {
    return undefined;
  }
  const primary = getProvider(primaryName);
  if (!primary) {
    logger.info(
      { primaryName, fallbackName },
      'New task-type primary unavailable — skipping pair build',
    );
    return undefined;
  }
  if (fallbackName === 'none' || fallbackName === 'approved_cloud_reasoning') {
    return { primary, fallback: fallbackName };
  }
  const fallback = getProvider(fallbackName);
  if (!fallback) {
    // Configured fallback unavailable — fail closed (sentinel 'none')
    // rather than silently falling through to no escalation.
    logger.info(
      { primaryName, fallbackName },
      'New task-type fallback provider unavailable — falling back to sentinel "none"',
    );
    return { primary, fallback: 'none' };
  }
  return { primary, fallback };
}

function describeSentinelFallback(
  fallback: AIProvider | 'none' | 'approved_cloud_reasoning',
): string {
  if (fallback === 'none' || fallback === 'approved_cloud_reasoning') return fallback;
  return fallback.name;
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
