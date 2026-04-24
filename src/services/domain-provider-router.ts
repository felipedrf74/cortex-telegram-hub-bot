// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Domain Provider Router — determines which AI provider handles each domain.
 *
 * Strategy (April 2026 revision — mixed primary routing):
 *   - secretary → OpenAI GPT-5.4 nano (best low-cost tool-use path)
 *   - triathlon → Gemini 3 Flash
 *   - content  → Gemini 3 Flash
 *   - finance  → Gemini 3 Flash
 *   - cooking  → Gemini 3 Flash
 *
 * Anthropic is fallback-only — if the primary provider errors the
 * provider-fallback layer transparently degrades to Anthropic Haiku so the
 * user never sees a hard failure.
 *
 * Cost rationale (per MTK):
 *   Gemini 3 Flash: $0.50 / $3  — primary for non-secretary domains
 *   GPT-5.4 nano:   $0.20 / $1.25 — primary for secretary
 *   Haiku 4.5:      $1.00 / $5  — fallback across every domain
 *   Sonnet 4.6:     $3.00 / $15 — not used in this router
 *
 * Feature flag: GEMINI_ROUTING_ENABLED is a kill-switch for the Gemini-backed
 * domains. When explicitly set to 'false' they route back to Anthropic as an
 * emergency escape hatch. Secretary remains OpenAI unless its own override is disabled.
 */

import type { DomainName } from '../domains/types';
import type { ProviderName } from './model-config';
import { logger } from '../utils/logger';
import {
  getGeminiDomainAllowlist,
  getGeminiIncludeSecretaryEnvOverride,
  getGeminiRoutingEnvOverride,
  isSecretaryHaikuRoutingEnabled,
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
// circuit breaker. Anthropic's Haiku is cheap, reliable, and has strong
// tool-use — a good last line of defense for EVERY domain (including
// secretary, which previously used OpenAI as a backup).
const DOMAIN_FALLBACK_MAP: Record<string, ProviderName> = {
  secretary:  'gemini',      // Gemini Flash as OpenAI fallback (cheaper than Anthropic)
  triathlon:  'anthropic',
  content:    'anthropic',
  finance:    'anthropic',
  cooking:    'anthropic',
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

// Historical toggle — now repurposed as the secretary primary-provider
// safeguard. When true (default), secretary stays on OpenAI. When false,
// secretary degrades straight to Anthropic as an emergency escape hatch.
let _geminiIncludeSecretary = true;

/** Initialize from environment or kv_store */
export function initDomainRouting(): void {
  _geminiRoutingEnabled = true;
  _geminiDomains = new Set(DEFAULT_GEMINI_DOMAINS);
  _geminiIncludeSecretary = true;
  _secretaryHaikuEnabled = isSecretaryHaikuRoutingEnabled();

  const routingOverride = getGeminiRoutingEnvOverride();
  if (routingOverride !== null) {
    _geminiRoutingEnabled = routingOverride;
  }

  // Env override for the secretary primary-provider safeguard
  const includeSecretaryOverride = getGeminiIncludeSecretaryEnvOverride();
  if (includeSecretaryOverride !== null) {
    _geminiIncludeSecretary = includeSecretaryOverride;
  }

  // Env can also narrow the domain set
  const envDomains = getGeminiDomainAllowlist();
  if (envDomains.length > 0) {
    _geminiDomains = new Set(envDomains);
  }

  // kv_store overrides env (persistent user preferences win)
  try {
    const { getDb } = require('./database');
    const db = getDb();
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_routing_enabled'").get() as { value: string } | undefined;
    if (row) _geminiRoutingEnabled = row.value === 'true';

    const includeSecRow = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_include_secretary'").get() as { value: string } | undefined;
    if (includeSecRow) _geminiIncludeSecretary = includeSecRow.value === 'true';

    const domainsRow = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_domains'").get() as { value: string } | undefined;
    if (domainsRow && domainsRow.value) {
      _geminiDomains = new Set(domainsRow.value.split(',').map(d => d.trim()).filter(Boolean));
    }
  } catch { /* kv_store not available — use env/code defaults */ }

  logger.info({
    geminiRoutingEnabled: _geminiRoutingEnabled,
    geminiIncludeSecretary: _geminiIncludeSecretary,
    geminiDomains: [..._geminiDomains],
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

/** Toggle whether secretary also routes through Gemini (persists to kv_store) */
export function setGeminiIncludeSecretary(enabled: boolean): void {
  _geminiIncludeSecretary = enabled;
  try {
    const { getDb } = require('./database');
    getDb().prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('gemini_include_secretary', ?)").run(String(enabled));
  } catch {}
  logger.info({ enabled }, 'Gemini include-secretary toggled');
}

/** Whether the secretary domain currently routes through Gemini */
export function isGeminiIncludeSecretaryEnabled(): boolean {
  return _geminiIncludeSecretary;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Get the primary AI provider for a domain.
 *
 * Non-secretary domains are Gemini-first. The Anthropic escape hatches are:
 *   1. GEMINI_ROUTING_ENABLED=false    — global kill-switch
 *   2. GEMINI_INCLUDE_SECRETARY=false  — secretary-only kill-switch
 * Anthropic is only reachable via runtime overrides, not as the resting-state default.
 */
export function getProviderForDomain(domain: DomainName): ProviderName {
  // Global kill-switch — if Gemini routing is disabled entirely, fall
  // back to Anthropic for every domain. This is the emergency escape
  // hatch (e.g. GEMINI_API_KEY expired, Gemini quota exhausted).
  if (!_geminiRoutingEnabled) return 'anthropic';

  // Secretary routes to OpenAI (GPT-5.4 nano) by default.
  // The _geminiIncludeSecretary toggle is repurposed: when false, secretary
  // falls back to Anthropic (emergency escape). When true (default), it
  // uses the DOMAIN_PROVIDER_MAP value (openai).
  if (domain === 'secretary') {
    return _geminiIncludeSecretary ? DOMAIN_PROVIDER_MAP.secretary : 'anthropic';
  }

  // Per-domain allow-list — populated from DEFAULT_GEMINI_DOMAINS on init
  // and overridable via kv_store. Any domain NOT in the set falls back
  // to Anthropic (this is how the operator can roll Gemini out gradually).
  if (_geminiDomains.size > 0 && !_geminiDomains.has(domain)) return 'anthropic';

  return DOMAIN_PROVIDER_MAP[domain] || 'anthropic';
}

/**
 * Get the fallback provider for a domain.
 */
export function getFallbackForDomain(domain: DomainName): ProviderName {
  return DOMAIN_FALLBACK_MAP[domain] || 'anthropic';
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
