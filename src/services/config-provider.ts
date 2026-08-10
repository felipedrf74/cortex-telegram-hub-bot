// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * ConfigProvider — Per-tenant configuration abstraction.
 *
 * Two implementations:
 *   - EnvConfigProvider: in-memory overrides (original, non-persistent)
 *   - DatabaseConfigProvider: SQLite-backed overrides via kv_store (persistent)
 *
 * Override chain (DatabaseConfigProvider):
 *   env var → DB override (kv_store) → hardcoded default
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { isRetiredSpanishLocaleSignal } from '../utils/i18n';

// ─── Tenant Config Shape ──────────────────────────────────────────

export type AppConfig = typeof config;

export type TenantOverrides = {
  [K in keyof AppConfig]?: Partial<AppConfig[K]>;
};

export type TenantId = string | number;

// ─── Provider Interface ───────────────────────────────────────────

export interface ConfigProvider {
  readonly name: string;
  resolve(tenantId: TenantId): Readonly<AppConfig>;
  getOverrides(tenantId: TenantId): TenantOverrides | null;
  setOverrides(tenantId: TenantId, overrides: TenantOverrides): boolean;
  clearOverrides(tenantId: TenantId): boolean;
  tenantIds(): TenantId[];
}

// ─── EnvConfigProvider (original — non-persistent) ──────────────

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

// ─── DatabaseConfigProvider (SQLite-backed, persistent) ──────────

export interface SettingSchema {
  section: string;
  key: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  label: string;
  description: string;
  defaultValue: any;
  envVar?: string;
  options?: string[];
  category: 'general' | 'notifications' | 'skills' | 'ai' | 'limits';
}

export interface SettingState {
  id: string;
  label: string;
  description: string;
  category: string;
  type: string;
  value: any;
  source: 'env' | 'database' | 'default';
  locked: boolean;
  options?: string[];
}

/**
 * Compatibility projection for persisted settings whose historical value is
 * no longer a supported product option. Keep the stored row untouched so
 * operational history remains auditable; only the effective runtime/UI value
 * is projected.
 */
function effectivePersistedSettingValue(
  settingId: string,
  value: unknown,
): unknown {
  if (
    settingId === 'language'
    && isRetiredSpanishLocaleSignal(value)
  ) {
    return 'en-US';
  }
  return value;
}

/**
 * SQLite-backed ConfigProvider with persistent per-tenant overrides.
 * Mutates the live config object on set so existing code picks up changes.
 */
export class DatabaseConfigProvider implements ConfigProvider {
  readonly name = 'database';
  private _getDb: () => any;

  constructor(getDbFn?: () => any) {
    this._getDb = getDbFn || (() => {
      const { getDb } = require('./database');
      return getDb();
    });
  }

  static readonly SETTINGS_SCHEMA: Record<string, SettingSchema> = {
    'timezone': {
      section: 'app', key: 'timezone', type: 'string',
      label: 'Timezone', description: 'IANA timezone for all date/time operations',
      defaultValue: 'Europe/Lisbon', envVar: 'TIMEZONE',
      options: ['Europe/Lisbon', 'Europe/London', 'America/Sao_Paulo', 'America/New_York', 'UTC'],
      category: 'general',
    },
    'language': {
      section: 'app', key: 'language', type: 'string',
      label: 'Language', description: 'Primary language for bot responses',
      defaultValue: 'pt-BR',
      options: ['pt-BR', 'pt-PT', 'en-US'],
      category: 'general',
    },
    'log_level': {
      section: 'app', key: 'logLevel', type: 'string',
      label: 'Log Level', description: 'Logging verbosity',
      defaultValue: 'info', envVar: 'LOG_LEVEL',
      options: ['debug', 'info', 'warn', 'error'],
      category: 'general',
    },
    'briefing_time': {
      section: 'todo', key: 'digestTime', type: 'string',
      label: 'Daily Briefing Time', description: 'When to send the daily briefing (HH:MM)',
      defaultValue: '06:00', envVar: 'TODO_DIGEST_TIME',
      category: 'notifications',
    },
    'briefing_enabled': {
      section: 'todo', key: 'digestEnabled', type: 'boolean',
      label: 'Daily Briefing', description: 'Enable/disable daily briefing notifications',
      defaultValue: true, envVar: 'TODO_DIGEST_ENABLED',
      category: 'notifications',
    },
    'backup_time': {
      section: 'backup', key: 'time', type: 'string',
      label: 'Backup Time', description: 'When to run daily database backup (HH:MM)',
      defaultValue: '03:00', envVar: 'BACKUP_TIME',
      category: 'general',
    },
    'backup_retention_days': {
      section: 'backup', key: 'retentionDays', type: 'number',
      label: 'Backup Retention', description: 'Days to keep old backups',
      defaultValue: 30, envVar: 'BACKUP_RETENTION_DAYS',
      category: 'general',
    },
    'rate_limit_messages_per_day': {
      section: 'app', key: 'rateLimitMessagesPerDay', type: 'number',
      label: 'Daily Message Limit', description: 'Max AI messages per user per day (0 = unlimited)',
      defaultValue: 0,
      category: 'limits',
    },
    'rate_limit_tokens_per_day': {
      section: 'app', key: 'rateLimitTokensPerDay', type: 'number',
      label: 'Daily Token Limit', description: 'Max AI tokens per user per day (0 = unlimited)',
      defaultValue: 0,
      category: 'limits',
    },
    'rate_limit_cost_per_day': {
      section: 'app', key: 'rateLimitCostPerDay', type: 'number',
      label: 'Daily Cost Limit (USD)', description: 'Max AI spend per user per day (0 = unlimited)',
      defaultValue: 0,
      category: 'limits',
    },
  };

  // ── Settings API (the new functionality) ──────────────────────

  getSetting(settingId: string, tenantId: TenantId = 'default'): any {
    const schema = DatabaseConfigProvider.SETTINGS_SCHEMA[settingId];
    if (!schema) return undefined;

    if (schema.envVar && process.env[schema.envVar] !== undefined) {
      return this.castValue(process.env[schema.envVar]!, schema.type);
    }

    try {
      const db = this._getDb();
      const row = db.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).get(`config:${tenantId}:${settingId}`) as { value: string } | undefined;
      if (row) {
        return effectivePersistedSettingValue(settingId, JSON.parse(row.value));
      }
    } catch { /* DB not ready */ }

    return schema.defaultValue;
  }

  setSetting(settingId: string, value: any, tenantId: TenantId = 'default'): void {
    const schema = DatabaseConfigProvider.SETTINGS_SCHEMA[settingId];
    if (!schema) throw new Error(`Unknown setting: ${settingId}`);
    if (settingId === 'language' && schema.options && !schema.options.includes(value)) {
      throw new Error(`Invalid option for setting: ${settingId}`);
    }

    if (schema.envVar && process.env[schema.envVar] !== undefined) {
      logger.warn({ settingId, envVar: schema.envVar },
        'Setting is locked by env var — DB override saved but env var takes priority');
    }

    try {
      const db = this._getDb();
      db.prepare(`
        INSERT INTO kv_store (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(`config:${tenantId}:${settingId}`, JSON.stringify(value));
    } catch (err) {
      logger.warn({ err, settingId }, 'Failed to persist setting');
    }

    this.patchLiveConfig(schema.section, schema.key, value);
    logger.info({ settingId, value, tenantId }, 'Setting updated');
  }

  clearSetting(settingId: string, tenantId: TenantId = 'default'): void {
    const schema = DatabaseConfigProvider.SETTINGS_SCHEMA[settingId];
    if (!schema) return;

    try {
      const db = this._getDb();
      db.prepare('DELETE FROM kv_store WHERE key = ?').run(`config:${tenantId}:${settingId}`);
    } catch { /* best effort */ }

    const revertValue = (schema.envVar && process.env[schema.envVar] !== undefined)
      ? this.castValue(process.env[schema.envVar]!, schema.type)
      : schema.defaultValue;
    this.patchLiveConfig(schema.section, schema.key, revertValue);
    logger.info({ settingId, revertedTo: revertValue, tenantId }, 'Setting cleared');
  }

  getAllSettings(tenantId: TenantId = 'default'): SettingState[] {
    return Object.entries(DatabaseConfigProvider.SETTINGS_SCHEMA).map(([id, schema]) => {
      let value: any;
      let source: 'env' | 'database' | 'default';
      const locked = !!(schema.envVar && process.env[schema.envVar] !== undefined);

      if (locked) {
        value = this.castValue(process.env[schema.envVar!]!, schema.type);
        source = 'env';
      } else {
        try {
          const db = this._getDb();
          const row = db.prepare(
            'SELECT value FROM kv_store WHERE key = ?'
          ).get(`config:${tenantId}:${id}`) as { value: string } | undefined;
          if (row) {
            value = effectivePersistedSettingValue(id, JSON.parse(row.value));
            source = 'database';
          } else {
            value = schema.defaultValue;
            source = 'default';
          }
        } catch {
          value = schema.defaultValue;
          source = 'default';
        }
      }

      return {
        id, label: schema.label, description: schema.description,
        category: schema.category, type: schema.type,
        value, source, locked,
        ...(schema.options ? { options: schema.options } : {}),
      };
    });
  }

  loadPersistedSettings(
    tenantId: TenantId = 'default',
    { ensureStore = true }: { ensureStore?: boolean } = {},
  ): void {
    try {
      const db = this._getDb();

      if (ensureStore) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }

      const prefix = `config:${tenantId}:`;
      const rows = db.prepare(
        'SELECT key, value FROM kv_store WHERE key LIKE ?'
      ).all(`${prefix}%`) as { key: string; value: string }[];

      for (const row of rows) {
        const settingId = row.key.replace(prefix, '');
        const schema = DatabaseConfigProvider.SETTINGS_SCHEMA[settingId];
        if (!schema) continue;
        if (schema.envVar && process.env[schema.envVar] !== undefined) continue;

        const value = effectivePersistedSettingValue(settingId, JSON.parse(row.value));
        this.patchLiveConfig(schema.section, schema.key, value);
      }

      logger.info({ count: rows.length }, 'Loaded persisted settings from DB');
    } catch (err) {
      if (!ensureStore) throw err;
      logger.warn({ err }, 'Failed to load persisted settings — using defaults');
    }
  }

  // ── ConfigProvider interface (multi-tenant) ───────────────────

  private tenantOverrides = new Map<string, TenantOverrides>();

  resolve(tenantId: TenantId): Readonly<AppConfig> {
    const key = String(tenantId);
    const overrides = this.tenantOverrides.get(key);
    if (!overrides) return config;
    return mergeConfig(config, overrides);
  }

  getOverrides(tenantId: TenantId): TenantOverrides | null {
    return this.tenantOverrides.get(String(tenantId)) ?? null;
  }

  setOverrides(tenantId: TenantId, overrides: TenantOverrides): boolean {
    const key = String(tenantId);
    const existing = this.tenantOverrides.get(key);
    this.tenantOverrides.set(key, existing ? mergeOverrides(existing, overrides) : overrides);
    return true;
  }

  clearOverrides(tenantId: TenantId): boolean {
    return this.tenantOverrides.delete(String(tenantId));
  }

  tenantIds(): TenantId[] {
    return [...this.tenantOverrides.keys()];
  }

  // ── Helpers ───────────────────────────────────────────────────

  private castValue(raw: string, type: string): any {
    switch (type) {
      case 'number': return Number(raw);
      case 'boolean': return raw === 'true' || raw === '1';
      case 'json': try { return JSON.parse(raw); } catch { return raw; }
      default: return raw;
    }
  }

  private patchLiveConfig(section: string, key: string, value: any): void {
    const cfg = config as any;
    if (cfg[section]) {
      cfg[section][key] = value;
    }
  }
}

// ─── Merge Utilities ──────────────────────────────────────────────

function mergeConfig(base: AppConfig, overrides: TenantOverrides): AppConfig {
  const result = { ...base } as Record<string, any>;
  for (const [section, values] of Object.entries(overrides)) {
    if (values && typeof values === 'object' && section in base) {
      result[section] = { ...(base as any)[section], ...values };
    }
  }
  return result as AppConfig;
}

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

export function getConfigProvider(): ConfigProvider {
  if (!instance) {
    instance = new DatabaseConfigProvider();
  }
  return instance;
}

export function setConfigProvider(provider: ConfigProvider): void {
  instance = provider;
}

export function resetConfigProvider(): void {
  instance = null;
}
