// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Model Configuration — runtime-swappable AI model selection.
 *
 * Two layers of override:
 *   1. Provider-level: `chat` and `classifier` roles override config.ts defaults
 *      (e.g., swap ALL chat calls from Sonnet to Opus)
 *   2. Domain-level: per-domain overrides for fine-grained cost control
 *      (e.g., keep secretary on Sonnet but move triathlon to Haiku)
 *
 * Resolution order for a domain call:
 *   getDomainModelOverride('anthropic', 'triathlon')  ← domain override
 *   → getActiveModel('anthropic', 'chat'/'classifier') ← provider-level override
 *   → config.anthropic.model / classifierModel         ← env / hardcoded default
 *
 * Usage:
 *   // Provider-level (affects all domains on that tier)
 *   setActiveModel('anthropic', 'chat', 'claude-opus-4-6')
 *
 *   // Domain-level (affects only this domain, overrides tier)
 *   setDomainModel('anthropic', 'secretary', 'claude-opus-4-6')
 *   setDomainModel('anthropic', 'triathlon', 'claude-haiku-4-5-20251001')
 */

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'gemini';
export type ModelRole = 'chat' | 'classifier';
export type DomainModelRole = 'secretary' | 'triathlon' | 'content' | 'finance' | 'cooking';

/** All valid roles: provider-level + domain-level */
export type AnyModelRole = ModelRole | DomainModelRole;

export const VALID_ROLES: AnyModelRole[] = [
  'chat', 'classifier',
  'secretary', 'triathlon', 'content', 'finance', 'cooking',
];

export const DOMAIN_ROLES: DomainModelRole[] = [
  'secretary', 'triathlon', 'content', 'finance', 'cooking',
];

export interface ProviderModelState {
  provider: ProviderName;
  chat: { model: string; source: 'override' | 'default' };
  classifier: { model: string; source: 'override' | 'default' };
  domains: Record<DomainModelRole, { model: string; source: 'override' | 'tier-default' }>;
}

// ─── In-memory cache ────────────────────────────────────────────────

const overrides = new Map<string, string>();

function cacheKey(provider: ProviderName, role: AnyModelRole): string {
  return `${provider}:${role}`;
}

// ─── Default models from config ─────────────────────────────────────

const DEFAULTS: Record<string, string> = {};

function captureDefaults(): void {
  for (const provider of ['anthropic', 'openai', 'gemini'] as ProviderName[]) {
    const cfg = config[provider] as { model?: string; classifierModel?: string } | undefined;
    if (cfg) {
      DEFAULTS[cacheKey(provider, 'chat')] = cfg.model || 'unknown';
      DEFAULTS[cacheKey(provider, 'classifier')] = cfg.classifierModel || 'unknown';
    }
  }
}
captureDefaults();

function getDefaultModel(provider: ProviderName, role: ModelRole): string {
  return DEFAULTS[cacheKey(provider, role)] || 'unknown';
}

/**
 * Determine the default tier for a domain (what getModelRouting uses).
 * secretary → 'chat' (expensive), everything else → 'classifier' (cheap)
 */
function domainDefaultTier(domain: DomainModelRole): ModelRole {
  return domain === 'secretary' ? 'chat' : 'classifier';
}

// ─── Provider-Level API ─────────────────────────────────────────────

/**
 * Get the currently active model for a provider + role (chat/classifier).
 * Returns the override if set, otherwise the default from config.ts.
 */
export function getActiveModel(provider: ProviderName, role: ModelRole): string {
  const key = cacheKey(provider, role);
  return overrides.get(key) ?? getDefaultModel(provider, role);
}

/**
 * Set a provider-level model override. Affects all domains on that tier.
 */
export function setActiveModel(provider: ProviderName, role: AnyModelRole, model: string): void {
  const key = cacheKey(provider, role);
  overrides.set(key, model);

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(`model_override:${key}`, JSON.stringify(model));
  } catch (err) {
    logger.warn({ err, provider, role, model }, 'Failed to persist model override');
  }

  // Patch live config for provider-level roles (chat/classifier)
  if (role === 'chat' || role === 'classifier') {
    patchConfig(provider, role, model);
  }

  logger.info({ provider, role, model }, 'Model override applied');
}

/**
 * Remove an override, reverting to the default.
 */
export function clearModelOverride(provider: ProviderName, role: AnyModelRole): void {
  const key = cacheKey(provider, role);
  overrides.delete(key);

  try {
    const db = getDb();
    db.prepare('DELETE FROM kv_store WHERE key = ?').run(`model_override:${key}`);
  } catch (err) {
    logger.warn({ err }, 'Failed to clear model override from DB');
  }

  // Revert config for provider-level roles
  if (role === 'chat' || role === 'classifier') {
    patchConfig(provider, role, getDefaultModel(provider, role));
  }

  logger.info({ provider, role }, 'Model override cleared');
}

// ─── Domain-Level API ───────────────────────────────────────────────

/**
 * Set a domain-specific model override.
 * This takes precedence over the provider-level tier for this domain only.
 */
export function setDomainModel(provider: ProviderName, domain: DomainModelRole, model: string): void {
  setActiveModel(provider, domain, model);
}

/**
 * Clear a domain-specific model override.
 * The domain reverts to using whatever its tier (chat/classifier) resolves to.
 */
export function clearDomainModel(provider: ProviderName, domain: DomainModelRole): void {
  clearModelOverride(provider, domain);
}

/**
 * Get the effective model for a specific domain.
 *
 * Resolution order:
 *   1. Domain-specific override (e.g., anthropic:secretary → claude-opus-4-6)
 *   2. Provider-tier override (e.g., anthropic:chat → claude-sonnet-4-7)
 *   3. Config default (e.g., config.anthropic.model → claude-sonnet-4-6)
 */
export function getDomainModelOverride(provider: ProviderName, domain: DomainModelRole): string | undefined {
  const key = cacheKey(provider, domain);
  return overrides.get(key);
}

/**
 * Get the effective model for a domain, falling through all resolution layers.
 */
export function getEffectiveDomainModel(provider: ProviderName, domain: DomainModelRole): string {
  // 1. Domain-specific override
  const domainOverride = getDomainModelOverride(provider, domain);
  if (domainOverride) return domainOverride;

  // 2. Provider-tier (chat for secretary, classifier for everything else)
  const tier = domainDefaultTier(domain);
  return getActiveModel(provider, tier);
}

// ─── Startup Loading ────────────────────────────────────────────────

/**
 * Load all persisted overrides from kv_store into memory.
 * Call once at startup, after database init.
 */
export function loadModelOverrides(): void {
  try {
    const db = getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const rows = db.prepare(
      "SELECT key, value FROM kv_store WHERE key LIKE 'model_override:%'"
    ).all() as { key: string; value: string }[];

    for (const row of rows) {
      const suffix = row.key.replace('model_override:', '');
      const parts = suffix.split(':');
      const provider = parts[0] as ProviderName;
      const role = parts[1] as AnyModelRole;
      const model = JSON.parse(row.value);

      overrides.set(suffix, model);

      if (role === 'chat' || role === 'classifier') {
        patchConfig(provider, role, model);
      }

      logger.info({ provider, role, model }, 'Loaded model override from DB');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load model overrides — using defaults');
  }
}

// ─── Portal State ───────────────────────────────────────────────────

/**
 * Get the full model state for all providers (for portal display).
 * Includes both provider-level and domain-level states.
 */
export function getAllModelStates(): ProviderModelState[] {
  const providers: ProviderName[] = ['anthropic', 'openai', 'gemini'];
  return providers.map(provider => {
    const domains: Record<DomainModelRole, { model: string; source: 'override' | 'tier-default' }> = {} as any;
    for (const domain of DOMAIN_ROLES) {
      const domainOverride = getDomainModelOverride(provider, domain);
      domains[domain] = {
        model: getEffectiveDomainModel(provider, domain),
        source: domainOverride ? 'override' : 'tier-default',
      };
    }

    return {
      provider,
      chat: {
        model: getActiveModel(provider, 'chat'),
        source: overrides.has(cacheKey(provider, 'chat')) ? 'override' as const : 'default' as const,
      },
      classifier: {
        model: getActiveModel(provider, 'classifier'),
        source: overrides.has(cacheKey(provider, 'classifier')) ? 'override' as const : 'default' as const,
      },
      domains,
    };
  });
}

/**
 * Known model options per provider (for portal dropdown population).
 */
export const MODEL_OPTIONS: Record<ProviderName, { chat: string[]; classifier: string[] }> = {
  anthropic: {
    chat: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    classifier: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
  },
  openai: {
    chat: ['gpt-5', 'gpt-5-mini', 'gpt-5.4', 'gpt-4.1-mini', 'o4-mini'],
    classifier: ['gpt-5-nano', 'gpt-5-mini', 'gpt-4.1-nano'],
  },
  gemini: {
    chat: ['gemini-3-flash', 'gemini-2.5-flash', 'gemini-3.1-pro'],
    classifier: ['gemini-2.5-flash-lite', 'gemini-3-flash'],
  },
};

// ─── Internal helpers ───────────────────────────────────────────────

/** Reset overrides cache (for tests). */
export function _resetOverrides(): void {
  overrides.clear();
}

function patchConfig(provider: ProviderName, role: ModelRole, model: string): void {
  const cfg = config[provider] as Record<string, unknown> | undefined;
  if (cfg) {
    if (role === 'chat') cfg.model = model;
    else cfg.classifierModel = model;
  }
}
