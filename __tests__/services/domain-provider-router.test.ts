// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProviderForDomain,
  getFallbackForDomain,
  getDomainProviderConfig,
} from '../../src/services/domain-provider-router';

describe('Domain Provider Router', () => {
  describe('getProviderForDomain', () => {
    // April 2026 revision — no Claude models as primary ANYWHERE.
    // Every domain (including secretary, which previously used Sonnet for
    // Secretary routes to OpenAI (GPT-5.4 nano — best tool-calling at lowest cost).
    // Other domains route to Gemini Flash. Anthropic stays as last-resort fallback.
    it('secretary routes to openai, others to gemini', () => {
      expect(getProviderForDomain('secretary')).toBe('openai');
      expect(getProviderForDomain('triathlon')).toBe('gemini');
      expect(getProviderForDomain('content')).toBe('gemini');
      expect(getProviderForDomain('finance')).toBe('gemini');
      expect(getProviderForDomain('cooking')).toBe('gemini');
    });
  });

  describe('getFallbackForDomain', () => {
    // Secretary falls back to Gemini (cheaper than Anthropic) since its
    // primary is now OpenAI. Other domains fall back to Anthropic.
    it('secretary falls back to gemini, others to anthropic', () => {
      expect(getFallbackForDomain('secretary')).toBe('gemini');
      expect(getFallbackForDomain('triathlon')).toBe('anthropic');
      expect(getFallbackForDomain('content')).toBe('anthropic');
      expect(getFallbackForDomain('finance')).toBe('anthropic');
      expect(getFallbackForDomain('cooking')).toBe('anthropic');
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
});
