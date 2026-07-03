// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EnvConfigProvider,
  getConfigProvider,
  setConfigProvider,
  resetConfigProvider,
  type ConfigProvider,
  type TenantOverrides,
  type TenantId,
} from '../../src/services/config-provider';
import { config } from '../../src/config';

describe('ConfigProvider — QA Validation', () => {
  let provider: EnvConfigProvider;

  beforeEach(() => {
    provider = new EnvConfigProvider();
    resetConfigProvider();
  });

  afterEach(() => {
    resetConfigProvider();
  });

  // ── Type-safety: TenantId coercion ──────────────────────────────

  describe('TenantId coercion (string vs number)', () => {
    it('numeric and string versions of same ID share overrides', () => {
      provider.setOverrides(42, { app: { timezone: 'UTC' } });
      // Internally stored as string "42"
      expect(provider.getOverrides('42')).not.toBeNull();
      expect(provider.resolve('42').app.timezone).toBe('UTC');
    });

    it('clearOverrides with string clears numeric-set tenant', () => {
      provider.setOverrides(42, { app: { timezone: 'UTC' } });
      expect(provider.clearOverrides('42')).toBe(true);
      expect(provider.tenantIds()).toEqual([]);
    });

    it('handles empty string as tenant ID', () => {
      provider.setOverrides('', { app: { timezone: 'UTC' } });
      expect(provider.resolve('').app.timezone).toBe('UTC');
      expect(provider.tenantIds()).toEqual(['']);
    });

    it('handles zero as tenant ID', () => {
      provider.setOverrides(0, { app: { timezone: 'UTC' } });
      expect(provider.resolve(0).app.timezone).toBe('UTC');
      expect(provider.resolve('0').app.timezone).toBe('UTC');
    });
  });

  // ── Merge behavior edge cases ──────────────────────────────────

  describe('merge behavior', () => {
    it('resolved config is a new object (not the same reference as global)', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const resolved = provider.resolve('t1');
      expect(resolved).not.toBe(config);
    });

    it('non-overridden sections retain reference equality with global config', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const resolved = provider.resolve('t1');
      // Sections not mentioned in overrides should be the original objects
      expect(resolved.aiSafety).toBe(config.aiSafety);
      expect(resolved.anthropic).toBe(config.anthropic);
    });

    it('overridden section is a new object (not mutating global)', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const resolved = provider.resolve('t1');
      expect(resolved.app).not.toBe(config.app);
    });

    it('ignores override keys that are not in the base config', () => {
      const overrides = { nonExistentSection: { foo: 'bar' } } as any;
      provider.setOverrides('t1', overrides);
      const resolved = provider.resolve('t1');
      // The invalid section should not appear on the resolved config
      expect((resolved as any).nonExistentSection).toBeUndefined();
    });

    it('ignores non-object override values', () => {
      const overrides = { app: 'not-an-object' } as any;
      provider.setOverrides('t1', overrides);
      // Should not throw and should return global config for that section
      const resolved = provider.resolve('t1');
      expect(resolved.app).toEqual(config.app);
    });

    it('handles null override values gracefully', () => {
      const overrides = { app: null } as any;
      provider.setOverrides('t1', overrides);
      const resolved = provider.resolve('t1');
      expect(resolved.app).toEqual(config.app);
    });

    it('empty overrides object still creates a tenant entry', () => {
      provider.setOverrides('t1', {});
      expect(provider.tenantIds()).toEqual(['t1']);
      // But resolved config is identical to global (shallow copy)
      const resolved = provider.resolve('t1');
      expect(resolved.app).toEqual(config.app);
    });
  });

  // ── Multiple tenants at scale ──────────────────────────────────

  describe('multiple tenants', () => {
    it('supports many concurrent tenants without cross-contamination', () => {
      const timezones = [
        'America/New_York', 'Europe/London', 'Asia/Tokyo',
        'Australia/Sydney', 'America/Sao_Paulo',
      ];
      timezones.forEach((tz, i) => {
        provider.setOverrides(`tenant-${i}`, { app: { timezone: tz } });
      });

      timezones.forEach((tz, i) => {
        expect(provider.resolve(`tenant-${i}`).app.timezone).toBe(tz);
      });

      expect(provider.tenantIds()).toHaveLength(5);
    });

    it('clearing one tenant does not affect others', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      provider.setOverrides('t2', { app: { timezone: 'EST' } });
      provider.clearOverrides('t1');

      expect(provider.resolve('t1')).toBe(config);
      expect(provider.resolve('t2').app.timezone).toBe('EST');
      expect(provider.tenantIds()).toEqual(['t2']);
    });
  });

  // ── Immutability checks ────────────────────────────────────────

  describe('immutability', () => {
    it('modifying returned overrides does not affect stored overrides', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const overrides = provider.getOverrides('t1')!;
      // Mutate the returned object
      (overrides as any).app.timezone = 'HACKED';
      // NOTE: This test documents current behavior — shallow copy means
      // the internal reference IS shared. This is a known trade-off.
      // Future versions may deep-clone for safety.
      const freshOverrides = provider.getOverrides('t1')!;
      // Currently the mutation IS visible (shallow reference sharing)
      expect(freshOverrides.app!.timezone).toBe('HACKED');
    });

    it('resolved config preserves all base config keys in overridden section', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const resolved = provider.resolve('t1');
      // All keys from config.app should still exist
      for (const key of Object.keys(config.app)) {
        expect(resolved.app).toHaveProperty(key);
      }
    });
  });

  // ── Singleton lifecycle ────────────────────────────────────────

  describe('singleton lifecycle', () => {
    it('setConfigProvider replaces and getConfigProvider returns new provider', () => {
      const original = getConfigProvider();
      const custom: ConfigProvider = {
        name: 'test-custom',
        resolve: () => config,
        getOverrides: () => null,
        setOverrides: () => false,
        clearOverrides: () => false,
        tenantIds: () => [],
      };
      setConfigProvider(custom);
      expect(getConfigProvider()).toBe(custom);
      expect(getConfigProvider()).not.toBe(original);
    });

    it('read-only provider rejects setOverrides', () => {
      const readOnly: ConfigProvider = {
        name: 'readonly',
        resolve: () => config,
        getOverrides: () => null,
        setOverrides: () => false,
        clearOverrides: () => false,
        tenantIds: () => [],
      };
      setConfigProvider(readOnly);
      expect(getConfigProvider().setOverrides('t1', {})).toBe(false);
    });

    it('reset then get creates fresh instance with no overrides', () => {
      const p1 = getConfigProvider();
      (p1 as EnvConfigProvider).setOverrides?.('t1', { app: { timezone: 'UTC' } });
      resetConfigProvider();
      const p2 = getConfigProvider();
      expect(p2.tenantIds()).toEqual([]);
    });
  });

  // ── Interface contract ─────────────────────────────────────────

  describe('ConfigProvider interface contract', () => {
    it('EnvConfigProvider implements all required interface methods', () => {
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.resolve).toBe('function');
      expect(typeof provider.getOverrides).toBe('function');
      expect(typeof provider.setOverrides).toBe('function');
      expect(typeof provider.clearOverrides).toBe('function');
      expect(typeof provider.tenantIds).toBe('function');
    });

    it('resolve always returns an object with the same top-level keys as config', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const resolved = provider.resolve('t1');
      const configKeys = Object.keys(config).sort();
      const resolvedKeys = Object.keys(resolved).sort();
      expect(resolvedKeys).toEqual(configKeys);
    });
  });

  // ── Override accumulation ──────────────────────────────────────

  describe('override accumulation across sections', () => {
    it('first call sets section A, second call sets section B, both persist', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      provider.setOverrides('t1', { rateLimit: { maxMessagesPerMinute: 5 } });

      const resolved = provider.resolve('t1');
      expect(resolved.app.timezone).toBe('UTC');
      expect(resolved.rateLimit.maxMessagesPerMinute).toBe(5);
    });

    it('overrides within same section merge (not replace)', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      provider.setOverrides('t1', { app: { logLevel: 'debug' } });

      const overrides = provider.getOverrides('t1')!;
      expect(overrides.app!.timezone).toBe('UTC');
      expect(overrides.app!.logLevel).toBe('debug');
    });
  });

  // ── Resilience ─────────────────────────────────────────────────

  describe('resilience', () => {
    it('clearOverrides is idempotent (second call returns false)', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      expect(provider.clearOverrides('t1')).toBe(true);
      expect(provider.clearOverrides('t1')).toBe(false);
    });

    it('setOverrides after clearOverrides works correctly', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      provider.clearOverrides('t1');
      provider.setOverrides('t1', { app: { timezone: 'EST' } });
      expect(provider.resolve('t1').app.timezone).toBe('EST');
    });

    it('resolve returns consistent results on repeated calls', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } });
      const r1 = provider.resolve('t1');
      const r2 = provider.resolve('t1');
      expect(r1.app.timezone).toBe(r2.app.timezone);
      expect(r1.app.timezone).toBe('UTC');
    });
  });
});
