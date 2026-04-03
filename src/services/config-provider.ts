// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * ConfigProvider — Per-tenant configuration abstraction.
 *
 * Decouples config consumers from the config source. Currently backed by
 * environment variables (single-tenant), but the interface supports
 * per-tenant overrides for future multi-tenant expansion.
 *
 * Usage:
 *   const provider = getConfigProvider();
 *   const cfg = provider.resolve('default');
 *   // cfg.anthropic.apiKey, cfg.app.timezone, etc.
 */

import { config } from '../config';

// ─── Tenant Config Shape ──────────────────────────────────────────

/** The full config type, mirroring the existing `config` export. */
export type AppConfig = typeof config;

/**
 * A partial overlay that a tenant can use to override specific
 * sections of the global config (e.g., different AI models, timezone).
 */
export type TenantOverrides = {
  [K in keyof AppConfig]?: Partial<AppConfig[K]>;
};

/** Identifies a tenant — maps to a Telegram user ID or a logical name. */
export type TenantId = string | number;

// ─── Provider Interface ───────────────────────────────────────────

export interface ConfigProvider {
  /** Provider identifier (e.g., 'env', 'database', 'composite'). */
  readonly name: string;

  /**
   * Resolve the full configuration for a given tenant.
   * Returns the global config merged with any tenant-specific overrides.
   * If no overrides exist, returns the global config unmodified.
   */
  resolve(tenantId: TenantId): Readonly<AppConfig>;

  /**
   * Retrieve only the tenant-specific overrides (without the global base).
   * Returns null if no overrides are registered for this tenant.
   */
  getOverrides(tenantId: TenantId): TenantOverrides | null;

  /**
   * Register overrides for a tenant. Merges shallowly per config section.
   * Returns true if overrides were set, false if the provider is read-only.
   */
  setOverrides(tenantId: TenantId, overrides: TenantOverrides): boolean;

  /**
   * Remove all overrides for a tenant, reverting them to global defaults.
   * Returns true if overrides existed and were removed.
   */
  clearOverrides(tenantId: TenantId): boolean;

  /** List all tenant IDs that have registered overrides. */
  tenantIds(): TenantId[];
}

// ─── EnvConfigProvider (single-tenant, env-var backed) ────────────

/**
 * Default provider: wraps the existing env-based `config` object.
 * Supports in-memory per-tenant overrides layered on top of the
 * global config. Overrides are non-persistent (lost on restart) —
 * a future DatabaseConfigProvider can persist them.
 */
export class EnvConfigProvider implements ConfigProvider {
  readonly name = 'env';
  private readonly overrides = new Map<string, TenantOverrides>();

  resolve(tenantId: TenantId): Readonly<AppConfig> {
    const key = String(tenantId);
    const tenantOverrides = this.overrides.get(key);
    if (!tenantOverrides) return config;
    return mergeConfig(config, tenantOverrides);
  }

  getOverrides(tenantId: TenantId): TenantOverrides | null {
    return this.overrides.get(String(tenantId)) ?? null;
  }

  setOverrides(tenantId: TenantId, overrides: TenantOverrides): boolean {
    const key = String(tenantId);
    const existing = this.overrides.get(key);
    this.overrides.set(key, existing ? mergeOverrides(existing, overrides) : overrides);
    return true;
  }

  clearOverrides(tenantId: TenantId): boolean {
    return this.overrides.delete(String(tenantId));
  }

  tenantIds(): TenantId[] {
    return [...this.overrides.keys()];
  }
}

// ─── Merge Utilities ──────────────────────────────────────────────

/** Shallow-merge each config section with the corresponding override. */
function mergeConfig(base: AppConfig, overrides: TenantOverrides): AppConfig {
  const result = { ...base } as Record<string, any>;
  for (const [section, values] of Object.entries(overrides)) {
    if (values && typeof values === 'object' && section in base) {
      result[section] = { ...(base as any)[section], ...values };
    }
  }
  return result as AppConfig;
}

/** Merge two override objects, with `incoming` taking precedence. */
function mergeOverrides(existing: TenantOverrides, incoming: TenantOverrides): TenantOverrides {
  const result = { ...existing } as Record<string, any>;
  for (const [section, values] of Object.entries(incoming)) {
    if (values && typeof values === 'object') {
      result[section] = { ...(result[section] || {}), ...values };
    }
  }
  return result as TenantOverrides;
}

// ─── Singleton ────────────────────────────────────────────────────

let instance: ConfigProvider | null = null;

/** Get the global ConfigProvider instance (creates EnvConfigProvider on first call). */
export function getConfigProvider(): ConfigProvider {
  if (!instance) {
    instance = new EnvConfigProvider();
  }
  return instance;
}

/** Replace the global ConfigProvider (useful for testing or switching backends). */
export function setConfigProvider(provider: ConfigProvider): void {
  instance = provider;
}

/** Reset to default (for tests). */
export function resetConfigProvider(): void {
  instance = null;
}
