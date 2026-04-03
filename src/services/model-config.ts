// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Model Configuration — runtime-swappable AI model selection.
 *
 * Allows changing which models each provider uses without restarting the bot.
 * Overrides are stored in the kv_store table and loaded on startup.
 * Falls back to config.ts defaults when no override exists.
 *
 * Usage:
 *   getActiveModel('anthropic', 'chat')       → 'claude-sonnet-4-6'
 *   setActiveModel('anthropic', 'chat', 'claude-sonnet-4-7')
 *   clearModelOverride('anthropic', 'chat')   → reverts to config.ts default
 */

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'gemini';
export type ModelRole = 'chat' | 'classifier';

export interface ModelOverride {
  provider: ProviderName;
  role: ModelRole;
  model: string;
  updatedAt: string;
}

export interface ProviderModelState {
  provider: ProviderName;
  chat: { model: string; source: 'override' | 'default' };
  classifier: { model: string; source: 'override' | 'default' };
}

// ─── In-memory cache ────────────────────────────────────────────────

const overrides = new Map<string, string>();

function cacheKey(provider: ProviderName, role: ModelRole): string {
  return `${provider}:${role}`;
}

// ─── Default models from config ─────────────────────────────────────

// Snapshot defaults at module load time (before any runtime mutation)
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

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Get the currently active model for a provider + role.
 * Returns the override if set, otherwise the default from config.ts.
 */
export function getActiveModel(provider: ProviderName, role: ModelRole): string {
  const key = cacheKey(provider, role);
  return overrides.get(key) ?? getDefaultModel(provider, role);
}

/**
 * Set a model override. Persists to kv_store and updates the in-memory cache.
 * Also patches config.ts values so all existing code picks up the change.
 */
export function setActiveModel(provider: ProviderName, role: ModelRole, model: string): void {
  const key = cacheKey(provider, role);
  overrides.set(key, model);

  // Persist to DB
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

  // Patch the live config object so existing provider code picks up the change
  patchConfig(provider, role, model);
  logger.info({ provider, role, model }, 'Model override applied');
}

/**
 * Remove an override, reverting to the default from config.ts/env.
 */
export function clearModelOverride(provider: ProviderName, role: ModelRole): void {
  const key = cacheKey(provider, role);
  const defaultModel = getDefaultModel(provider, role);
  overrides.delete(key);

  try {
    const db = getDb();
    db.prepare('DELETE FROM kv_store WHERE key = ?').run(`model_override:${key}`);
  } catch (err) {
    logger.warn({ err }, 'Failed to clear model override from DB');
  }

  patchConfig(provider, role, defaultModel);
  logger.info({ provider, role, revertedTo: defaultModel }, 'Model override cleared');
}

/**
 * Load all persisted overrides from kv_store into memory.
 * Call once at startup, after database init.
 */
export function loadModelOverrides(): void {
  try {
    const db = getDb();

    // Ensure kv_store table exists
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
      const [provider, role] = suffix.split(':') as [ProviderName, ModelRole];
      const model = JSON.parse(row.value);

      overrides.set(suffix, model);
      patchConfig(provider, role, model);
      logger.info({ provider, role, model }, 'Loaded model override from DB');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load model overrides — using defaults');
  }
}

/**
 * Get the full model state for all providers (for portal display).
 */
export function getAllModelStates(): ProviderModelState[] {
  const providers: ProviderName[] = ['anthropic', 'openai', 'gemini'];
  return providers.map(provider => ({
    provider,
    chat: {
      model: getActiveModel(provider, 'chat'),
      source: overrides.has(cacheKey(provider, 'chat')) ? 'override' as const : 'default' as const,
    },
    classifier: {
      model: getActiveModel(provider, 'classifier'),
      source: overrides.has(cacheKey(provider, 'classifier')) ? 'override' as const : 'default' as const,
    },
  }));
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
    chat: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini'],
    classifier: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  },
  gemini: {
    chat: ['gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17', 'gemini-2.5-pro-preview-03-25', 'gemini-1.5-pro'],
    classifier: ['gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17'],
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
