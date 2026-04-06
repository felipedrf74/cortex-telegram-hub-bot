// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProviderForDomain,
  getFallbackForDomain,
  getDomainProviderConfig,
} from '../../src/services/domain-provider-router';

describe('Domain Provider Router', () => {
  describe('getProviderForDomain', () => {
    it('secretary always routes to anthropic', () => {
      expect(getProviderForDomain('secretary')).toBe('anthropic');
    });

    // Gemini routing is ENABLED by default as of v4.9.13 — the cost-optimized
    // path: secretary stays on Claude (tool-use quality), non-secretary domains
    // move to Gemini (6x cheaper). The provider-fallback layer gracefully
    // degrades to anthropic if GEMINI_API_KEY isn't set.
    it('non-secretary domains default to gemini (enabled by default)', () => {
      expect(getProviderForDomain('triathlon')).toBe('gemini');
      expect(getProviderForDomain('content')).toBe('gemini');
      expect(getProviderForDomain('finance')).toBe('gemini');
      expect(getProviderForDomain('cooking')).toBe('gemini');
    });
  });

  describe('getFallbackForDomain', () => {
    it('secretary fallback is openai', () => {
      expect(getFallbackForDomain('secretary')).toBe('openai');
    });

    it('non-secretary fallback is anthropic', () => {
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
