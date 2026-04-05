// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Domain Provider Router — determines which AI provider handles each domain.
 *
 * Strategy:
 *   - secretary → Claude Sonnet 4.6 (tool-use reliability, complex multi-step reasoning)
 *   - triathlon → Gemini 3 Flash (cheaper, good at structured data + calendar tools)
 *   - content  → Gemini 3 Flash (cheaper, creative tasks work well on Gemini)
 *   - finance  → Gemini 3 Flash (cheaper, calculation + formatting)
 *   - cooking  → Gemini 3 Flash (cheapest option for simple Q&A)
 *
 * Cost rationale:
 *   Claude Sonnet 4.6: $3/$15 per MTK — only for secretary (justified by tool-use quality)
 *   Gemini 3 Flash:    $0.50/$3 per MTK — 6x cheaper for non-secretary domains
 *   Haiku 4.5:         $1/$5 per MTK — fallback when Gemini is down
 *
 * Feature flag: GEMINI_ROUTING_ENABLED controls whether non-secretary domains
 * actually use Gemini. When false, everything stays on Anthropic (safe default).
 */

import type { DomainName } from '../domains/types';
import type { ProviderName } from './model-config';
import { logger } from '../utils/logger';

// ─── Domain → Provider Mapping ──────────────────────────────────────

const DOMAIN_PROVIDER_MAP: Record<string, ProviderName> = {
  secretary:  'anthropic',
  triathlon:  'gemini',
  content:    'gemini',
  finance:    'gemini',
  cooking:    'gemini',
};

const DOMAIN_FALLBACK_MAP: Record<string, ProviderName> = {
  secretary:  'openai',      // GPT-5 Mini as Claude fallback
  triathlon:  'anthropic',   // Haiku 4.5 as Gemini fallback
  content:    'anthropic',
  finance:    'anthropic',
  cooking:    'anthropic',
};

// ─── Feature Flag ───────────────────────────────────────────────────

let _geminiRoutingEnabled = false;
let _geminiDomains = new Set<string>();

/** Initialize from environment or kv_store */
export function initDomainRouting(): void {
  _geminiRoutingEnabled = process.env.GEMINI_ROUTING_ENABLED === 'true';

  const domainsStr = process.env.GEMINI_DOMAINS || '';
  _geminiDomains = new Set(domainsStr.split(',').map(d => d.trim()).filter(Boolean));

  // Try loading from kv_store (persists across restarts)
  try {
    const { getDb } = require('./database');
    const db = getDb();
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_routing_enabled'").get() as { value: string } | undefined;
    if (row) _geminiRoutingEnabled = row.value === 'true';

    const domainsRow = db.prepare("SELECT value FROM kv_store WHERE key = 'gemini_domains'").get() as { value: string } | undefined;
    if (domainsRow && domainsRow.value) {
      _geminiDomains = new Set(domainsRow.value.split(',').map(d => d.trim()).filter(Boolean));
    }
  } catch { /* kv_store not available — use env defaults */ }

  logger.info({
    geminiRoutingEnabled: _geminiRoutingEnabled,
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

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Get the primary AI provider for a domain.
 * Respects the feature flag — if Gemini routing is disabled, returns 'anthropic' for all.
 */
export function getProviderForDomain(domain: DomainName): ProviderName {
  // Secretary ALWAYS stays on Anthropic
  if (domain === 'secretary') return 'anthropic';

  // Check feature flag
  if (!_geminiRoutingEnabled) return 'anthropic';

  // Check per-domain flag (gradual rollout)
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
 */
export function getDomainProviderConfig(): Array<{
  domain: string;
  provider: ProviderName;
  fallback: ProviderName;
  geminiEnabled: boolean;
}> {
  const domains = ['secretary', 'triathlon', 'content', 'finance', 'cooking'];
  return domains.map(domain => ({
    domain,
    provider: getProviderForDomain(domain as DomainName),
    fallback: getFallbackForDomain(domain as DomainName),
    geminiEnabled: _geminiRoutingEnabled && (_geminiDomains.size === 0 || _geminiDomains.has(domain)),
  }));
}

/** Check if Gemini routing is currently enabled */
export function isGeminiRoutingEnabled(): boolean {
  return _geminiRoutingEnabled;
}
