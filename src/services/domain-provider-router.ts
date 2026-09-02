// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Domain Provider Router — determines which AI provider handles each domain.
 *
 * Strategy (April 2026 revision — mixed primary routing):
 *   - secretary → OpenAI GPT-5.4 nano (best low-cost tool-use path)
 *   - triathlon → Gemini 2.5 Flash
 *   - content  → Gemini 2.5 Flash
 *   - finance  → Gemini 2.5 Flash
 *   - cooking  → Gemini 2.5 Flash
 *
 * OpenAI is the default cross-provider fallback for Gemini-backed domains.
 * Anthropic remains an explicit emergency path when the Gemini kill-switch or
 * operator overrides route traffic there and ANTHROPIC_ENABLED=true.
 *
 * Cost rationale (per MTK):
 *   Gemini 2.5 Flash: $0.30 / $2.50 — primary for non-secretary domains
 *   GPT-5.4 nano:     $0.20 / $1.25 — primary for secretary/eligible experiments
 *   Haiku 4.5:        $1.00 / $5    — emergency fallback where enabled/configured
 *   Sonnet 4.6:       $3.00 / $15   — not used in this router
 *
 * Feature flag: GEMINI_ROUTING_ENABLED is a kill-switch for the Gemini-backed
 * domains. When explicitly set to 'false' they route back to Anthropic as an
 * emergency escape hatch. It does not affect Secretary because Secretary's
 * configured primary is OpenAI. SECRETARY_PRIMARY_ROUTE_ENABLED independently
 * guards Secretary's configured primary route.
 */

import type { DomainName } from '../domains/types';
import type { ProviderName } from './model-config';
import { logger } from '../utils/logger';
import {
  getDomainProviderExperimentOverrides,
  getGeminiDomainAllowlist,
  getGeminiRoutingEnvOverride,
  isSecretaryHaikuRoutingEnabled,
  resolveSecretaryPrimaryRouteEnvOverride,
} from './runtime-flags';

// ─── Domain → Provider Mapping ──────────────────────────────────────

const DOMAIN_PROVIDER_MAP: Record<string, ProviderName> = {
  secretary:  'openai',    // GPT-5.4 nano — best tool-calling at lowest cost ($0.20/$1.25 per 1M)
  triathlon:  'gemini',
  content:    'gemini',
  finance:    'gemini',
  cooking:    'gemini',
};

// Fallbacks run when the primary provider errors, times out, or trips a
// circuit breaker. Gemini-backed domains use OpenAI as the cross-provider
// fallback so an Anthropic-disabled deployment still has a real fallback.
const DOMAIN_FALLBACK_MAP: Record<string, ProviderName> = {
  secretary:  'gemini',      // Gemini Flash as OpenAI fallback (cheaper than Anthropic)
  triathlon:  'openai',
  content:    'openai',
  finance:    'openai',
  cooking:    'openai',
};

// ─── Feature Flag ───────────────────────────────────────────────────

// Gemini routing is ENABLED by default for non-secretary domains. Opt out by setting GEMINI_ROUTING_ENABLED=false
// in the environment, or toggle via the portal UI (persists to kv_store).
//
// Safe default: if GEMINI_API_KEY is not set, provider-registry returns null
// and resolveProviderPairForDomain falls back to anthropic automatically, so
// enabling this flag on a Gemini-less install is a no-op rather than a crash.
let _geminiRoutingEnabled = true;

// Domains controlled by the Gemini routing flagset. Secretary is not part of
// this set because its primary provider is OpenAI.
const DEFAULT_GEMINI_DOMAINS = ['triathlon', 'content', 'finance', 'cooking'];
let _geminiDomains = new Set<string>(DEFAULT_GEMINI_DOMAINS);
let _domainProviderExperimentOverrides = new Map<string, ProviderName>();

// Secretary's provider-neutral primary-route safeguard. When true (default),
// Secretary uses its routed OpenAI primary. When false, it degrades to the
// emergency Anthropic route.
let _secretaryPrimaryRouteEnabled = true;

/** Initialize from environment or kv_store */
export function initDomainRouting(): void {
  _geminiRoutingEnabled = true;
  _geminiDomains = new Set(DEFAULT_GEMINI_DOMAINS);
  _domainProviderExperimentOverrides = new Map();
  _secretaryPrimaryRouteEnabled = true;
  _secretaryHaikuEnabled = isSecretaryHaikuRoutingEnabled();

  const routingOverride = getGeminiRoutingEnvOverride();
  if (routingOverride !== null) {
    _geminiRoutingEnabled = routingOverride;
  }

  // Env override for the secretary primary-provider safeguard
  const secretaryRouteOverride = resolveSecretaryPrimaryRouteEnvOverride();
  if (secretaryRouteOverride.value !== null) {
    _secretaryPrimaryRouteEnabled = secretaryRouteOverride.value;
  }
  if (secretaryRouteOverride.source === 'legacy') {
    logger.warn(
      { legacyKey: 'GEMINI_INCLUDE_SECRETARY', replacementKey: 'SECRETARY_PRIMARY_ROUTE_ENABLED' },
      'Legacy Secretary provider-route environment key is deprecated and will be removed after one release',
    );
  }

  // Env can also narrow the domain set
  const envDomains = getGeminiDomainAllowlist();
  if (envDomains.length > 0) {
    _geminiDomains = new Set(envDomains);
  }

  _domainProviderExperimentOverrides = normalizeDomainProviderOverrides(getDomainProviderExperimentOverrides());

  // kv_store overrides env (persistent user preferences win)
  try {
    const { getDb } = require('./database');
    const db = getDb();
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_routing_enabled'").get() as { value: string } | undefined;
    if (row) _geminiRoutingEnabled = row.value === 'true';

    const secretaryRouteRow = db.prepare("SELECT value FROM kv_store WHERE key = 'secretary_primary_route_enabled'").get() as { value: string } | undefined;
    if (secretaryRouteRow) {
      _secretaryPrimaryRouteEnabled = secretaryRouteRow.value === 'true';
    } else {
      const legacySecretaryRouteRow = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_include_secretary'").get() as { value: string } | undefined;
      if (legacySecretaryRouteRow) {
        _secretaryPrimaryRouteEnabled = legacySecretaryRouteRow.value === 'true';
        logger.warn(
          { legacyKey: 'gemini_include_secretary', replacementKey: 'secretary_primary_route_enabled' },
          'Legacy Secretary provider-route setting was read and is deprecated after one release',
        );
      }
    }

    const domainsRow = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_domains'").get() as { value: string } | undefined;
    if (domainsRow && domainsRow.value) {
      _geminiDomains = new Set(domainsRow.value.split(',').map(d => d.trim()).filter(Boolean));
    }
  } catch { /* kv_store not available — use env/code defaults */ }

  logger.info({
    geminiRoutingEnabled: _geminiRoutingEnabled,
    secretaryPrimaryRouteEnabled: _secretaryPrimaryRouteEnabled,
    geminiDomains: [..._geminiDomains],
    domainProviderExperimentOverrides: Object.fromEntries(_domainProviderExperimentOverrides),
  }, 'Domain provider routing initialized');
}

/** Toggle Gemini routing at runtime (persists to kv_store) */
export function setGeminiRoutingEnabled(enabled: boolean): void {
  _geminiRoutingEnabled = enabled;
  try {
    const { getDb } = require('./database');
    getDb().prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('gemini_routing_enabled', ?)").run(String(enabled));
  } catch {}
  logger.info({ enabled }, 'Gemini routing toggled');
}

/** Set which domains use Gemini (persists to kv_store) */
export function setGeminiDomains(domains: string[]): void {
  _geminiDomains = new Set(domains);
  try {
    const { getDb } = require('./database');
    getDb().prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('gemini_domains', ?)").run(domains.join(','));
  } catch {}
  logger.info({ domains }, 'Gemini domains updated');
}

/** Toggle Secretary's provider-neutral primary route (persists only the new key). */
export function setSecretaryPrimaryRouteEnabled(enabled: boolean): void {
  _secretaryPrimaryRouteEnabled = enabled;
  try {
    const { getDb } = require('./database');
    getDb().prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('secretary_primary_route_enabled', ?)").run(String(enabled));
  } catch {}
  logger.info({ enabled }, 'Secretary primary provider route toggled');
}

export function isSecretaryPrimaryRouteEnabled(): boolean {
  return _secretaryPrimaryRouteEnabled;
}

/** @deprecated One-release API alias; writes only the provider-neutral key. */
export function setGeminiIncludeSecretary(enabled: boolean): void {
  setSecretaryPrimaryRouteEnabled(enabled);
}

/** @deprecated One-release API alias. */
export function isGeminiIncludeSecretaryEnabled(): boolean {
  return isSecretaryPrimaryRouteEnabled();
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Get the primary AI provider for a domain.
 *
 * Non-secretary domains are Gemini-first. The Anthropic escape hatches are:
 *   1. GEMINI_ROUTING_ENABLED=false    — global kill-switch
 *   2. SECRETARY_PRIMARY_ROUTE_ENABLED=false — secretary-only kill-switch
 * Anthropic is only reachable via runtime overrides, not as the resting-state default.
 */
export function getProviderForDomain(domain: DomainName): ProviderName {
  // Secretary routes to OpenAI (GPT-5.4 nano) by default and is deliberately
  // independent from the Gemini kill-switch. Coupling it to that switch would
  // make the provider-neutral Secretary control misleading and could force a
  // healthy OpenAI route onto a disabled Anthropic runtime.
  // When the provider-neutral primary-route safeguard is false, Secretary
  // falls back to Anthropic as an emergency escape hatch.
  if (domain === 'secretary') {
    if (!_secretaryPrimaryRouteEnabled) return 'anthropic';
    const experimentOverride = _domainProviderExperimentOverrides.get(domain);
    if (experimentOverride) return experimentOverride;
    return DOMAIN_PROVIDER_MAP.secretary;
  }

  // Gemini kill-switch — Gemini-backed domains fall back to Anthropic as the
  // explicit emergency route (e.g. Gemini key expiry or quota exhaustion).
  if (!_geminiRoutingEnabled) return 'anthropic';

  const experimentOverride = _domainProviderExperimentOverrides.get(domain);
  if (experimentOverride) return experimentOverride;

  // Per-domain allow-list — populated from DEFAULT_GEMINI_DOMAINS on init
  // and overridable via kv_store. Any domain NOT in the set falls back
  // to Anthropic (this is how the operator can roll Gemini out gradually).
  if (_geminiDomains.size > 0 && !_geminiDomains.has(domain)) return 'anthropic';

  return DOMAIN_PROVIDER_MAP[domain] || 'anthropic';
}

export function hasDomainProviderRoute(domain: DomainName): boolean {
  return Object.prototype.hasOwnProperty.call(DOMAIN_PROVIDER_MAP, domain);
}

/**
 * Get the fallback provider for a domain.
 */
export function getFallbackForDomain(domain: DomainName): ProviderName {
  return DOMAIN_FALLBACK_MAP[domain] || 'anthropic';
}

function normalizeDomainProviderOverrides(raw: Record<string, string>): Map<string, ProviderName> {
  const validDomains = new Set(['secretary', 'triathlon', 'content', 'finance', 'cooking']);
  const validProviders = new Set<ProviderName>(['anthropic', 'openai', 'gemini', 'ollama']);
  // Phase K (2026-05-26, Operator A2): Nexus Hub OllamaProvider v1 does
  // not support safe local tool orchestration yet. Qwen/Ollama may emit
  // tool calls via the `tools` parameter, but Nexus Hub must keep
  // tool-requiring domains on the cloud/tool path until v2 implements
  // schema validation, argument validation, max tool turns, dry-run
  // / write-confirmation rules, and tool-result continuation. Secretary
  // needs calendar/email/tasks tools; triathlon needs training-plans +
  // calendar. Routing these to Ollama would break user-facing flows.
  // Drop such overrides with a warn so a misconfigured .env is visible
  // in logs but doesn't take down the bot.
  const toolRequiringDomains = new Set(['secretary', 'triathlon']);
  const normalized = new Map<string, ProviderName>();
  for (const [domain, provider] of Object.entries(raw)) {
    if (!validDomains.has(domain)) {
      logger.warn({ domain, provider }, 'Dropped invalid AI_DOMAIN_PROVIDER_OVERRIDES entry: unknown domain');
      continue;
    }
    if (!validProviders.has(provider as ProviderName)) {
      logger.warn({ domain, provider }, 'Dropped invalid AI_DOMAIN_PROVIDER_OVERRIDES entry: unknown provider');
      continue;
    }
    if (provider === 'ollama' && toolRequiringDomains.has(domain)) {
      logger.warn(
        { domain, provider },
        'Dropped AI_DOMAIN_PROVIDER_OVERRIDES: Nexus Hub OllamaProvider v1 does not support safe local tool orchestration for tool-requiring domains. Falling back to default cloud routing.',
      );
      continue;
    }
    normalized.set(domain, provider as ProviderName);
  }
  return normalized;
}

/**
 * Get the full domain→provider config (for portal display).
 *
 * Returns one row per domain with the resolved primary provider, fallback
 * provider, default provider (what the code says it should be), and a flag
 * indicating whether Gemini is currently the active primary for that domain. The portal
 * uses this to render the routing table and the per-domain toggles.
 */
export function getDomainProviderConfig(): Array<{
  domain: string;
  provider: ProviderName;
  fallback: ProviderName;
  defaultProvider: ProviderName;
  geminiEnabled: boolean;
  isSecretary: boolean;
}> {
  const domains = ['secretary', 'triathlon', 'content', 'finance', 'cooking'];
  return domains.map(domain => {
    const isSecretary = domain === 'secretary';
    const resolvedProvider = getProviderForDomain(domain as DomainName);
    const geminiEnabled = resolvedProvider === 'gemini';
    return {
      domain,
      provider: resolvedProvider,
      fallback: getFallbackForDomain(domain as DomainName),
      defaultProvider: DOMAIN_PROVIDER_MAP[domain] || 'anthropic',
      geminiEnabled,
      isSecretary,
    };
  });
}

/** Check if Gemini routing is currently enabled */
export function isGeminiRoutingEnabled(): boolean {
  return _geminiRoutingEnabled;
}

// ─── Secretary Haiku Sub-Routing (Phase 2 Optimization) ─────────────

/**
 * Simple secretary queries that can use Haiku ($1/$5) instead of Sonnet ($3/$15).
 * These are lookups/commands that don't require complex reasoning.
 */
const SIMPLE_SECRETARY_PATTERNS = [
  /^\/(agenda|schedule|day|week|tomorrow)$/i,
  /^\/(done|undone|complete)\b/i,
  /^\/(email|unread|inbox)\b/i,
  /^\/(lists|tasks|todosummary)\b/i,
  /^\/(overdue|duetoday|dueweek)\b/i,
  /^\/(status|version)\b/i,
];

let _secretaryHaikuEnabled = isSecretaryHaikuRoutingEnabled();

/**
 * Check if a secretary message is a simple query that can use Haiku.
 * Behind feature flag SECRETARY_HAIKU_ROUTING_ENABLED (default: false).
 */
export function isSimpleSecretaryQuery(message: string): boolean {
  if (!_secretaryHaikuEnabled) return false;
  return SIMPLE_SECRETARY_PATTERNS.some(p => p.test(message.trim()));
}

/**
 * Get the secretary model tier for a message.
 * Returns 'simple' for Haiku-eligible queries, 'complex' for Sonnet.
 */
export function getSecretaryTier(message: string): 'simple' | 'complex' {
  return isSimpleSecretaryQuery(message) ? 'simple' : 'complex';
}

/** Toggle secretary Haiku routing */
export function setSecretaryHaikuEnabled(enabled: boolean): void {
  _secretaryHaikuEnabled = enabled;
  logger.info({ enabled }, 'Secretary Haiku sub-routing toggled');
}
