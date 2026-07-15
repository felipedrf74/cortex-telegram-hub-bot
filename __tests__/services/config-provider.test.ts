// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EnvConfigProvider,
  getConfigProvider,
  setConfigProvider,
  resetConfigProvider,
  type ConfigProvider,
  type TenantOverrides,
} from '../../src/services/config-provider';
import { config } from '../../src/config';

describe('ConfigProvider', () => {
  let provider: EnvConfigProvider;

  beforeEach(() => {
    provider = new EnvConfigProvider();
  });

  afterEach(() => {
    resetConfigProvider();
  });

  // ── EnvConfigProvider basics ─────────────────────────────────────

  describe('EnvConfigProvider', () => {
    it('has name "env"', () => {
      expect(provider.name).toBe('env');
    });

    it('resolve() returns global config when no overrides set', () => {
      const resolved = provider.resolve('default');
      expect(resolved).toBe(config); // exact same reference — no copy overhead
    });

    it('resolve() returns global config for unknown tenant', () => {
      const resolved = provider.resolve(999999);
      expect(resolved).toBe(config);
    });

    it('getOverrides() returns null for unknown tenant', () => {
      expect(provider.getOverrides('unknown')).toBeNull();
    });

    it('tenantIds() is empty initially', () => {
      expect(provider.tenantIds()).toEqual([]);
    });
  });

  // ── Per-tenant overrides ────────────────────────────────────────

  describe('overrides', () => {
    it('setOverrides() registers overrides for a tenant', () => {
      const overrides: TenantOverrides = {
        app: { timezone: 'America/New_York' },
      };
      const result = provider.setOverrides('tenant-1', overrides);
      expect(result).toBe(true);
      expect(provider.tenantIds()).toEqual(['tenant-1']);
    });

    it('resolve() merges overrides with global config', () => {
      provider.setOverrides('tenant-1', {
        app: { timezone: 'America/New_York' },
      });
      const resolved = provider.resolve('tenant-1');
      expect(resolved.app.timezone).toBe('America/New_York');
      // Non-overridden values stay the same
      expect(resolved.app.databasePath).toBe(config.app.databasePath);
      expect(resolved.app.logLevel).toBe(config.app.logLevel);
    });

    it('resolve() does not mutate global config', () => {
      const originalTz = config.app.timezone;
      provider.setOverrides('tenant-1', {
        app: { timezone: 'Asia/Tokyo' },
      });
      provider.resolve('tenant-1');
      expect(config.app.timezone).toBe(originalTz);
    });

    it('overrides do not affect other tenants', () => {
      provider.setOverrides('tenant-1', {
        app: { timezone: 'America/New_York' },
      });
      provider.setOverrides('tenant-2', {
        app: { timezone: 'Asia/Tokyo' },
      });

      expect(provider.resolve('tenant-1').app.timezone).toBe('America/New_York');
      expect(provider.resolve('tenant-2').app.timezone).toBe('Asia/Tokyo');
      expect(provider.resolve('tenant-3')).toBe(config); // no overrides
    });

    it('setOverrides() merges with existing overrides for same tenant', () => {
      provider.setOverrides('tenant-1', {
        app: { timezone: 'America/New_York' },
      });
      provider.setOverrides('tenant-1', {
        app: { logLevel: 'debug' },
      });

      const resolved = provider.resolve('tenant-1');
      expect(resolved.app.timezone).toBe('America/New_York');
      expect(resolved.app.logLevel).toBe('debug');
    });

    it('setOverrides() later values take precedence', () => {
      provider.setOverrides('tenant-1', {
        app: { timezone: 'America/New_York' },
      });
      provider.setOverrides('tenant-1', {
        app: { timezone: 'Europe/Berlin' },
      });

      expect(provider.resolve('tenant-1').app.timezone).toBe('Europe/Berlin');
    });

    it('getOverrides() returns stored overrides', () => {
      const overrides: TenantOverrides = {
        app: { timezone: 'America/New_York' },
      };
      provider.setOverrides('tenant-1', overrides);

      const stored = provider.getOverrides('tenant-1');
      expect(stored).not.toBeNull();
      expect(stored!.app).toEqual({ timezone: 'America/New_York' });
    });

    it('numeric tenant IDs work (Telegram user IDs)', () => {
      provider.setOverrides(123456789, {
        app: { timezone: 'America/Sao_Paulo' },
      });

      expect(provider.resolve(123456789).app.timezone).toBe('America/Sao_Paulo');
      expect(provider.resolve('123456789').app.timezone).toBe('America/Sao_Paulo');
      expect(provider.getOverrides('123456789')).not.toBeNull();
      expect(provider.clearOverrides('123456789')).toBe(true);
      expect(provider.resolve(123456789)).toBe(config);
    });
  });

  // ── clearOverrides ──────────────────────────────────────────────

  describe('clearOverrides()', () => {
    it('removes overrides and reverts tenant to global config', () => {
      provider.setOverrides('tenant-1', {
        app: { timezone: 'America/New_York' },
      });
      expect(provider.resolve('tenant-1').app.timezone).toBe('America/New_York');

      const cleared = provider.clearOverrides('tenant-1');
      expect(cleared).toBe(true);
      expect(provider.resolve('tenant-1')).toBe(config);
      expect(provider.tenantIds()).toEqual([]);
    });

    it('returns false when clearing non-existent tenant', () => {
      expect(provider.clearOverrides('ghost')).toBe(false);
    });
  });

  // ── Multiple config sections ────────────────────────────────────

  describe('multi-section overrides', () => {
    it('can override multiple sections at once', () => {
      provider.setOverrides('tenant-1', {
        app: { timezone: 'America/New_York' },
        rateLimit: { maxMessagesPerMinute: 10 },
      });

      const resolved = provider.resolve('tenant-1');
      expect(resolved.app.timezone).toBe('America/New_York');
      expect(resolved.rateLimit.maxMessagesPerMinute).toBe(10);
      // Unchanged sections stay the same
      expect(resolved.aiSafety).toEqual(config.aiSafety);
    });

    it('ignores unknown, null, and scalar override sections', () => {
      const malformedOverrides = [
        { unknownSection: { enabled: true } },
        { app: null },
        { app: 'not-an-object' },
      ];

      malformedOverrides.forEach((overrides, index) => {
        const tenantId = `malformed-${index}`;
        provider.setOverrides(tenantId, overrides as any);
        const resolved = provider.resolve(tenantId);
        expect(Object.keys(resolved).sort()).toEqual(Object.keys(config).sort());
        expect(resolved.app).toEqual(config.app);
        expect((resolved as any).unknownSection).toBeUndefined();
      });
    });
  });

  // ── Singleton management ────────────────────────────────────────

  describe('singleton', () => {
    it('getConfigProvider() returns a DatabaseConfigProvider by default', () => {
      const p = getConfigProvider();
      expect(p.name).toBe('database');
    });

    it('getConfigProvider() returns the same instance on repeated calls', () => {
      const p1 = getConfigProvider();
      const p2 = getConfigProvider();
      expect(p1).toBe(p2);
    });

    it('setConfigProvider() replaces the singleton', () => {
      const custom: ConfigProvider = {
        name: 'custom',
        resolve: () => config,
        getOverrides: () => null,
        setOverrides: () => false,
        clearOverrides: () => false,
        tenantIds: () => [],
      };
      setConfigProvider(custom);
      expect(getConfigProvider()).toBe(custom);
      expect(getConfigProvider().name).toBe('custom');
    });

    it('resetConfigProvider() clears the singleton', () => {
      const p1 = getConfigProvider();
      resetConfigProvider();
      const p2 = getConfigProvider();
      expect(p1).not.toBe(p2); // new instance
    });
  });
});

// DatabaseConfigProvider tests are in config-provider-db.test.ts (needs separate vi.mock scope)
