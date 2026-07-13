// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => undefined,
      run: vi.fn(),
    }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  getProviderForDomain,
  getFallbackForDomain,
  getDomainProviderConfig,
  hasDomainProviderRoute,
  initDomainRouting,
  isSimpleSecretaryQuery,
} from '../../src/services/domain-provider-router';
import { logger } from '../../src/utils/logger';

describe('Domain Provider Router', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GEMINI_ROUTING_ENABLED;
    delete process.env.GEMINI_INCLUDE_SECRETARY;
    delete process.env.GEMINI_DOMAINS;
    delete process.env.AI_DOMAIN_PROVIDER_OVERRIDES;
    delete process.env.SECRETARY_HAIKU_ROUTING_ENABLED;
    initDomainRouting();
  });

  describe('getProviderForDomain', () => {
    // April/May 2026 revision — no Claude models as primary by default.
    // Secretary routes to OpenAI (GPT-5.4 nano). Other domains route to
    // Gemini Flash and use OpenAI as the normal cross-provider fallback.
    it('secretary routes to openai, others to gemini', () => {
      expect(getProviderForDomain('secretary')).toBe('openai');
      expect(getProviderForDomain('triathlon')).toBe('gemini');
      expect(getProviderForDomain('content')).toBe('gemini');
      expect(getProviderForDomain('finance')).toBe('gemini');
      expect(getProviderForDomain('cooking')).toBe('gemini');
    });

    it('re-applies env overrides without leaking prior in-memory state', () => {
      process.env.GEMINI_ROUTING_ENABLED = 'false';
      process.env.GEMINI_INCLUDE_SECRETARY = 'false';
      initDomainRouting();

      expect(getProviderForDomain('triathlon')).toBe('anthropic');
      expect(getProviderForDomain('secretary')).toBe('anthropic');

      delete process.env.GEMINI_ROUTING_ENABLED;
      delete process.env.GEMINI_INCLUDE_SECRETARY;
      initDomainRouting();

      expect(getProviderForDomain('triathlon')).toBe('gemini');
      expect(getProviderForDomain('secretary')).toBe('openai');
    });

    it('lets env narrow the gemini domain allowlist', () => {
      process.env.GEMINI_DOMAINS = 'content';
      initDomainRouting();

      expect(getProviderForDomain('content')).toBe('gemini');
      expect(getProviderForDomain('finance')).toBe('anthropic');
    });

    it('supports domain-level provider experiment overrides without changing global chat defaults', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);
      process.env.AI_DOMAIN_PROVIDER_OVERRIDES = 'cooking=openai,finance=openai,unknown=gemini,content=bogus';
      initDomainRouting();

      expect(getProviderForDomain('cooking')).toBe('openai');
      expect(getProviderForDomain('finance')).toBe('openai');
      expect(getProviderForDomain('content')).toBe('gemini');
      expect(getProviderForDomain('triathlon')).toBe('gemini');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'unknown', provider: 'gemini' }),
        expect.stringContaining('unknown domain'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'content', provider: 'bogus' }),
        expect.stringContaining('unknown provider'),
      );
      warnSpy.mockRestore();
    });

    it('keeps the Gemini kill switch stronger than experiment overrides', () => {
      process.env.GEMINI_ROUTING_ENABLED = 'false';
      process.env.AI_DOMAIN_PROVIDER_OVERRIDES = 'cooking=openai';
      initDomainRouting();

      expect(getProviderForDomain('cooking')).toBe('anthropic');
    });

    it('identifies only domains with executable domain-provider routes', () => {
      expect(hasDomainProviderRoute('secretary')).toBe(true);
      expect(hasDomainProviderRoute('cooking')).toBe(true);
      expect(hasDomainProviderRoute('chat')).toBe(false);
      expect(hasDomainProviderRoute('dynamic_custom_skill')).toBe(false);
    });
  });

  describe('getFallbackForDomain', () => {
    // Secretary falls back to Gemini since its primary is OpenAI. Other
    // domains fall back to OpenAI so Anthropic-gated deployments still
    // have a usable cross-provider fallback.
    it('secretary falls back to gemini, others to openai', () => {
      expect(getFallbackForDomain('secretary')).toBe('gemini');
      expect(getFallbackForDomain('triathlon')).toBe('openai');
      expect(getFallbackForDomain('content')).toBe('openai');
      expect(getFallbackForDomain('finance')).toBe('openai');
      expect(getFallbackForDomain('cooking')).toBe('openai');
    });
  });

  describe('getDomainProviderConfig', () => {
    it('returns config for all 5 domains', () => {
      const config = getDomainProviderConfig();
      expect(config).toHaveLength(5);
      const domains = config.map(c => c.domain);
      expect(domains).toContain('secretary');
      expect(domains).toContain('triathlon');
      expect(domains).toContain('content');
      expect(domains).toContain('finance');
      expect(domains).toContain('cooking');
    });

    it('each config entry has required fields', () => {
      const config = getDomainProviderConfig();
      for (const entry of config) {
        expect(entry).toHaveProperty('domain');
        expect(entry).toHaveProperty('provider');
        expect(entry).toHaveProperty('fallback');
        expect(entry).toHaveProperty('geminiEnabled');
      }
    });
  });

  describe('isSimpleSecretaryQuery', () => {
    it('only enables the simple secretary fastpath when explicitly opted in', () => {
      expect(isSimpleSecretaryQuery('/agenda')).toBe(false);

      process.env.SECRETARY_HAIKU_ROUTING_ENABLED = 'true';
      initDomainRouting();

      expect(isSimpleSecretaryQuery('/agenda')).toBe(true);
      expect(isSimpleSecretaryQuery('write me a full weekly plan')).toBe(false);
    });
  });
});
